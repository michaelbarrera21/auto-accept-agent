const vscode = require('vscode');

// Lazy load SettingsPanel to avoid blocking activation
let SettingsPanel = null;
function getSettingsPanel() {
    if (!SettingsPanel) {
        try {
            SettingsPanel = require('./settings-panel').SettingsPanel;
        } catch (e) {
            console.error('Failed to load SettingsPanel:', e);
        }
    }
    return SettingsPanel;
}

// states

const GLOBAL_STATE_KEY = 'auto-accept-enabled-global';
const PRO_STATE_KEY = 'auto-accept-isPro';
const FREQ_STATE_KEY = 'auto-accept-frequency';
const LICENSE_API = 'https://auto-accept-backend.onrender.com/api';
// Locking
const LOCK_KEY = 'auto-accept-instance-lock';
const HEARTBEAT_KEY = 'auto-accept-instance-heartbeat';
const INSTANCE_ID = Math.random().toString(36).substring(7);

let isEnabled = false;
let isPro = false;
let isLockedOut = false; // Local tracking
let pollFrequency = 2000; // Default for Free

// Background Mode state
let backgroundModeEnabled = false;
const BACKGROUND_DONT_SHOW_KEY = 'auto-accept-background-dont-show';
const BACKGROUND_MODE_KEY = 'auto-accept-background-mode';
const VERSION_5_0_KEY = 'auto-accept-version-5.0-notification-shown';

let pollTimer;
let statusBarItem;
let statusSettingsItem;
let statusBackgroundItem; // New: Background Mode toggle
let outputChannel;
let currentIDE = 'unknown'; // 'cursor' | 'antigravity'
let globalContext;

// Handlers (used by both IDEs now)
let cdpHandler;
let relauncher;

function log(message) {
    try {
        const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
        const logLine = `[${timestamp}] ${message}`;
        console.log(logLine);
        if (outputChannel) {
            outputChannel.appendLine(logLine);
        }
    } catch (e) {
        console.error('Logging failed:', e);
    }
}

function detectIDE() {
    try {
        const appName = vscode.env.appName || '';
        if (appName.toLowerCase().includes('cursor')) {
            return 'cursor';
        }
    } catch (e) {
        console.error('Error detecting IDE:', e);
    }
    return 'antigravity'; // Default
}

async function activate(context) {
    globalContext = context;
    console.log('Auto Accept Extension: Activator called.');

    // CRITICAL: Create status bar items FIRST before anything else
    try {
        statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        statusBarItem.command = 'auto-accept.toggle';
        statusBarItem.text = '$(sync~spin) Auto Accept: Loading...';
        statusBarItem.tooltip = 'Auto Accept is initializing...';
        context.subscriptions.push(statusBarItem);
        statusBarItem.show();

        statusSettingsItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 98);
        statusSettingsItem.command = 'auto-accept.openSettings';
        statusSettingsItem.text = '$(gear)';
        statusSettingsItem.tooltip = 'Auto Accept Settings & Pro Features';
        context.subscriptions.push(statusSettingsItem);
        statusSettingsItem.show();

        // Background Mode status bar item
        statusBackgroundItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
        statusBackgroundItem.command = 'auto-accept.toggleBackground';
        statusBackgroundItem.text = '$(globe) Background: OFF';
        statusBackgroundItem.tooltip = 'Background Mode (Antigravity Pro only)';
        context.subscriptions.push(statusBackgroundItem);
        // Don't show by default - only when Auto Accept is ON

        console.log('Auto Accept: Status bar items created and shown.');
    } catch (sbError) {
        console.error('CRITICAL: Failed to create status bar items:', sbError);
    }

    try {
        // 1. Initialize State
        isEnabled = context.globalState.get(GLOBAL_STATE_KEY, false);
        isPro = context.globalState.get(PRO_STATE_KEY, false);

        // Load frequency
        if (isPro) {
            pollFrequency = context.globalState.get(FREQ_STATE_KEY, 1000);
        } else {
            pollFrequency = 300; // Enforce fast polling (0.3s) for free users
        }

        // Load background mode state
        backgroundModeEnabled = context.globalState.get(BACKGROUND_MODE_KEY, false);


        // 1.5 Verify License Background Check
        verifyLicense(context).then(isValid => {
            if (isPro !== isValid) {
                isPro = isValid;
                context.globalState.update(PRO_STATE_KEY, isValid);
                log(`License re-verification: Updated Pro status to ${isValid}`);

                if (cdpHandler && cdpHandler.setProStatus) {
                    cdpHandler.setProStatus(isValid);
                }

                if (!isValid) {
                    pollFrequency = 300; // Downgrade speed
                    if (backgroundModeEnabled) {
                        // Optional: Disable background mode visual toggle if desired, 
                        // but logic gate handles it.
                    }
                }
                updateStatusBar();
            }
        });

        currentIDE = detectIDE();

        // 2. Create Output Channel
        outputChannel = vscode.window.createOutputChannel('Auto Accept');
        context.subscriptions.push(outputChannel);

        log(`Auto Accept: Activating...`);
        log(`Auto Accept: Detected environment: ${currentIDE.toUpperCase()}`);

        // 3. Initialize Handlers (Lazy Load) - Both IDEs use CDP now
        try {
            const { CDPHandler } = require('./main_scripts/cdp-handler');
            const { Relauncher, BASE_CDP_PORT } = require('./main_scripts/relauncher');

            cdpHandler = new CDPHandler(BASE_CDP_PORT, BASE_CDP_PORT + 10, log);
            if (cdpHandler.setProStatus) {
                cdpHandler.setProStatus(isPro);
            }
            relauncher = new Relauncher(log);
            log(`CDP handlers initialized for ${currentIDE}.`);
        } catch (err) {
            log(`Failed to initialize CDP handlers: ${err.message}`);
            vscode.window.showErrorMessage(`Auto Accept Error: ${err.message}`);
        }

        // 4. Update Status Bar (already created at start)
        updateStatusBar();
        log('Status bar updated with current state.');

        // 5. Register Commands
        context.subscriptions.push(
            vscode.commands.registerCommand('auto-accept.toggle', () => handleToggle(context)),
            vscode.commands.registerCommand('auto-accept.relaunch', () => handleRelaunch()),
            vscode.commands.registerCommand('auto-accept.updateFrequency', (freq) => handleFrequencyUpdate(context, freq)),
            vscode.commands.registerCommand('auto-accept.toggleBackground', () => handleBackgroundToggle(context)),
            vscode.commands.registerCommand('auto-accept.openSettings', () => {
                const panel = getSettingsPanel();
                if (panel) {
                    panel.createOrShow(context.extensionUri, context);
                } else {
                    vscode.window.showErrorMessage('Failed to load Settings Panel.');
                }
            })
        );

        // 6. Check environment and start if enabled
        try {
            await checkEnvironmentAndStart();
        } catch (err) {
            log(`Error in environment check: ${err.message}`);
        }

        // 7. Show Version 5.0 Notification (Once)
        showVersionNotification(context);

        log('Auto Accept: Activation complete');
    } catch (error) {
        console.error('ACTIVATION CRITICAL FAILURE:', error);
        log(`ACTIVATION CRITICAL FAILURE: ${error.message}`);
        vscode.window.showErrorMessage(`Auto Accept Extension failed to activate: ${error.message}`);
    }
}

async function ensureCDPOrPrompt(showPrompt = false) {
    if (!cdpHandler) return;

    const cdpAvailable = await cdpHandler.isCDPAvailable();
    log(`Environment check: CDP Available = ${cdpAvailable}`);

    if (cdpAvailable) {
        await cdpHandler.start();
    } else {
        log('CDP not available.');
        // Only show the relaunch dialog if explicitly requested (user action)
        if (showPrompt && relauncher) {
            log('Prompting user for relaunch...');
            await relauncher.showRelaunchPrompt();
        } else {
            log('Skipping relaunch prompt (startup). User can click status bar to trigger.');
        }
    }
}

async function checkEnvironmentAndStart() {
    if (isEnabled) {
        // Both IDEs now use CDP - silent check on startup
        await ensureCDPOrPrompt(false);
        startPolling();
    }
    updateStatusBar();
}

async function handleToggle(context) {
    log('=== handleToggle CALLED ===');
    log(`  Previous isEnabled: ${isEnabled}`);

    try {
        isEnabled = !isEnabled;
        log(`  New isEnabled: ${isEnabled}`);

        await context.globalState.update(GLOBAL_STATE_KEY, isEnabled);
        log(`  GlobalState updated`);

        if (isEnabled) {
            log('Auto Accept: Enabled');
            // Show relaunch prompt when user enables (if CDP not available)
            await ensureCDPOrPrompt(true);
            startPolling();
        } else {
            log('Auto Accept: Disabled');
            stopPolling();
            if (cdpHandler) await cdpHandler.stop();
        }

        log('  Calling updateStatusBar...');
        updateStatusBar();
        log('=== handleToggle COMPLETE ===');
    } catch (e) {
        log(`Error toggling: ${e.message}`);
        log(`Error stack: ${e.stack}`);
    }
}

async function handleRelaunch() {
    if (!relauncher) {
        vscode.window.showErrorMessage('Relauncher not initialized.');
        return;
    }

    log('Initiating Relaunch...');
    const result = await relauncher.relaunchWithCDP();
    if (!result.success) {
        vscode.window.showErrorMessage(`Relaunch failed: ${result.message}`);
    }
}

async function handleBackgroundToggle(context) {
    log('Background toggle clicked');

    // Free tier: Show Pro message
    // Check if using Cursor (Background Mode is Antigravity-only)
    if (currentIDE === 'cursor') {
        vscode.window.showInformationMessage(
            'Background Mode is not yet available for Cursor. It works with Antigravity only for now.',
            'OK'
        );
        return;
    }

    if (!isPro) {
        vscode.window.showInformationMessage(
            'Background Mode is a Pro feature for Antigravity users.',
            'Learn More'
        ).then(choice => {
            if (choice === 'Learn More') {
                const panel = getSettingsPanel();
                if (panel) panel.createOrShow(context.extensionUri, context);
            }
        });
        return;
    }

    // Pro tier: Check if we should show first-time dialog
    const dontShowAgain = context.globalState.get(BACKGROUND_DONT_SHOW_KEY, false);

    if (!dontShowAgain && !backgroundModeEnabled) {
        // First-time enabling: Show confirmation dialog
        const choice = await vscode.window.showInformationMessage(
            'Turn on Background Mode?\n\n' +
            'This lets Auto Accept work on all your open chats at once. ' +
            'It will switch between tabs to click Accept for you.\n\n' +
            'You might see tabs change quickly while it works.',
            { modal: true },
            'Enable',
            "Don't Show Again & Enable",
            'Cancel'
        );

        if (choice === 'Cancel' || !choice) {
            log('Background mode cancelled by user');
            return;
        }

        if (choice === "Don't Show Again & Enable") {
            await context.globalState.update(BACKGROUND_DONT_SHOW_KEY, true);
            log('Background mode: Dont show again set');
        }

        // Enable it
        backgroundModeEnabled = true;
        await context.globalState.update(BACKGROUND_MODE_KEY, true);
        log('Background mode enabled');
    } else {
        // Simple toggle
        backgroundModeEnabled = !backgroundModeEnabled;
        await context.globalState.update(BACKGROUND_MODE_KEY, backgroundModeEnabled);
        log(`Background mode toggled: ${backgroundModeEnabled}`);

        // Hide overlay if background mode is being disabled
        if (!backgroundModeEnabled && cdpHandler) {
            await cdpHandler.hideBackgroundOverlay();
        }
    }

    updateStatusBar();
}

let agentState = 'running'; // 'running' | 'stalled' | 'recovering' | 'recovered'
let retryCount = 0;
let hasSeenUpgradeModal = false;
const MAX_RETRIES = 3;

function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    log('Auto Accept: Polling started');

    pollTimer = setInterval(async () => {
        if (!isEnabled) return;

        // Locking Check for Antigravity (Non-Cursor)
        if (currentIDE !== 'cursor') {
            const allowed = await checkInstanceLock();
            if (!allowed) {
                if (!isLockedOut) {
                    isLockedOut = true;
                    log(`Instance Locked: Another VS Code window has the lock.`);
                    updateStatusBar();
                }
                return;
            } else {
                if (isLockedOut) {
                    isLockedOut = false;
                    log(`Instance Unlocked: Acquired lock.`);
                    updateStatusBar();
                }
            }
        }

        // --- Core Loop (Simplified) ---
        // Just execute accept - no stalled/stuck detection logic
        if (agentState !== 'running') {
            agentState = 'running';
            updateStatusBar();
        }

        if (cdpHandler && cdpHandler.isEnabled) {
            await executeAccept();
        }

    }, pollFrequency);
}

function stopPolling() {
    if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
    }
    log('Auto Accept: Polling stopped');
}

async function handleRecovery(attempt) {
    if (!cursorCDP) return;

    log(`Executing Recovery Strategy #${attempt}`);

    try {
        if (attempt === 1) {
            await cdpHandler.executeAccept(true);
        } else if (attempt === 2) {
            // Strategy 2: Re-query / Force fresh selectors
            await cdpHandler.executeAccept(true);
        } else if (attempt === 3) {
            // Strategy 3: Focus refresh simulation
            await cdpHandler.executeAccept(true);
        }

        // Check if we succeeded? 
        // We will know on the NEXT poll cycle if getStuckState returns 'running'.
        // But we can optimistically set 'recovered' if we want, OR just wait.
        // Let's wait for next poll to confirm success.
    } catch (e) {
        log(`Recovery attempt ${attempt} failed: ${e.message}`);
    }
}

async function executeAccept() {
    // Both IDEs use CDP - routing is handled internally
    if (cdpHandler && cdpHandler.isEnabled) {
        try {
            // Pass backgroundModeEnabled && isPro to enable background mode
            // cdp-handler routes to appropriate polling function:
            //   - acceptPoll() for foreground mode
            //   - cursorBackgroundPoll() for Cursor background (Pro)
            //   - antigravityBackgroundPoll() for Antigravity background (Pro + tab cycling)
            const allowBackground = backgroundModeEnabled && isPro;
            const res = await cdpHandler.executeAccept(allowBackground);

            // If we clicked something and we were recovering, we are now recovered!
            if (res.executed > 0 && agentState === 'recovering') {
                agentState = 'recovered';
                log('State transition: recovering -> recovered');
                updateStatusBar();
            }
        } catch (e) {
            log(`CDP execution error: ${e.message}`);
        }
    }
}

function updateStatusBar() {
    if (!statusBarItem) return;

    if (isEnabled) {
        let statusText = 'ON';
        let tooltip = `Auto Accept is running.`;
        let bgColor = undefined;

        // State-based status (both IDEs now use CDP state machine)
        if (agentState === 'running') {
            statusText = 'ON';
            if (cdpHandler && cdpHandler.getConnectionCount() > 0) {
                tooltip += ' (CDP Connected)';
            }
        } else if (agentState === 'stalled') {
            statusText = 'WAITING';
            tooltip = isPro ? 'Waiting. Nothing to click right now.' : 'Waiting. Nothing to click right now.';
            bgColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        } else if (agentState === 'recovering') {
            statusText = 'TRYING...';
            tooltip = `Trying again (${retryCount}/${MAX_RETRIES})`;
            bgColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        } else if (agentState === 'recovered') {
            statusText = `FIXED (${retryCount})`;
            tooltip = `Fixed after ${retryCount} tries.`;
            bgColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        }

        if (isLockedOut) {
            statusText = 'PAUSED (Multi-window)';
            bgColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        }

        statusBarItem.text = `$(check) Auto Accept: ${statusText}`;
        statusBarItem.tooltip = tooltip;
        statusBarItem.backgroundColor = bgColor;

        // Show Background Mode toggle when Auto Accept is ON
        if (statusBackgroundItem) {
            if (backgroundModeEnabled) {
                statusBackgroundItem.text = '$(sync~spin) Background: ON';
                statusBackgroundItem.tooltip = 'Background Mode is on. Click to turn off.';
                statusBackgroundItem.backgroundColor = undefined;
            } else {
                statusBackgroundItem.text = '$(globe) Background: OFF';
                statusBackgroundItem.tooltip = 'Click to turn on Background Mode (works on all your chats).';
                statusBackgroundItem.backgroundColor = undefined;
            }
            statusBackgroundItem.show();
        }

    } else {
        statusBarItem.text = '$(circle-slash) Auto Accept: OFF';
        statusBarItem.tooltip = 'Click to enable Auto Accept.';
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');

        // Hide Background Mode toggle when Auto Accept is OFF
        if (statusBackgroundItem) {
            statusBackgroundItem.hide();
        }
    }
}

// Re-implement checkInstanceLock correctly with context
async function checkInstanceLock() {
    if (isPro) return true;
    if (!globalContext) return true; // Should not happen

    const lockId = globalContext.globalState.get(LOCK_KEY);
    const lastHeartbeat = globalContext.globalState.get(HEARTBEAT_KEY, 0);
    const now = Date.now();

    // 1. If no lock or lock is stale (>10s), claim it
    if (!lockId || (now - lastHeartbeat > 10000)) {
        await globalContext.globalState.update(LOCK_KEY, INSTANCE_ID);
        await globalContext.globalState.update(HEARTBEAT_KEY, now);
        return true;
    }

    // 2. If we own the lock, update heartbeat
    if (lockId === INSTANCE_ID) {
        await globalContext.globalState.update(HEARTBEAT_KEY, now);
        return true;
    }

    // 3. Someone else owns the lock and it's fresh
    return false;
}

async function verifyLicense(context) {
    const userId = context.globalState.get('auto-accept-userId');
    if (!userId) return false;

    return new Promise((resolve) => {
        const https = require('https');
        https.get(`${LICENSE_API}/check-license?userId=${userId}`, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    resolve(json.isPro === true);
                } catch (e) {
                    resolve(false);
                }
            });
        }).on('error', () => resolve(false));
    });
}

async function showVersionNotification(context) {
    const hasShown = context.globalState.get(VERSION_5_0_KEY, false);
    if (hasShown) return;

    // specific copy for 5.0
    const title = "What's new in Auto Accept 5.0";
    const body = "New for Antigravity Pro users: Background Mode!\n\nAuto Accept can now work on all your open chats at the same time. You don't need to keep each tab open anymore.\n\nNote: Background Mode is not yet available for Cursor.";
    const btnEnable = "Enable Background Mode";
    const btnGotIt = "Got it";

    // Mark as shown immediately to prevent loops/multiple showings
    await context.globalState.update(VERSION_5_0_KEY, true);

    const selection = await vscode.window.showInformationMessage(
        `${title}\n\n${body}`,
        { modal: true }, // Using modal to ensure visibility as requested ("visible to users")
        btnGotIt,
        btnEnable
    );

    if (selection === btnEnable) {
        handleBackgroundToggle(context);
    }
}

function deactivate() {
    stopPolling();
    if (cdpHandler) {
        cdpHandler.stop();
    }
}

module.exports = { activate, deactivate };
