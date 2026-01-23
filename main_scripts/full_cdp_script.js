/**
 * FULL CDP CORE BUNDLE
 * Monolithic script for browser-side injection.
 * Combines utils, auto-accept, overlay, background polls, and lifecycle management.
 */
(function () {
    "use strict";

    // Guard: Bail out immediately if not in a browser context (e.g., service worker)
    if (typeof window === 'undefined') return;

    // ============================================================
    // ANALYTICS MODULE (Embedded)
    // Clean, modular analytics with separated concerns.
    // See: main_scripts/analytics/ for standalone module files
    // ============================================================
    const Analytics = (function () {
        // --- Constants ---
        const TERMINAL_KEYWORDS = ['run', 'execute', 'command', 'terminal'];
        const SECONDS_PER_CLICK = 5;
        const TIME_VARIANCE = 0.2;

        const ActionType = {
            FILE_EDIT: 'file_edit',
            TERMINAL_COMMAND: 'terminal_command'
        };

        // --- State Management ---
        function createDefaultStats() {
            return {
                clicksThisSession: 0,
                blockedThisSession: 0,
                sessionStartTime: null,
                fileEditsThisSession: 0,
                terminalCommandsThisSession: 0,
                actionsWhileAway: 0,
                isWindowFocused: true,
                lastConversationUrl: null,
                lastConversationStats: null
            };
        }

        function getStats() {
            return window.__autoAcceptState?.stats || createDefaultStats();
        }

        function getStatsMutable() {
            return window.__autoAcceptState.stats;
        }

        // --- Click Tracking ---
        function categorizeClick(buttonText) {
            const text = (buttonText || '').toLowerCase();
            for (const keyword of TERMINAL_KEYWORDS) {
                if (text.includes(keyword)) return ActionType.TERMINAL_COMMAND;
            }
            return ActionType.FILE_EDIT;
        }

        function trackClick(buttonText, log) {
            const stats = getStatsMutable();
            stats.clicksThisSession++;
            log(`[Stats] Click tracked. Total: ${stats.clicksThisSession}`);

            const category = categorizeClick(buttonText);
            if (category === ActionType.TERMINAL_COMMAND) {
                stats.terminalCommandsThisSession++;
                log(`[Stats] Terminal command. Total: ${stats.terminalCommandsThisSession}`);
            } else {
                stats.fileEditsThisSession++;
                log(`[Stats] File edit. Total: ${stats.fileEditsThisSession}`);
            }

            let isAway = false;
            if (!stats.isWindowFocused) {
                stats.actionsWhileAway++;
                isAway = true;
                log(`[Stats] Away action. Total away: ${stats.actionsWhileAway}`);
            }

            return { category, isAway, totalClicks: stats.clicksThisSession };
        }

        function trackBlocked(log) {
            const stats = getStatsMutable();
            stats.blockedThisSession++;
            log(`[Stats] Blocked. Total: ${stats.blockedThisSession}`);
        }

        // --- ROI Reporting ---
        function collectROI(log) {
            const stats = getStatsMutable();
            const collected = {
                clicks: stats.clicksThisSession || 0,
                blocked: stats.blockedThisSession || 0,
                sessionStart: stats.sessionStartTime
            };
            log(`[ROI] Collected: ${collected.clicks} clicks, ${collected.blocked} blocked`);
            stats.clicksThisSession = 0;
            stats.blockedThisSession = 0;
            stats.sessionStartTime = Date.now();
            return collected;
        }

        // --- Session Summary ---
        function getSessionSummary() {
            const stats = getStats();
            const clicks = stats.clicksThisSession || 0;
            const baseSecs = clicks * SECONDS_PER_CLICK;
            const minMins = Math.max(1, Math.floor((baseSecs * (1 - TIME_VARIANCE)) / 60));
            const maxMins = Math.ceil((baseSecs * (1 + TIME_VARIANCE)) / 60);

            return {
                clicks,
                fileEdits: stats.fileEditsThisSession || 0,
                terminalCommands: stats.terminalCommandsThisSession || 0,
                blocked: stats.blockedThisSession || 0,
                estimatedTimeSaved: clicks > 0 ? `${minMins}–${maxMins} minutes` : null
            };
        }

        // --- Away Actions ---
        function consumeAwayActions(log) {
            const stats = getStatsMutable();
            const count = stats.actionsWhileAway || 0;
            log(`[Away] Consuming away actions: ${count}`);
            stats.actionsWhileAway = 0;
            return count;
        }

        function isUserAway() {
            return !getStats().isWindowFocused;
        }

        // --- Focus Management ---
        // NOTE: Browser-side focus events are UNRELIABLE in webview contexts.
        // The VS Code extension pushes the authoritative focus state via __autoAcceptSetFocusState.
        // We only keep a minimal initializer here that defaults to focused=true.

        function initializeFocusState(log) {
            const state = window.__autoAcceptState;
            if (state && state.stats) {
                // Default to focused (assume user is present) - extension will correct this
                state.stats.isWindowFocused = true;
                log('[Focus] Initialized (awaiting extension sync)');
            }
        }

        // --- Initialization ---
        function initialize(log) {
            if (!window.__autoAcceptState) {
                window.__autoAcceptState = {
                    isRunning: false,
                    tabNames: [],
                    completionStatus: {},
                    sessionID: 0,
                    currentMode: null,
                    startTimes: {},
                    bannedCommands: [],
                    isPro: false,
                    stats: createDefaultStats()
                };
                log('[Analytics] State initialized');
            } else if (!window.__autoAcceptState.stats) {
                window.__autoAcceptState.stats = createDefaultStats();
                log('[Analytics] Stats added to existing state');
            } else {
                const s = window.__autoAcceptState.stats;
                if (s.actionsWhileAway === undefined) s.actionsWhileAway = 0;
                if (s.isWindowFocused === undefined) s.isWindowFocused = true;
                if (s.fileEditsThisSession === undefined) s.fileEditsThisSession = 0;
                if (s.terminalCommandsThisSession === undefined) s.terminalCommandsThisSession = 0;
            }

            initializeFocusState(log);

            if (!window.__autoAcceptState.stats.sessionStartTime) {
                window.__autoAcceptState.stats.sessionStartTime = Date.now();
            }

            log('[Analytics] Initialized');
        }

        // Set focus state (called from extension via CDP)
        function setFocusState(isFocused, log) {
            const state = window.__autoAcceptState;
            if (!state || !state.stats) return;

            const wasAway = !state.stats.isWindowFocused;
            state.stats.isWindowFocused = isFocused;

            if (log) {
                log(`[Focus] Extension sync: focused=${isFocused}, wasAway=${wasAway}`);
            }
        }

        // Public API
        return {
            initialize,
            trackClick,
            trackBlocked,
            categorizeClick,
            ActionType,
            collectROI,
            getSessionSummary,
            consumeAwayActions,
            isUserAway,
            getStats,
            setFocusState
        };
    })();

    // --- LOGGING ---
    const log = (msg, isSuccess = false) => {
        // Simple log for CDP interception
        console.log(`[AutoAccept] ${msg}`);
    };

    // Initialize Analytics
    Analytics.initialize(log);

    // --- 1. UTILS ---
    const getDocuments = (root = document) => {
        let docs = [root];
        try {
            const iframes = root.querySelectorAll('iframe, frame');
            for (const iframe of iframes) {
                try {
                    const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
                    if (iframeDoc) docs.push(...getDocuments(iframeDoc));
                } catch (e) { }
            }
        } catch (e) { }
        return docs;
    };

    const queryAll = (selector) => {
        const results = [];
        getDocuments().forEach(doc => {
            try { results.push(...Array.from(doc.querySelectorAll(selector))); } catch (e) { }
        });
        return results;
    };

    // Helper to strip time suffixes like "3m", "4h", "12s"
    const stripTimeSuffix = (text) => {
        return (text || '').trim().replace(/\s*\d+[smh]$/, '').trim();
    };

    // Helper to deduplicate tab names by appending (2), (3), etc.
    const deduplicateNames = (names) => {
        const counts = {};
        return names.map(name => {
            if (counts[name] === undefined) {
                counts[name] = 1;
                return name;
            } else {
                counts[name]++;
                return `${name} (${counts[name]})`;
            }
        });
    };

    const updateTabNames = (tabs) => {
        const rawNames = Array.from(tabs).map(tab => stripTimeSuffix(tab.textContent));
        const tabNames = deduplicateNames(rawNames);

        if (JSON.stringify(window.__autoAcceptState.tabNames) !== JSON.stringify(tabNames)) {
            log(`updateTabNames: Detected ${tabNames.length} tabs: ${tabNames.join(', ')}`);
            window.__autoAcceptState.tabNames = tabNames;
        }
    };

    // Completion states: undefined (not started) | 'working' | 'done'
    const updateConversationCompletionState = (rawTabName, status) => {
        const tabName = stripTimeSuffix(rawTabName);
        const current = window.__autoAcceptState.completionStatus[tabName];
        if (current !== status) {
            log(`[State] ${tabName}: ${current} → ${status}`);
            window.__autoAcceptState.completionStatus[tabName] = status;
        }
    };

    // --- 2. OVERLAY LOGIC ---
    const OVERLAY_ID = '__autoAcceptBgOverlay';
    const STYLE_ID = '__autoAcceptBgStyles';
    const STYLES = `
        #__autoAcceptBgOverlay { position: fixed; background: rgba(0, 0, 0, 0.98); z-index: 2147483647; font-family: sans-serif; color: #fff; display: flex; flex-direction: column; justify-content: center; align-items: center; pointer-events: none; opacity: 0; transition: opacity 0.3s; }
        #__autoAcceptBgOverlay.visible { opacity: 1; }
        .aab-slot { margin-bottom: 12px; width: 80%; padding: 8px; background: rgba(255,255,255,0.05); border-radius: 4px; }
        .aab-header { display: flex; justify-content: space-between; font-size: 11px; margin-bottom: 4px; }
        .aab-progress-track { height: 4px; background: rgba(255,255,255,0.1); border-radius: 2px; }
        .aab-progress-fill { height: 100%; width: 20%; background: #6b7280; transition: width 0.3s, background 0.3s; }
        .aab-slot.working .aab-progress-fill { background: #a855f7; }
        .aab-slot.done .aab-progress-fill { background: #22c55e; }
        .aab-slot .status-text { color: #6b7280; }
        .aab-slot.working .status-text { color: #a855f7; }
        .aab-slot.done .status-text { color: #22c55e; }
    `;

    // Called ONCE when background mode is enabled
    function showOverlay() {
        if (document.getElementById(OVERLAY_ID)) {
            log('[Overlay] Already exists, skipping creation');
            return;
        }

        log('[Overlay] Creating overlay...');
        const state = window.__autoAcceptState;

        // Inject styles
        if (!document.getElementById(STYLE_ID)) {
            const style = document.createElement('style');
            style.id = STYLE_ID;
            style.textContent = STYLES;
            document.head.appendChild(style);
            log('[Overlay] Styles injected');
        }

        // Create overlay
        const overlay = document.createElement('div');
        overlay.id = OVERLAY_ID;

        // Create container
        const container = document.createElement('div');
        container.id = 'aab-c';
        container.style.cssText = 'width:100%; display:flex; flex-direction:column; align-items:center;';
        overlay.appendChild(container);

        document.body.appendChild(overlay);
        log('[Overlay] Overlay appended to body');

        // Find panel and sync position
        const ide = state.currentMode || 'cursor';
        let panel = null;
        if (ide === 'antigravity') {
            panel = queryAll('#antigravity\\.agentPanel').find(p => p.offsetWidth > 50);
        } else {
            panel = queryAll('#workbench\\.parts\\.auxiliarybar').find(p => p.offsetWidth > 50);
        }

        if (panel) {
            log(`[Overlay] Found panel for ${ide}, syncing position`);
            const sync = () => {
                const r = panel.getBoundingClientRect();
                Object.assign(overlay.style, { top: r.top + 'px', left: r.left + 'px', width: r.width + 'px', height: r.height + 'px' });
            };
            sync();
            new ResizeObserver(sync).observe(panel);
        } else {
            log('[Overlay] No panel found, using fullscreen');
            Object.assign(overlay.style, { top: '0', left: '0', width: '100%', height: '100%' });
        }

        // Add initial waiting message
        const waitingDiv = document.createElement('div');
        waitingDiv.className = 'aab-waiting';
        waitingDiv.style.cssText = 'color:#888; font-size:12px;';
        waitingDiv.textContent = 'Scanning for conversations...';
        container.appendChild(waitingDiv);

        requestAnimationFrame(() => overlay.classList.add('visible'));
    }

    // Called on each loop iteration to update content (never creates/destroys)
    function updateOverlay() {
        const state = window.__autoAcceptState;
        const container = document.getElementById('aab-c');

        if (!container) {
            log('[Overlay] updateOverlay: No container found, skipping');
            return;
        }

        log(`[Overlay] updateOverlay call: tabNames count=${state.tabNames?.length || 0}`);
        const newNames = state.tabNames || [];

        // Handle waiting state
        if (newNames.length === 0) {
            if (!container.querySelector('.aab-waiting')) {
                container.textContent = '';
                const waitingDiv = document.createElement('div');
                waitingDiv.className = 'aab-waiting';
                waitingDiv.style.cssText = 'color:#888; font-size:12px;';
                waitingDiv.textContent = 'Scanning for conversations...';
                container.appendChild(waitingDiv);
            }
            return;
        }

        // Remove waiting if tabs exist
        const waiting = container.querySelector('.aab-waiting');
        if (waiting) waiting.remove();

        const currentSlots = Array.from(container.querySelectorAll('.aab-slot'));

        // Remove old slots
        currentSlots.forEach(slot => {
            const name = slot.getAttribute('data-name');
            if (!newNames.includes(name)) slot.remove();
        });

        // Add/Update slots
        newNames.forEach(name => {
            const status = state.completionStatus[name]; // undefined, 'working', or 'done'
            const isDone = status === 'done';

            // Simplified State Logic:
            // 1. Completed (Green)
            // 2. In Progress (Purple) - Default for everything else
            const statusClass = isDone ? 'done' : 'working';
            const statusText = isDone ? 'COMPLETED' : 'IN PROGRESS';
            const progressWidth = isDone ? '100%' : '66%';

            let slot = container.querySelector(`.aab-slot[data-name="${name}"]`);

            if (!slot) {
                slot = document.createElement('div');
                slot.className = `aab-slot ${statusClass}`;
                slot.setAttribute('data-name', name);

                const header = document.createElement('div');
                header.className = 'aab-header';

                const nameSpan = document.createElement('span');
                nameSpan.textContent = name;
                header.appendChild(nameSpan);

                const statusSpan = document.createElement('span');
                statusSpan.className = 'status-text';
                statusSpan.textContent = statusText;
                header.appendChild(statusSpan);

                slot.appendChild(header);

                const track = document.createElement('div');
                track.className = 'aab-progress-track';

                const fill = document.createElement('div');
                fill.className = 'aab-progress-fill';
                fill.style.width = progressWidth;
                track.appendChild(fill);

                slot.appendChild(track);
                container.appendChild(slot);
                log(`[Overlay] Created slot: ${name} (${statusText})`);
            } else {
                // Update existing
                slot.className = `aab-slot ${statusClass}`;

                const statusSpan = slot.querySelector('.status-text');
                if (statusSpan) statusSpan.textContent = statusText;

                const bar = slot.querySelector('.aab-progress-fill');
                if (bar) bar.style.width = progressWidth;
            }
        });
    }

    // Called ONCE when background mode is disabled
    function hideOverlay() {
        const overlay = document.getElementById(OVERLAY_ID);
        if (overlay) {
            log('[Overlay] Hiding overlay...');
            overlay.classList.remove('visible');
            setTimeout(() => overlay.remove(), 300);
        }
    }

    // --- 3. BANNED COMMAND DETECTION ---
    /**
     * Traverses the parent containers and their siblings to find the command text being executed.
     * Based on Antigravity DOM structure: the command is in a PRE/CODE block that's a sibling
     * of the button's parent/grandparent container.
     * 
     * DOM Structure (Antigravity):
     *   <div> (grandparent: flex w-full...)
     *     <p>Run command?</p>
     *     <div> (parent: ml-auto flex...)
     *       <button>Reject</button>
     *       <button>Accept</button>  <-- we start here
     *     </div>
     *   </div>
     *   
     * The command text is in a PRE block that's a previous sibling of the grandparent.
     */
    function findNearbyCommandText(el) {
        const commandSelectors = ['pre', 'code', 'pre code'];
        let commandText = '';

        // Strategy 1: Walk up to find parent containers, then search their previous siblings
        // This matches the actual Antigravity DOM where PRE blocks are siblings of the button's ancestor
        let container = el.parentElement;
        let depth = 0;
        const maxDepth = 10; // Walk up to 10 levels

        while (container && depth < maxDepth) {
            // Search previous siblings of this container for PRE/CODE blocks
            let sibling = container.previousElementSibling;
            let siblingCount = 0;

            while (sibling && siblingCount < 5) {
                // Check if sibling itself is a PRE/CODE
                if (sibling.tagName === 'PRE' || sibling.tagName === 'CODE') {
                    const text = sibling.textContent.trim();
                    if (text.length > 0) {
                        commandText += ' ' + text;
                        log(`[BannedCmd] Found <${sibling.tagName}> sibling at depth ${depth}: "${text.substring(0, 100)}..."`);
                    }
                }

                // Check children of sibling for PRE/CODE
                for (const selector of commandSelectors) {
                    const codeElements = sibling.querySelectorAll(selector);
                    for (const codeEl of codeElements) {
                        if (codeEl && codeEl.textContent) {
                            const text = codeEl.textContent.trim();
                            if (text.length > 0 && text.length < 5000) {
                                commandText += ' ' + text;
                                log(`[BannedCmd] Found <${selector}> in sibling at depth ${depth}: "${text.substring(0, 100)}..."`);
                            }
                        }
                    }
                }

                sibling = sibling.previousElementSibling;
                siblingCount++;
            }

            // If we found command text, we're done
            if (commandText.length > 10) {
                break;
            }

            container = container.parentElement;
            depth++;
        }

        // Strategy 2: Fallback - check immediate button siblings
        if (commandText.length === 0) {
            let btnSibling = el.previousElementSibling;
            let count = 0;
            while (btnSibling && count < 3) {
                for (const selector of commandSelectors) {
                    const codeElements = btnSibling.querySelectorAll ? btnSibling.querySelectorAll(selector) : [];
                    for (const codeEl of codeElements) {
                        if (codeEl && codeEl.textContent) {
                            commandText += ' ' + codeEl.textContent.trim();
                        }
                    }
                }
                btnSibling = btnSibling.previousElementSibling;
                count++;
            }
        }

        // Strategy 3: Check aria-label and title attributes
        if (el.getAttribute('aria-label')) {
            commandText += ' ' + el.getAttribute('aria-label');
        }
        if (el.getAttribute('title')) {
            commandText += ' ' + el.getAttribute('title');
        }

        const result = commandText.trim().toLowerCase();
        if (result.length > 0) {
            log(`[BannedCmd] Extracted command text (${result.length} chars): "${result.substring(0, 150)}..."`);
        }
        return result;
    }

    /**
     * Check if a command is banned based on user-defined patterns.
     * Supports both literal substring matching and regex patterns.
     * 
     * Pattern format (line by line in settings):
     *   - Plain text: matches as literal substring (case-insensitive)
     *   - /pattern/: treated as regex (e.g., /rm\s+-rf/ matches "rm -rf")
     * 
     * @param {string} commandText - The extracted command text to check
     * @returns {boolean} True if command matches any banned pattern
     */
    function isCommandBanned(commandText) {
        const state = window.__autoAcceptState;
        const bannedList = state.bannedCommands || [];

        if (bannedList.length === 0) return false;
        if (!commandText || commandText.length === 0) return false;

        const lowerText = commandText.toLowerCase();

        for (const banned of bannedList) {
            const pattern = banned.trim();
            if (!pattern || pattern.length === 0) continue;

            try {
                // Check if pattern is a regex (starts and ends with /)
                if (pattern.startsWith('/') && pattern.lastIndexOf('/') > 0) {
                    // Extract regex pattern and flags
                    const lastSlash = pattern.lastIndexOf('/');
                    const regexPattern = pattern.substring(1, lastSlash);
                    const flags = pattern.substring(lastSlash + 1) || 'i'; // Default case-insensitive

                    const regex = new RegExp(regexPattern, flags);
                    if (regex.test(commandText)) {
                        log(`[BANNED] Command blocked by regex: /${regexPattern}/${flags}`);
                        Analytics.trackBlocked(log);
                        return true;
                    }
                } else {
                    // Plain text - literal substring match (case-insensitive)
                    const lowerPattern = pattern.toLowerCase();
                    if (lowerText.includes(lowerPattern)) {
                        log(`[BANNED] Command blocked by pattern: "${pattern}"`);
                        Analytics.trackBlocked(log);
                        return true;
                    }
                }
            } catch (e) {
                // If regex is invalid, fall back to literal match
                log(`[BANNED] Invalid regex pattern "${pattern}", using literal match: ${e.message}`);
                if (lowerText.includes(pattern.toLowerCase())) {
                    log(`[BANNED] Command blocked by pattern (fallback): "${pattern}"`);
                    Analytics.trackBlocked(log);
                    return true;
                }
            }
        }
        return false;
    }

    // --- 3a. ERROR DETECTION ---
    /**
     * Checks if the "Agent terminated due to error" message is nearby.
     * This is specific for the Antigravity error dialog.
     */
    function findNearbyErrorText(el) {
        // The structure usually is a dialog with a header or body containing the message.
        // We'll walk up to finding a container, then search for the specific text.
        let container = el.parentElement;
        let depth = 0;
        const maxDepth = 8;
        const errorSignature = "Agent terminated due to error";

        while (container && depth < maxDepth) {
            if (container.textContent && container.textContent.includes(errorSignature)) {
                log(`[ErrorDetect] Found error signature in parent (depth ${depth})`);
                return true;
            }
            container = container.parentElement;
            depth++;
        }
        return false;
    }

    // --- 4. CLICKING LOGIC ---
    function isAcceptButton(el) {
        const text = (el.textContent || "").trim().toLowerCase();
        if (text.length === 0 || text.length > 50) return false;
        const patterns = ['accept', 'run', 'retry', 'apply', 'execute', 'confirm', 'allow once', 'allow'];
        const rejects = ['skip', 'reject', 'cancel', 'close', 'refine'];
        if (rejects.some(r => text.includes(r))) return false;
        if (!patterns.some(p => text.includes(p))) return false;

        // NEW: Check if this is a file edit button (Accept All) and user disabled auto-accept
        // IMPORTANT: Only match explicit "accept all" text, NOT generic "accept" (used for terminal commands)
        const isFileEditButton = text.includes('accept all') || text.includes('accept file');
        if (isFileEditButton) {
            const state = window.__autoAcceptState;
            if (state && state.autoAcceptFileEdits === false) {
                log(`[Config] Skipping file edit button: "${text}" - autoAcceptFileEdits is disabled`);
                return false;
            }
        }

        // Check if this is a command execution button by looking for "run command" or similar
        const isCommandButton = text.includes('run command') || text.includes('execute') || text.includes('run');

        // If it's a command button, check if the command is banned
        if (isCommandButton) {
            const nearbyText = findNearbyCommandText(el);
            if (isCommandBanned(nearbyText)) {
                log(`[BANNED] Skipping button: "${text}" - command is banned`);
                return false;
            }
        }

        // Enhanced visibility check - prevent clicking invisible/off-screen elements
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();

        // Basic visibility checks
        if (style.display === 'none') return false;
        if (style.visibility === 'hidden') return false;
        if (parseFloat(style.opacity) === 0) return false;
        if (style.pointerEvents === 'none') return false;
        if (el.disabled) return false;

        // Size check - must have actual dimensions
        if (rect.width <= 0 || rect.height <= 0) return false;

        // Viewport check - must be at least partially visible on screen
        const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
        const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
        const isInViewport = rect.bottom > 0 && rect.top < viewportHeight &&
            rect.right > 0 && rect.left < viewportWidth;
        if (!isInViewport) return false;

        return true;
    }

    /**
     * Check if an element is still visible in the DOM.
     * @param {Element} el - Element to check
     * @returns {boolean} True if element is visible
     */
    function isElementVisible(el) {
        if (!el || !el.isConnected) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && rect.width > 0 && style.visibility !== 'hidden';
    }

    /**
     * Wait for an element to disappear (removed from DOM or hidden).
     * @param {Element} el - Element to watch
     * @param {number} timeout - Max time to wait in ms
     * @returns {Promise<boolean>} True if element disappeared
     */
    function waitForDisappear(el, timeout = 500) {
        return new Promise(resolve => {
            const startTime = Date.now();
            const check = () => {
                if (!isElementVisible(el)) {
                    resolve(true);
                } else if (Date.now() - startTime >= timeout) {
                    resolve(false);
                } else {
                    requestAnimationFrame(check);
                }
            };
            // Give a small initial delay for the click to register
            setTimeout(check, 50);
        });
    }

    // --- RETRY CIRCUIT BREAKER ---
    const MAX_CONSECUTIVE_RETRY_FAILURES = 5;
    const RETRY_OBSERVATION_TIMEOUT = 10000; // 10 seconds to observe retry outcome
    let consecutiveRetryFailures = 0;
    let retryCircuitBroken = false;

    function resetRetryCircuit() {
        consecutiveRetryFailures = 0;
        retryCircuitBroken = false;
    }

    function triggerRetryCircuitBreaker() {
        retryCircuitBroken = true;
        log(`[CircuitBreaker] Retry circuit broken after ${MAX_CONSECUTIVE_RETRY_FAILURES} consecutive failures. Will notify user.`);

        // Set notification flag for extension to poll
        const state = window.__autoAcceptState;
        if (state) {
            state.pendingNotification = {
                type: 'retry_circuit_broken',
                message: `Auto Accept stopped retrying after ${MAX_CONSECUTIVE_RETRY_FAILURES} consecutive failures. Please check the IDE manually.`,
                failures: consecutiveRetryFailures,
                timestamp: Date.now()
            };
        }
    }

    // Find the error container element that contains the retry button
    function findErrorContainer(retryButton) {
        // Look for common error container patterns
        let el = retryButton;
        for (let i = 0; i < 10 && el; i++) {
            el = el.parentElement;
            if (!el) break;

            // Check for error indicators in the container
            const hasErrorIcon = el.querySelector('svg[class*="error"], [class*="error-icon"], [class*="warning"]');
            const hasErrorText = el.textContent?.includes('Error') || el.textContent?.includes('terminated');
            const isLargeEnough = el.offsetHeight > 50;

            if ((hasErrorIcon || hasErrorText) && isLargeEnough) {
                return el;
            }
        }
        // Fallback: return parent of retry button
        return retryButton.parentElement?.parentElement || retryButton.parentElement;
    }

    // Check if elementA appears after elementB in DOM order
    function appearsAfterInDOM(elementA, elementB) {
        if (!elementA || !elementB) return false;
        const position = elementA.compareDocumentPosition(elementB);
        // DOCUMENT_POSITION_PRECEDING = 2 means elementB comes before elementA
        return (position & Node.DOCUMENT_POSITION_PRECEDING) !== 0;
    }

    // Detect success signal: "Thought for" text or task block appearing AFTER the error element
    function detectSuccessSignalAfter(referenceElement) {
        // Look for "Thought for" text (indicating AI is thinking again)
        const allElements = document.querySelectorAll('*');
        for (const el of allElements) {
            if (el.textContent?.includes('Thought for') && appearsAfterInDOM(el, referenceElement)) {
                return { found: true, type: 'thought', element: el };
            }
        }

        // Look for task blocks (code output, file changes, etc.)
        const taskBlocks = document.querySelectorAll('[class*="task"], [class*="code-block"], [class*="diff"]');
        for (const block of taskBlocks) {
            if (appearsAfterInDOM(block, referenceElement)) {
                return { found: true, type: 'task_block', element: block };
            }
        }

        return { found: false };
    }

    // Detect failure signal: new error appearing AFTER the original error position
    function detectFailureSignalAfter(referenceElement, originalErrorText) {
        // Look for error icons or error text
        const errorIcons = document.querySelectorAll('svg[class*="error"], [class*="error-icon"]');
        for (const icon of errorIcons) {
            if (appearsAfterInDOM(icon, referenceElement)) {
                return { found: true, type: 'error_icon', element: icon };
            }
        }

        // Look for error text content
        const allElements = document.querySelectorAll('*');
        for (const el of allElements) {
            const text = el.textContent || '';
            // Check for new error messages (not the original one)
            if ((text.includes('Error') || text.includes('terminated') || text.includes('failed'))
                && text !== originalErrorText
                && appearsAfterInDOM(el, referenceElement)
                && el.offsetHeight > 0) {
                return { found: true, type: 'error_text', element: el };
            }
        }

        return { found: false };
    }

    // Observe retry outcome by monitoring DOM changes
    function observeRetryOutcome(errorContainer, originalErrorText) {
        return new Promise((resolve) => {
            const startTime = Date.now();
            let resolved = false;

            const checkInterval = setInterval(() => {
                if (resolved) return;

                const elapsed = Date.now() - startTime;

                // Check for success signal
                const success = detectSuccessSignalAfter(errorContainer);
                if (success.found) {
                    resolved = true;
                    clearInterval(checkInterval);
                    log(`[RetryObserver] Success detected: ${success.type}`);
                    resolve({ success: true, reason: success.type });
                    return;
                }

                // Check for failure signal
                const failure = detectFailureSignalAfter(errorContainer, originalErrorText);
                if (failure.found) {
                    resolved = true;
                    clearInterval(checkInterval);
                    log(`[RetryObserver] Failure detected: ${failure.type}`);
                    resolve({ success: false, reason: failure.type });
                    return;
                }

                // Timeout - assume success if no failure signal (button click may have worked)
                if (elapsed >= RETRY_OBSERVATION_TIMEOUT) {
                    resolved = true;
                    clearInterval(checkInterval);
                    log(`[RetryObserver] Timeout reached, no clear signal. Assuming success.`);
                    resolve({ success: true, reason: 'timeout_no_failure' });
                }
            }, 500); // Check every 500ms
        });
    }

    async function performClick(selectors) {
        const found = [];
        selectors.forEach(s => queryAll(s).forEach(el => found.push(el)));
        let clicked = 0;
        let verified = 0;
        const uniqueFound = [...new Set(found)];

        for (const el of uniqueFound) {
            if (isAcceptButton(el)) {
                const buttonText = (el.textContent || "").trim();
                const lowerText = buttonText.toLowerCase();
                let isRetryButton = false;

                // --- SPECIAL HANDLING FOR RETRY ON ERROR ---
                if (lowerText.includes('retry')) {
                    isRetryButton = true;

                    // Check circuit breaker - skip if already broken
                    if (retryCircuitBroken) {
                        log(`[CircuitBreaker] Skipping retry - circuit is broken. Waiting for reset.`);
                        continue;
                    }

                    const nearbyError = findNearbyErrorText(el);
                    if (nearbyError) {
                        // It's the "Agent terminated due to error" dialog
                        const delay = Math.floor(Math.random() * 3000) + 2000; // 2000ms to 5000ms
                        log(`[Retry] Detected Antigravity error dialog. Waiting ${delay}ms to simulate human reaction...`);
                        await new Promise(r => setTimeout(r, delay));
                        log(`[Retry] Delay finished. Clicking now.`);

                        // Find error container and record original state BEFORE clicking
                        const errorContainer = findErrorContainer(el);
                        const originalErrorText = errorContainer?.textContent || '';
                        log(`[Retry] Error container found. Original text length: ${originalErrorText.length}`);

                        log(`Clicking: "${buttonText}"`);
                        el.dispatchEvent(new MouseEvent('click', { view: window, bubbles: true, cancelable: true }));
                        clicked++;

                        // Use intelligent DOM observation instead of simple disappear check
                        log(`[RetryObserver] Starting observation for retry outcome...`);
                        const outcome = await observeRetryOutcome(errorContainer, originalErrorText);

                        if (outcome.success) {
                            Analytics.trackClick(buttonText, log);
                            verified++;
                            log(`[Stats] Retry verified as SUCCESS: ${outcome.reason}`);

                            if (consecutiveRetryFailures > 0) {
                                log(`[CircuitBreaker] Retry succeeded, resetting failure count from ${consecutiveRetryFailures}`);
                            }
                            resetRetryCircuit();
                        } else {
                            log(`[Stats] Retry verified as FAILURE: ${outcome.reason}`);
                            consecutiveRetryFailures++;
                            log(`[CircuitBreaker] Retry failed. Consecutive failures: ${consecutiveRetryFailures}/${MAX_CONSECUTIVE_RETRY_FAILURES}`);

                            if (consecutiveRetryFailures >= MAX_CONSECUTIVE_RETRY_FAILURES) {
                                triggerRetryCircuitBreaker();
                            }
                        }

                        // Already handled, continue to next element
                        continue;
                    }
                }

                log(`Clicking: "${buttonText}"`);

                // Dispatch click
                el.dispatchEvent(new MouseEvent('click', { view: window, bubbles: true, cancelable: true }));
                clicked++;

                // Wait for button to disappear (verification) - for non-retry buttons
                const disappeared = await waitForDisappear(el);

                if (disappeared) {
                    // Only count if button actually disappeared (action was successful)
                    Analytics.trackClick(buttonText, log);
                    verified++;
                    log(`[Stats] Click verified (button disappeared)`);

                    // Reset retry circuit on any successful button click (e.g., Run button)
                    if (isRetryButton) {
                        if (consecutiveRetryFailures > 0) {
                            log(`[CircuitBreaker] Retry succeeded, resetting failure count from ${consecutiveRetryFailures}`);
                        }
                        resetRetryCircuit();
                    }
                } else {
                    log(`[Stats] Click not verified (button still visible after 500ms)`);

                    // Track retry failures for circuit breaker (fallback for retry without nearby error)
                    if (isRetryButton) {
                        consecutiveRetryFailures++;
                        log(`[CircuitBreaker] Retry failed. Consecutive failures: ${consecutiveRetryFailures}/${MAX_CONSECUTIVE_RETRY_FAILURES}`);

                        if (consecutiveRetryFailures >= MAX_CONSECUTIVE_RETRY_FAILURES) {
                            triggerRetryCircuitBreaker();
                        }
                    }
                }
            }
        }

        if (clicked > 0) {
            log(`[Click] Attempted: ${clicked}, Verified: ${verified}`);
        }
        return verified;
    }

    // --- 4. POLL LOOPS ---
    async function cursorLoop(sid) {
        log('[Loop] cursorLoop STARTED');
        let index = 0;
        let cycle = 0;
        while (window.__autoAcceptState.isRunning && window.__autoAcceptState.sessionID === sid) {
            cycle++;
            log(`[Loop] Cycle ${cycle}: Starting...`);

            const clicked = await performClick(['button', '[class*="button"]', '[class*="anysphere"]']);
            log(`[Loop] Cycle ${cycle}: Clicked ${clicked} buttons`);

            await new Promise(r => setTimeout(r, 800));

            // Try multiple selectors for Cursor tabs
            const tabSelectors = [
                '#workbench\\.parts\\.auxiliarybar ul[role="tablist"] li[role="tab"]',
                '.monaco-pane-view .monaco-list-row[role="listitem"]',
                'div[role="tablist"] div[role="tab"]',
                '.chat-session-item' // Potential future-proof selector
            ];

            let tabs = [];
            for (const selector of tabSelectors) {
                tabs = queryAll(selector);
                if (tabs.length > 0) {
                    log(`[Loop] Cycle ${cycle}: Found ${tabs.length} tabs using selector: ${selector}`);
                    break;
                }
            }

            if (tabs.length === 0) {
                log(`[Loop] Cycle ${cycle}: No tabs found in any known locations.`);
            }

            updateTabNames(tabs);

            if (tabs.length > 0) {
                const targetTab = tabs[index % tabs.length];
                const tabLabel = targetTab.getAttribute('aria-label') || targetTab.textContent?.trim() || 'unnamed tab';
                log(`[Loop] Cycle ${cycle}: Clicking tab "${tabLabel}"`);
                targetTab.dispatchEvent(new MouseEvent('click', { view: window, bubbles: true, cancelable: true }));
                index++;
            }

            const state = window.__autoAcceptState;
            log(`[Loop] Cycle ${cycle}: State = { tabs: ${state.tabNames?.length || 0}, isRunning: ${state.isRunning}, sid: ${state.sessionID} }`);

            updateOverlay();
            log(`[Loop] Cycle ${cycle}: Overlay updated, waiting 3s...`);

            await new Promise(r => setTimeout(r, 3000));
        }
        log('[Loop] cursorLoop STOPPED');
    }

    async function antigravityLoop(sid) {
        log('[Loop] antigravityLoop STARTED');
        let index = 0;
        let cycle = 0;
        while (window.__autoAcceptState.isRunning && window.__autoAcceptState.sessionID === sid) {
            cycle++;
            log(`[Loop] Cycle ${cycle}: Starting...`);

            // FIRST: Check for completion badges (Good/Bad) BEFORE clicking
            const allSpans = queryAll('span');
            const feedbackBadges = allSpans.filter(s => {
                const t = s.textContent.trim();
                return t === 'Good' || t === 'Bad';
            });
            const hasBadge = feedbackBadges.length > 0;

            log(`[Loop] Cycle ${cycle}: Found ${feedbackBadges.length} Good/Bad badges`);

            // Only click if there's NO completion badge (conversation is still working)
            let clicked = 0;
            if (!hasBadge) {
                // Click accept/run buttons (Antigravity specific selectors)
                clicked = await performClick(['.bg-ide-button-background']);
                log(`[Loop] Cycle ${cycle}: Clicked ${clicked} accept buttons`);
            } else {
                log(`[Loop] Cycle ${cycle}: Skipping clicks - conversation is DONE (has badge)`);
            }

            await new Promise(r => setTimeout(r, 800));

            // Optional: click New Tab button to cycle
            const nt = queryAll("[data-tooltip-id='new-conversation-tooltip']")[0];
            if (nt) {
                log(`[Loop] Cycle ${cycle}: Clicking New Tab button`);
                nt.click();
            }
            await new Promise(r => setTimeout(r, 1000));

            // Re-query tabs after potential navigation
            const tabsAfter = queryAll('button.grow');
            log(`[Loop] Cycle ${cycle}: Found ${tabsAfter.length} tabs`);
            updateTabNames(tabsAfter);

            // Click next tab in rotation and check its completion
            let clickedTabName = null;
            if (tabsAfter.length > 0) {
                const targetTab = tabsAfter[index % tabsAfter.length];
                clickedTabName = stripTimeSuffix(targetTab.textContent);
                log(`[Loop] Cycle ${cycle}: Clicking tab "${clickedTabName}"`);
                targetTab.dispatchEvent(new MouseEvent('click', { view: window, bubbles: true, cancelable: true }));
                index++;
            }

            // Wait longer for content to load (1.5s instead of 0.5s)
            await new Promise(r => setTimeout(r, 1500));

            // Check for completion badges (Good/Bad) after clicking
            const allSpansAfter = queryAll('span');
            const feedbackTexts = allSpansAfter
                .filter(s => {
                    const t = s.textContent.trim();
                    return t === 'Good' || t === 'Bad';
                })
                .map(s => s.textContent.trim());

            log(`[Loop] Cycle ${cycle}: Found ${feedbackTexts.length} Good/Bad badges`);

            // Update completion status for the tab we just clicked
            if (clickedTabName && feedbackTexts.length > 0) {
                updateConversationCompletionState(clickedTabName, 'done');
            } else if (clickedTabName && !window.__autoAcceptState.completionStatus[clickedTabName]) {
                // Leave as undefined (WAITING)
            }

            const state = window.__autoAcceptState;
            log(`[Loop] Cycle ${cycle}: State = { tabs: ${state.tabNames?.length || 0}, completions: ${JSON.stringify(state.completionStatus)} }`);

            updateOverlay();
            log(`[Loop] Cycle ${cycle}: Overlay updated, waiting 3s...`);

            await new Promise(r => setTimeout(r, 3000));
        }
        log('[Loop] antigravityLoop STOPPED');
    }

    // --- 5. LIFECYCLE API ---
    // --- Update banned commands list ---
    window.__autoAcceptUpdateBannedCommands = function (bannedList) {
        const state = window.__autoAcceptState;
        state.bannedCommands = Array.isArray(bannedList) ? bannedList : [];
        log(`[Config] Updated banned commands list: ${state.bannedCommands.length} patterns`);
        if (state.bannedCommands.length > 0) {
            log(`[Config] Banned patterns: ${state.bannedCommands.join(', ')}`);
        }
    };

    // --- Get current stats for ROI notification ---
    window.__autoAcceptGetStats = function () {
        const stats = Analytics.getStats();
        return {
            clicks: stats.clicksThisSession || 0,
            blocked: stats.blockedThisSession || 0,
            sessionStart: stats.sessionStartTime,
            fileEdits: stats.fileEditsThisSession || 0,
            terminalCommands: stats.terminalCommandsThisSession || 0,
            actionsWhileAway: stats.actionsWhileAway || 0
        };
    };

    // --- Reset stats (called when extension wants to collect and reset) ---
    window.__autoAcceptResetStats = function () {
        return Analytics.collectROI(log);
    };

    // --- Get session summary for notifications ---
    window.__autoAcceptGetSessionSummary = function () {
        return Analytics.getSessionSummary();
    };

    // --- Get and reset away actions count ---
    window.__autoAcceptGetAwayActions = function () {
        return Analytics.consumeAwayActions(log);
    };

    // --- Set focus state (called from extension - authoritative source) ---
    window.__autoAcceptSetFocusState = function (isFocused) {
        Analytics.setFocusState(isFocused, log);
    };

    // --- Reset retry circuit breaker (called from extension after user acknowledges) ---
    window.__autoAcceptResetRetryCircuit = function () {
        resetRetryCircuit();
        log(`[CircuitBreaker] Circuit breaker reset by extension`);
    };

    window.__autoAcceptStart = function (config) {
        try {
            const ide = (config.ide || 'cursor').toLowerCase();
            const isPro = config.isPro !== false;
            const isBG = config.isBackgroundMode === true;

            // Update banned commands from config
            if (config.bannedCommands) {
                window.__autoAcceptUpdateBannedCommands(config.bannedCommands);
            }

            log(`__autoAcceptStart called: ide=${ide}, isPro=${isPro}, isBG=${isBG}`);

            const state = window.__autoAcceptState;

            // Skip restart only if EXACTLY the same config
            if (state.isRunning && state.currentMode === ide && state.isBackgroundMode === isBG) {
                log(`Already running with same config, skipping`);
                return;
            }

            // Stop previous loop if switching
            if (state.isRunning) {
                log(`Stopping previous session...`);
                state.isRunning = false;
            }

            state.isRunning = true;
            state.currentMode = ide;
            state.isBackgroundMode = isBG;
            state.autoAcceptFileEdits = config.autoAcceptFileEdits !== false; // Default to true
            state.sessionID++;
            const sid = state.sessionID;

            // Initialize session start time if not set (for stats tracking)
            if (!state.stats.sessionStartTime) {
                state.stats.sessionStartTime = Date.now();
            }

            log(`Agent Loaded (IDE: ${ide}, BG: ${isBG}, isPro: ${isPro})`, true);

            if (isBG && isPro) {
                log(`[BG] Creating overlay and starting loop...`);
                showOverlay();
                log(`[BG] Overlay created, starting ${ide} loop...`);
                if (ide === 'cursor') cursorLoop(sid);
                else antigravityLoop(sid);
            } else if (isBG && !isPro) {
                log(`[BG] Background mode requires Pro, showing overlay anyway...`);
                showOverlay();
                if (ide === 'cursor') cursorLoop(sid);
                else antigravityLoop(sid);
            } else {
                hideOverlay();
                log(`Starting static poll loop...`);
                (async function staticLoop() {
                    while (state.isRunning && state.sessionID === sid) {
                        performClick(['button', '[class*="button"]', '[class*="anysphere"]']);
                        await new Promise(r => setTimeout(r, config.pollInterval || 1000));
                    }
                })();
            }
        } catch (e) {
            log(`ERROR in __autoAcceptStart: ${e.message}`);
            console.error('[AutoAccept] Start error:', e);
        }
    };

    window.__autoAcceptStop = function () {
        window.__autoAcceptState.isRunning = false;
        hideOverlay();
        log("Agent Stopped.");
    };

    log("Core Bundle Initialized.", true);
})();
