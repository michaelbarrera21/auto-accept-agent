/**
 * CDP Handler - Main routing and connection management
 * =====================================================
 * Manages Chrome DevTools Protocol connections for Cursor/Antigravity.
 * 
 * ROUTING LOGIC:
 * ==============
 * if (Antigravity) {
 *     if (backgroundMode && Pro && windowUnfocused) {
 *         → antigravityBackgroundPoll()  // Accept + NewChat + Tab cycling
 *     } else {
 *         → acceptPoll()                 // Standard accept clicking
 *     }
 * } else { // Cursor
 *     if (backgroundMode && Pro && windowUnfocused) {
 *         → cursorBackgroundPoll()       // Accept with relaxed visibility
 *     } else {
 *         → acceptPoll()                 // Standard accept clicking
 *     }
 * }
 * 
 * Pro feature: Background operation (continues when unfocused)
 */

let WebSocket;
try {
    WebSocket = require('ws');
} catch (e) {
    console.error(`[CDP] Failed to require 'ws'. Current dir: ${__dirname}`);
    try {
        console.error(`[CDP] node_modules exists? ${require('fs').existsSync(require('path').join(__dirname, '../node_modules'))}`);
        console.error(`[CDP] ws exists? ${require('fs').existsSync(require('path').join(__dirname, '../node_modules/ws'))}`);
    } catch (fsErr) { /* ignore */ }
    throw e;
}

const http = require('http');
const fs = require('fs');
const path = require('path');

const CDP_PORT_START = 9222;
const CDP_PORT_END = 9232;
const LOG_PREFIX = '[CDP]';

// ========================================
// LOAD AND COMPOSE INJECTION SCRIPT
// ========================================

function loadScripts() {
    // Try multiple possible paths for scripts directory
    // When bundled, __dirname might be 'dist' but scripts are in 'main_scripts/scripts'
    const possiblePaths = [
        path.join(__dirname, 'scripts'),                           // Development: main_scripts/scripts
        path.join(__dirname, '..', 'main_scripts', 'scripts'),     // Bundled from dist: ../main_scripts/scripts
        path.join(__dirname, 'main_scripts', 'scripts'),           // Extension root: main_scripts/scripts
    ];

    let scriptsDir = null;
    for (const p of possiblePaths) {
        if (fs.existsSync(p) && fs.existsSync(path.join(p, 'core.js'))) {
            scriptsDir = p;
            console.log(`${LOG_PREFIX} Found scripts at: ${p}`);
            break;
        }
    }

    if (!scriptsDir) {
        console.error(`${LOG_PREFIX} Could not find scripts directory! Tried:`, possiblePaths);
        // Return a minimal script that logs the error
        return `(function() { 
            console.error('[AutoAccept] Scripts not found - path resolution failed');
            window.__autoAcceptCDP = { 
                getIDE: function() { return { name: 'Error', isAntigravity: false, error: 'Scripts not found' }; },
                acceptPoll: function() { return { clicked: false, error: 'Scripts not found' }; },
                cursorBackgroundPoll: function() { return { clicked: false, error: 'Scripts not found' }; },
                antigravityBackgroundPoll: function() { return Promise.resolve({ clicked: false, error: 'Scripts not found' }); },
                isWindowFocused: function() { return document.hasFocus(); },
                checkWindowUnfocused: function() { return !document.hasFocus(); },
                getDiagnostics: function() { return { error: 'Scripts not found' }; }
            };
        })();`;
    }
    const scriptOrder = [
        'core.js',
        'window_focus.js',
        'accept_poll.js',
        'cursor_background.js',
        'conversation_logic.js',
        'antigravity_background.js'
    ];

    let combined = '// Auto-Accept CDP Injection Script (composed)\n';
    combined += '(function() {\n"use strict";\n\n';
    combined += 'var __scriptErrors = [];\n\n';

    for (const scriptName of scriptOrder) {
        const scriptPath = path.join(scriptsDir, scriptName);
        try {
            const content = fs.readFileSync(scriptPath, 'utf8');
            // Wrap each script in try-catch for error visibility
            combined += `// === ${scriptName} ===\n`;
            combined += `try {\n`;
            combined += content + '\n';
            combined += `} catch(e) { __scriptErrors.push({script: "${scriptName}", error: e.message}); console.error("[AutoAccept] Failed to load ${scriptName}:", e); }\n\n`;
        } catch (e) {
            console.error(`${LOG_PREFIX} Failed to load ${scriptName}:`, e.message);
        }
    }

    // Add the main API that cdp-handler.js will call - with safety checks
    combined += `
// === MAIN API ===
window.__autoAcceptCDP = {
    // Get script loading errors
    getScriptErrors: function() {
        return __scriptErrors;
    },
    
    // Get IDE info - with safety check
    getIDE: function() {
        if (!window.__autoAcceptCore || !window.__autoAcceptCore.detectIDE) {
            return { name: 'Unknown', isAntigravity: false, isCursor: false, error: 'Core not loaded' };
        }
        return window.__autoAcceptCore.detectIDE();
    },
    
    // Check window focus - with safety check
    isWindowFocused: function() {
        if (!window.__autoAcceptFocus || !window.__autoAcceptFocus.isWindowFocused) {
            return document.hasFocus(); // Fallback
        }
        return window.__autoAcceptFocus.isWindowFocused();
    },
    
    checkWindowUnfocused: function() {
        if (!window.__autoAcceptFocus || !window.__autoAcceptFocus.checkWindowUnfocused) {
            return !document.hasFocus(); // Fallback
        }
        return window.__autoAcceptFocus.checkWindowUnfocused();
    },
    
    // STANDARD MODE: Accept polling (Cursor + Antigravity foreground)
    acceptPoll: function() {
        if (!window.__autoAcceptCore || !window.__autoAcceptPolling) {
            return { clicked: false, count: 0, error: 'Scripts not loaded: Core=' + !!window.__autoAcceptCore + ' Polling=' + !!window.__autoAcceptPolling };
        }
        try {
            const ide = window.__autoAcceptCore.detectIDE();
            return window.__autoAcceptPolling.acceptPoll(ide);
        } catch(e) {
            return { clicked: false, count: 0, error: e.message };
        }
    },
    
    // CURSOR BACKGROUND: Accept with relaxed visibility
    cursorBackgroundPoll: function() {
        if (!window.__autoAcceptCore || !window.__autoAcceptPolling) {
            return { clicked: false, count: 0, error: 'Scripts not loaded' };
        }
        try {
            const ide = window.__autoAcceptCore.detectIDE();
            return window.__autoAcceptPolling.cursorBackgroundPoll(ide);
        } catch(e) {
            return { clicked: false, count: 0, error: e.message };
        }
    },
    
    // ANTIGRAVITY BACKGROUND: Accept + NewChat + Tab cycling
    antigravityBackgroundPoll: async function(tabIndex, isPro = false) {
        if (!window.__autoAcceptCore || !window.__autoAcceptPolling) {
            return { clicked: false, count: 0, error: 'Scripts not loaded' };
        }
        try {
            const ide = window.__autoAcceptCore.detectIDE();
            return await window.__autoAcceptPolling.antigravityBackgroundPoll(ide, tabIndex, isPro);
        } catch(e) {
            return { clicked: false, count: 0, error: e.message };
        }
    },
    
    // Hide background mode overlay
    hideBackgroundOverlay: function() {
        if (window.__autoAcceptPolling && window.__autoAcceptPolling.hideBackgroundOverlay) {
            window.__autoAcceptPolling.hideBackgroundOverlay();
            return { success: true };
        }
        return { success: false, error: 'Overlay function not found' };
    },
    
    // Diagnostics
    getDiagnostics: function() {
        const result = {
            coreLoaded: !!window.__autoAcceptCore,
            focusLoaded: !!window.__autoAcceptFocus,
            pollingLoaded: !!window.__autoAcceptPolling,
            scriptErrors: __scriptErrors,
            windowFocused: document.hasFocus()
        };
        
        if (window.__autoAcceptCore) {
            try {
                const ide = window.__autoAcceptCore.detectIDE();
                const doc = window.__autoAcceptCore.getDocument(ide);
                result.ide = ide.name;
                result.isAntigravity = ide.isAntigravity;
                result.isCursor = ide.isCursor;
                result.acceptButtons = window.__autoAcceptCore.findAcceptButtons(doc, false).length;
                result.state = window.__autoAcceptCore.state;
            } catch(e) {
                result.error = e.message;
            }
        }
        
        return result;
    }
};

// Log final initialization status
if (__scriptErrors.length > 0) {
    console.error('[AutoAccept] Script loading errors:', __scriptErrors);
} else if (window.__autoAcceptCore) {
    window.__autoAcceptCore.log('CDP script loaded. IDE:', window.__autoAcceptCore.detectIDE().name);
} else {
    console.error('[AutoAccept] Core failed to load!');
}
`;

    combined += '\n})();\n';
    return combined;
}


// Load scripts once at startup
const INJECTION_SCRIPT = loadScripts();

// ========================================
// CDP HANDLER CLASS
// ========================================

class CDPHandler {
    constructor(startPort = CDP_PORT_START, endPort = CDP_PORT_END, logger = null) {
        this.name = 'CDPHandler';
        this.connections = new Map();
        this.messageId = 1;
        this.pendingMessages = new Map();
        this.reconnectTimer = null;
        this.isEnabled = false;
        this.startPort = startPort;
        this.endPort = endPort;
        this.logger = logger || console.log;
        this.isPro = false;
        this.tabIndex = 0; // For Antigravity background tab cycling
    }

    // ========================================
    // LOGGING
    // ========================================

    log(...args) {
        const message = args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ');
        if (this.logger) {
            this.logger(`${LOG_PREFIX} ${message}`);
        }
    }

    setProStatus(isPro) {
        this.isPro = isPro;
        this.log(`Pro status set to ${isPro}`);
    }

    // ========================================
    // INSTANCE DISCOVERY
    // ========================================

    async scanForInstances() {
        const instances = [];

        for (let port = this.startPort; port <= this.endPort; port++) {
            try {
                const pages = await this.getPages(port);
                if (pages && pages.length > 0) {
                    this.log(`Found ${pages.length} pages on port ${port}`);
                    instances.push({ port, pages });
                }
            } catch (e) {
                if (!e.message.includes('ECONNREFUSED')) {
                    this.log(`Scan port ${port} failed: ${e.message}`);
                }
            }
        }

        return instances;
    }

    async getPages(port) {
        return new Promise((resolve, reject) => {
            const req = http.get({
                hostname: '127.0.0.1',
                port,
                path: '/json/list',
                timeout: 1000
            }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const pages = JSON.parse(data);
                        resolve(pages.filter(p => p.webSocketDebuggerUrl));
                    } catch (e) {
                        reject(e);
                    }
                });
            });
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
        });
    }

    async isCDPAvailable() {
        const instances = await this.scanForInstances();
        return instances.length > 0;
    }

    // ========================================
    // CONNECTION MANAGEMENT
    // ========================================

    async start() {
        this.isEnabled = true;
        const connected = await this.discoverAndConnect();

        if (!this.reconnectTimer) {
            this.reconnectTimer = setInterval(() => {
                if (this.isEnabled) {
                    this.discoverAndConnect().catch(() => { });
                }
            }, 10000);
        }

        return connected;
    }

    async stop() {
        this.isEnabled = false;
        if (this.reconnectTimer) {
            clearInterval(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        this.disconnectAll();
    }

    async discoverAndConnect() {
        const instances = await this.scanForInstances();
        let connected = 0;

        for (const instance of instances) {
            // Gating: Non-Pro limited to 1 connection
            if (!this.isPro && this.connections.size >= 1) {
                this.log('Non-Pro limit reached (1 instance)');
                break;
            }

            for (const page of instance.pages) {
                if (!this.connections.has(page.id)) {
                    if (!this.isPro && this.connections.size >= 1) break;
                    const success = await this.connectToPage(page);
                    if (success) connected++;
                }
            }
        }

        return connected > 0 || this.connections.size > 0;
    }

    async connectToPage(page) {
        return new Promise((resolve) => {
            try {
                const ws = new WebSocket(page.webSocketDebuggerUrl);
                let resolved = false;

                ws.on('open', async () => {
                    this.log(`Connected to page ${page.id}`);
                    this.connections.set(page.id, { ws, injected: false });

                    try {
                        await this.injectScript(page.id);
                    } catch (e) { }

                    if (!resolved) { resolved = true; resolve(true); }
                });

                ws.on('message', (data) => {
                    try {
                        const msg = JSON.parse(data.toString());
                        if (msg.id && this.pendingMessages.has(msg.id)) {
                            const { resolve, reject } = this.pendingMessages.get(msg.id);
                            this.pendingMessages.delete(msg.id);
                            msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
                        }
                    } catch (e) { }
                });

                ws.on('error', () => {
                    this.connections.delete(page.id);
                    if (!resolved) { resolved = true; resolve(false); }
                });

                ws.on('close', () => {
                    this.connections.delete(page.id);
                    if (!resolved) { resolved = true; resolve(false); }
                });

                setTimeout(() => {
                    if (!resolved) { resolved = true; resolve(false); }
                }, 5000);

            } catch (e) {
                resolve(false);
            }
        });
    }

    // ========================================
    // CDP COMMAND SENDING
    // ========================================

    async sendCommand(pageId, method, params = {}, timeout = 5000) {
        const conn = this.connections.get(pageId);
        if (!conn || conn.ws.readyState !== WebSocket.OPEN) {
            throw new Error('Not connected');
        }

        const id = this.messageId++;

        return new Promise((resolve, reject) => {
            this.pendingMessages.set(id, { resolve, reject });
            conn.ws.send(JSON.stringify({ id, method, params }));
            setTimeout(() => {
                if (this.pendingMessages.has(id)) {
                    this.pendingMessages.delete(id);
                    reject(new Error('Timeout'));
                }
            }, timeout);
        });
    }

    async injectScript(pageId) {
        await this.sendCommand(pageId, 'Runtime.evaluate', {
            expression: INJECTION_SCRIPT,
            returnByValue: true
        });
        const conn = this.connections.get(pageId);
        if (conn) conn.injected = true;
        this.log(`Script injected into page ${pageId}`);
    }

    // ========================================
    // MAIN ROUTING LOGIC
    // ========================================

    /**
     * Execute accept action with proper routing.
     * 
     * ROUTING:
     *   Antigravity + background + Pro → antigravityBackgroundPoll()
     *   Antigravity + foreground      → acceptPoll()
     *   Cursor + background + Pro     → cursorBackgroundPoll()
     *   Cursor + foreground           → acceptPoll()
     * 
     * @param {boolean} allowBackground - If true, enable background mode (Pro only)
     */
    async executeAccept(allowBackground = false, forceWindowFocused = null) {
        let totalClicked = 0;
        this.log('========================================');
        this.log(`executeAccept START`);
        this.log(`  allowBackground=${allowBackground} | isPro=${this.isPro} | forceWindowFocused=${forceWindowFocused}`);
        this.log(`  connections=${this.connections.size}`);
        this.log('========================================');

        for (const [pageId, conn] of this.connections) {
            this.log(`[Page ${pageId}] ws.readyState=${conn.ws.readyState} (OPEN=${WebSocket.OPEN})`);
            if (conn.ws.readyState !== WebSocket.OPEN) {
                continue; // Skip silently - WebSocket not open
            }

            try {
                // FIRST: Check if this is a valid DOM context (not a service worker)
                const contextCheck = await this.sendCommand(pageId, 'Runtime.evaluate', {
                    expression: `(typeof window !== 'undefined' && typeof document !== 'undefined')`,
                    returnByValue: true
                });

                const isValidContext = contextCheck?.result?.value === true;
                if (!isValidContext) {
                    continue; // Skip silently - service worker or Node context
                }

                // Ensure script is injected
                if (!conn.injected) {
                    this.log(`[Page ${pageId}] Injecting script...`);
                    await this.injectScript(pageId);
                }

                // DIAGNOSTIC: Check if __autoAcceptCDP exists and get page info
                const cdpCheck = await this.sendCommand(pageId, 'Runtime.evaluate', {
                    expression: `JSON.stringify({
                        hasCDP: typeof window.__autoAcceptCDP !== 'undefined',
                        hasCore: typeof window.__autoAcceptCore !== 'undefined',
                        hasFocus: typeof window.__autoAcceptFocus !== 'undefined',
                        hasPolling: typeof window.__autoAcceptPolling !== 'undefined',
                        docTitle: document.title,
                        url: window.location.href,
                        hasAntigravityPanel: !!document.getElementById('antigravity.agentPanel'),
                        hasAntigravityClass: !!document.querySelector('[class*="antigravity"]'),
                        titleIncludesAntigravity: document.title.includes('Antigravity'),
                        titleLower: document.title.toLowerCase(),
                        bodyClasses: document.body ? document.body.className : 'no-body'
                    })`,
                    returnByValue: true
                });
                const diagValue = cdpCheck?.result?.value;
                this.log(`[Page ${pageId}] DIAGNOSTIC: ${diagValue}`);

                // Parse and check if scripts are loaded
                let diag = {};
                try { diag = JSON.parse(diagValue || '{}'); } catch (e) { }

                if (!diag.hasCDP) {
                    this.log(`[Page ${pageId}] WARNING: __autoAcceptCDP not found, scripts may not have loaded`);
                }

                // Get IDE type and focus state
                const ideResult = await this.sendCommand(pageId, 'Runtime.evaluate', {
                    expression: 'window.__autoAcceptCDP ? JSON.stringify(window.__autoAcceptCDP.getIDE()) : null',
                    returnByValue: true
                });
                this.log(`[Page ${pageId}] Raw IDE Result: ${ideResult?.result?.value}`);

                let ide = { name: 'Unknown', isAntigravity: false, isCursor: false };
                try {
                    if (ideResult?.result?.value) {
                        ide = JSON.parse(ideResult.result.value);
                    }
                } catch (e) {
                    this.log(`[Page ${pageId}] Failed to parse IDE result: ${e.message}`);
                }

                // FALLBACK: If IDE detection failed but we have diagnostic data, use that
                if (!ide.isAntigravity && diag.titleIncludesAntigravity) {
                    this.log(`[Page ${pageId}] FALLBACK: Using diagnostic titleIncludesAntigravity=true`);
                    ide.isAntigravity = true;
                    ide.name = 'Antigravity';
                }

                const focusResult = await this.sendCommand(pageId, 'Runtime.evaluate', {
                    expression: `JSON.stringify({
                        hasFocus: document.hasFocus(),
                        visibilityState: document.visibilityState,
                        hidden: document.hidden,
                        autoAcceptFocus: window.__autoAcceptFocus ? window.__autoAcceptFocus.isWindowFocused() : 'N/A'
                    })`,
                    returnByValue: true
                });
                this.log(`[Page ${pageId}] Raw Focus Result: ${focusResult?.result?.value}`);

                let focusData = {};
                try { focusData = JSON.parse(focusResult?.result?.value || '{}'); } catch (e) { }

                const windowFocused = forceWindowFocused !== null
                    ? forceWindowFocused
                    : ((focusData.autoAcceptFocus !== 'N/A' && typeof focusData.autoAcceptFocus === 'boolean')
                        ? focusData.autoAcceptFocus
                        : (focusData.hasFocus ?? true));

                this.log(`[Page ${pageId}] IDE: ${ide.name} | isAntigravity: ${ide.isAntigravity}`);
                this.log(`[Page ${pageId}] WindowFocused: ${windowFocused} | docHasFocus: ${focusData.hasFocus} | hidden: ${focusData.hidden}`);

                // ROUTING DECISION
                // When background mode enabled: use background polling (no focus check - it's broken in Antigravity)
                // When background mode disabled: use foreground polling
                this.log(`[Page ${pageId}] ROUTING FACTORS:`);
                this.log(`  - allowBackground: ${allowBackground}`);
                this.log(`  - isPro: ${this.isPro}`);
                this.log(`  - ide.isAntigravity: ${ide.isAntigravity}`);

                const useBackground = allowBackground && this.isPro;
                this.log(`  - useBackground: ${useBackground}`);

                let expression;
                let mode;

                if (ide.isAntigravity) {
                    if (useBackground) {
                        // Antigravity Background Mode - user explicitly enabled it
                        mode = 'antigravity_background';
                        expression = `window.__autoAcceptCDP.antigravityBackgroundPoll(${this.tabIndex}, ${this.isPro})`;
                        this.tabIndex = (this.tabIndex + 1) % 1000;
                    } else {
                        // Antigravity Foreground Mode
                        mode = 'accept_poll';
                        expression = 'window.__autoAcceptCDP.acceptPoll()';
                    }
                } else {
                    // Cursor (or Unknown)
                    if (useBackground) {
                        // Cursor Background Mode
                        mode = 'cursor_background';
                        expression = 'window.__autoAcceptCDP.cursorBackgroundPoll()';
                    } else {
                        // Cursor Foreground Mode
                        mode = 'accept_poll';
                        expression = 'window.__autoAcceptCDP.acceptPoll()';
                    }
                }

                this.log(`[Page ${pageId}] ROUTING → ${mode}`);
                this.log(`[Page ${pageId}] Expression: ${expression}`);

                // Execute the appropriate polling function
                const result = await this.sendCommand(pageId, 'Runtime.evaluate', {
                    expression,
                    returnByValue: true,
                    awaitPromise: mode === 'antigravity_background' // Only AG background is async
                }, mode === 'antigravity_background' ? 20000 : 5000);

                const pollResult = result?.result?.value || {};
                this.log(`[Page ${pageId}] Poll Result:`, pollResult);

                if (pollResult.clicked) {
                    totalClicked++;
                    this.log(`[Page ${pageId}] ✓ Button clicked!`);
                }

            } catch (e) {
                this.log(`[Page ${pageId}] ERROR: ${e.message}`);
                this.log(`[Page ${pageId}] Stack: ${e.stack}`);
            }
        }

        this.log('========================================');
        this.log(`executeAccept END | totalClicked=${totalClicked}`);
        this.log('========================================');
        return { executed: totalClicked };
    }

    // ========================================
    // OVERLAY CONTROL
    // ========================================

    async hideBackgroundOverlay() {
        this.log('Hiding background overlay on all pages...');
        for (const [pageId, conn] of this.connections) {
            if (conn.ws.readyState !== WebSocket.OPEN) continue;
            try {
                // 1. Try via API (graceful shutdown with state cleanup)
                await this.sendCommand(pageId, 'Runtime.evaluate', {
                    expression: 'if (window.__autoAcceptCDP) window.__autoAcceptCDP.hideBackgroundOverlay()',
                    returnByValue: true
                });

                // 2. FORCE RAW REMOVAL (Fallback)
                // Ensures visual elements are gone even if script state is broken
                await this.sendCommand(pageId, 'Runtime.evaluate', {
                    expression: `(function(){
                        const overlays = document.querySelectorAll('#__autoAcceptBgOverlay');
                        overlays.forEach(el => el.remove());
                        const s = document.getElementById('__autoAcceptBgStyles');
                        if(s) s.remove();
                    })()`,
                    returnByValue: true
                });
            } catch (e) {
                // Ignore errors - overlay might not exist on all pages
            }
        }
    }

    // ========================================
    // UTILITY METHODS
    // ========================================

    async getWindowFocusState() {
        for (const [pageId, conn] of this.connections) {
            if (conn.ws.readyState !== WebSocket.OPEN) continue;
            try {
                if (!conn.injected) await this.injectScript(pageId);
                const result = await this.sendCommand(pageId, 'Runtime.evaluate', {
                    expression: 'window.__autoAcceptCDP.isWindowFocused()',
                    returnByValue: true
                });
                if (result?.result?.value === true) return true;
            } catch (e) {
                this.log(`Focus check failed: ${e.message}`);
            }
        }
        return false;
    }

    async getStuckState(autoAcceptEnabled) {
        for (const [pageId, conn] of this.connections) {
            if (conn.ws.readyState !== WebSocket.OPEN) continue;
            try {
                if (!conn.injected) await this.injectScript(pageId);
                const result = await this.sendCommand(pageId, 'Runtime.evaluate', {
                    expression: `window.__autoAcceptCDP.getDiagnostics()`,
                    returnByValue: true
                });
                const data = result?.result?.value;
                if (data && autoAcceptEnabled) {
                    const elapsed = Date.now() - (data.state?.lastActionTime || Date.now());
                    if (elapsed > 30000 && data.state?.sessionHasAccepted) {
                        return { state: 'stalled', elapsed };
                    }
                }
            } catch (e) { }
        }
        return { state: 'running' };
    }

    getConnectionCount() {
        return this.connections.size;
    }

    disconnectAll() {
        for (const [, conn] of this.connections) {
            try { conn.ws.close(); } catch (e) { }
        }
        this.connections.clear();
    }
}

module.exports = { CDPHandler };
