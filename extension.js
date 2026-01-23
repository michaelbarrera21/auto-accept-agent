const vscode = require('vscode');
const path = require('path');

const Loc = require('./utils/localization');

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

// NEW: Separated user intent from system capability
const USER_WANTS_ENABLED_KEY = 'auto-accept-user-wants-enabled'; // User's preference (persisted)
const LEGACY_ENABLED_KEY = 'auto-accept-enabled-global'; // For migration
const PRO_STATE_KEY = 'auto-accept-isPro';
const FREQ_STATE_KEY = 'auto-accept-frequency';
const BANNED_COMMANDS_KEY = 'auto-accept-banned-commands';
const ROI_STATS_KEY = 'auto-accept-roi-stats'; // For ROI notification
const SECONDS_PER_CLICK = 5; // Conservative estimate: 5 seconds saved per auto-accept
const LICENSE_API = 'https://auto-accept-backend.onrender.com/api';
// Locking
const LOCK_KEY = 'auto-accept-instance-lock';
const HEARTBEAT_KEY = 'auto-accept-instance-heartbeat';
const PENDING_ENABLE_KEY = 'auto-accept-pending-enable'; // Auto-enable after restart
const INSTANCE_ID = Math.random().toString(36).substring(7);

// NEW STATE MODEL:
// userWantsEnabled: User's preference (persisted) - only changes when user clicks toggle
// cdpAvailable: System capability (runtime) - whether CDP connection is possible
// isRunning: Actual runtime state - whether polling is active
let userWantsEnabled = false; // User's preference
let cdpAvailable = false;     // System capability (runtime only)
let isRunning = false;        // Actual running state (runtime only)
let isPro = false;
let isLockedOut = false; // Local tracking
let pollFrequency = 2000; // Default for Free
let bannedCommands = []; // List of command patterns to block

// Background Mode state
let backgroundModeEnabled = false;
const BACKGROUND_DONT_SHOW_KEY = 'auto-accept-background-dont-show';
const BACKGROUND_MODE_KEY = 'auto-accept-background-mode';
const VERSION_7_0_KEY = 'auto-accept-version-7.0-notification-shown';


let pollTimer;
let statsCollectionTimer; // For periodic stats collection
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
    } catch (e) {
        console.error('Logging failed:', e);
    }
}

function detectIDE() {
    const appName = vscode.env.appName || '';
    if (appName.toLowerCase().includes('cursor')) return 'Cursor';
    if (appName.toLowerCase().includes('antigravity')) return 'Antigravity';
    return 'Code'; // only supporting these 3 for now
}

/**
 * Migrate from legacy state key to new key
 * This ensures users don't lose their preference when updating
 */
async function migrateOldState(context) {
    // Check if new key already has a value
    const newValue = context.globalState.get(USER_WANTS_ENABLED_KEY);
    if (newValue !== undefined) {
        // Already migrated
        return;
    }

    // Check legacy key
    const legacyValue = context.globalState.get(LEGACY_ENABLED_KEY, false);
    if (legacyValue) {
        log(`Migrating legacy state: ${LEGACY_ENABLED_KEY}=${legacyValue} -> ${USER_WANTS_ENABLED_KEY}`);
        await context.globalState.update(USER_WANTS_ENABLED_KEY, legacyValue);
    }
}

async function activate(context) {
    globalContext = context;
    Loc.init(context);
    console.log('Auto Accept Extension: Activator called.');

    // CRITICAL: Create status bar items FIRST before anything else
    try {
        statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        statusBarItem.command = 'auto-accept.toggle';
        statusBarItem.text = `$(sync~spin) ${Loc.t('Auto Accept: Loading...')}`;
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
        statusBackgroundItem.text = `$(globe) ${Loc.t('Background: OFF')}`;
        statusBackgroundItem.tooltip = 'Background Mode (Pro) - Works on all chats';
        context.subscriptions.push(statusBackgroundItem);
        // Don't show by default - only when Auto Accept is ON

        console.log('Auto Accept: Status bar items created and shown.');
    } catch (sbError) {
        console.error('CRITICAL: Failed to create status bar items:', sbError);
    }

    try {
        // 1. Initialize State - NEW: Migrate from legacy key if needed
        await migrateOldState(context);
        userWantsEnabled = context.globalState.get(USER_WANTS_ENABLED_KEY, false);
        isPro = context.globalState.get(PRO_STATE_KEY, false);

        // Check for pending auto-enable (set after shortcut modification)
        const pendingEnable = context.globalState.get(PENDING_ENABLE_KEY, false);
        if (pendingEnable) {
            vscode.window.showInformationMessage(`${Loc.t('Pending enable flag detected - auto-enabling Auto Accept')}`);
            userWantsEnabled = true;
            context.globalState.update(USER_WANTS_ENABLED_KEY, true);
            context.globalState.update(PENDING_ENABLE_KEY, false);
        }

        // Read settings from VS Code configuration
        const config = vscode.workspace.getConfiguration('autoAccept');
        const localVipOverride = config.get('localVipOverride', false);
        const configCdpPort = config.get('cdpPort', null);

        // localVipOverride: 本地强制 VIP 模式（测试用）
        if (localVipOverride) {
            isPro = true;
            log('localVipOverride is enabled - forcing Pro mode');
        }

        // Load frequency
        if (isPro) {
            pollFrequency = context.globalState.get(FREQ_STATE_KEY, 1000);
        } else {
            pollFrequency = 300; // Enforce fast polling (0.3s) for free users
        }

        // Load background mode state
        backgroundModeEnabled = context.globalState.get(BACKGROUND_MODE_KEY, false);

        // Load banned commands list (default: common dangerous patterns)
        const defaultBannedCommands = [
            'rm -rf /',
            'rm -rf ~',
            'rm -rf *',
            'format c:',
            'del /f /s /q',
            'rmdir /s /q',
            ':(){:|:&};:',  // fork bomb
            'dd if=',
            'mkfs.',
            '> /dev/sda',
            'chmod -R 777 /'
        ];
        bannedCommands = context.globalState.get(BANNED_COMMANDS_KEY, defaultBannedCommands);


        // 1.5 Verify License Background Check (skip if localVipOverride is enabled)
        if (!localVipOverride) {
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
        } // end if (!LOCAL_VIP_OVERRIDE)

        currentIDE = detectIDE();

        // 2. Create Output Channel
        outputChannel = vscode.window.createOutputChannel('Auto Accept');
        context.subscriptions.push(outputChannel);

        log(`Auto Accept: Activating...`);
        log(`Auto Accept: Detected environment: ${currentIDE.toUpperCase()}`);

        // Setup Focus Listener - Push state to browser (authoritative source)
        vscode.window.onDidChangeWindowState(async (e) => {
            // Always push focus state to browser - this is the authoritative source
            if (cdpHandler && cdpHandler.setFocusState) {
                await cdpHandler.setFocusState(e.focused);
            }

            // When user returns and auto-accept is running, check for away actions
            if (e.focused && isRunning) {
                log(`[Away] Window focus detected by VS Code API. Checking for away actions...`);
                // Wait a tiny bit for CDP to settle after focus state is pushed
                setTimeout(() => checkForAwayActions(context), 500);
            }
        });

        // 3. Initialize Handlers (Lazy Load) - Both IDEs use CDP now
        try {
            const { CDPHandler } = require('./main_scripts/cdp-handler');
            const { Relauncher } = require('./main_scripts/relauncher');

            cdpHandler = new CDPHandler(log, { cdpPort: configCdpPort });
            relauncher = new Relauncher(log, context);
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
            vscode.commands.registerCommand('auto-accept.updateBannedCommands', (commands) => handleBannedCommandsUpdate(context, commands)),
            vscode.commands.registerCommand('auto-accept.getBannedCommands', () => bannedCommands),
            vscode.commands.registerCommand('auto-accept.getROIStats', async () => {
                const stats = await loadROIStats(context);
                const timeSavedSeconds = stats.clicksThisWeek * SECONDS_PER_CLICK;
                const timeSavedMinutes = Math.round(timeSavedSeconds / 60);
                return {
                    ...stats,
                    timeSavedMinutes,
                    timeSavedFormatted: timeSavedMinutes >= 60
                        ? `${(timeSavedMinutes / 60).toFixed(1)} hours`
                        : `${timeSavedMinutes} minutes`
                };
            }),
            vscode.commands.registerCommand('auto-accept.openSettings', () => {
                const panel = getSettingsPanel();
                if (panel) {
                    panel.createOrShow(context.extensionUri, context);
                } else {
                    vscode.window.showErrorMessage('Failed to load Settings Panel.');
                }
            }),
            vscode.commands.registerCommand('auto-accept.getCdpPort', () => {
                // Return the currently detected/configured CDP port
                return cdpHandler ? cdpHandler.targetPort : null;
            }),
            vscode.commands.registerCommand('auto-accept.activatePro', () => handleProActivation(context))
        );

        // 6. Register URI Handler for deep links (e.g., from Stripe success page)
        const uriHandler = {
            handleUri(uri) {
                log(`URI Handler received: ${uri.toString()}`);
                if (uri.path === '/activate' || uri.path === 'activate') {
                    log('Activation URI detected - verifying pro status...');
                    handleProActivation(context);
                }
            }
        };
        context.subscriptions.push(vscode.window.registerUriHandler(uriHandler));
        log('URI Handler registered for activation deep links.');

        // 7. Check environment and start if enabled
        try {
            await checkEnvironmentAndStart();
        } catch (err) {
            log(`Error in environment check: ${err.message}`);
        }

        // 8. Show Version 5.0 Notification (Once)
        showVersionNotification(context);



        log('Auto Accept: Activation complete');
    } catch (error) {
        console.error('ACTIVATION CRITICAL FAILURE:', error);
        log(`ACTIVATION CRITICAL FAILURE: ${error.message}`);
        vscode.window.showErrorMessage(`Auto Accept Extension failed to activate: ${error.message}`);
    }
}

async function ensureCDPOrPrompt(showPrompt = false) {
    if (!cdpHandler) return false;

    log('Checking for active CDP session...');
    const cdpAvailable = await cdpHandler.isCDPAvailable();
    log(`Environment check: CDP Available = ${cdpAvailable}`);

    if (cdpAvailable) {
        log('CDP is active and available.');
        return true;
    } else {
        log('CDP not found on target ports (9000 +/- 3).');
        if (showPrompt && relauncher) {
            log('Initiating CDP setup flow...');
            await relauncher.ensureCDPAndRelaunch();
        }
        return false;
    }
}

async function checkEnvironmentAndStart() {
    // NEW STATE MODEL: Check CDP capability but NEVER modify userWantsEnabled
    cdpAvailable = await ensureCDPOrPrompt(false);

    if (userWantsEnabled && cdpAvailable) {
        // User wants ON and system supports it -> Start running
        log('User wants enabled and CDP available. Starting polling...');
        await startPolling();
        isRunning = true;
        startStatsCollection(globalContext);
    } else if (userWantsEnabled && !cdpAvailable) {
        // User wants ON but system doesn't support -> BLOCKED state
        // CRITICAL: Do NOT modify userWantsEnabled - preserve user intent!
        log('User wants enabled but CDP unavailable. Status: BLOCKED.');
        isRunning = false;
    } else {
        // User wants OFF -> remain off
        log('User wants disabled. Remaining off.');
        isRunning = false;
    }

    updateStatusBar();
}

async function handleToggle(context) {
    log('=== handleToggle CALLED ===');
    log(`  Previous userWantsEnabled: ${userWantsEnabled}, cdpAvailable: ${cdpAvailable}`);

    try {
        // SPECIAL CASE: If we're in BLOCKED state (user wants ON but CDP unavailable),
        // clicking should trigger setup flow, NOT toggle off
        if (userWantsEnabled && !cdpAvailable) {
            log('Auto Accept: In BLOCKED state. Triggering CDP setup instead of toggling off...');
            if (relauncher) {
                await relauncher.ensureCDPAndRelaunch();
            }
            // After setup attempt, re-check CDP availability
            cdpAvailable = cdpHandler ? await cdpHandler.isCDPAvailable() : false;
            if (cdpAvailable) {
                // Now we can start running
                await startPolling();
                isRunning = true;
                startStatsCollection(context);
                incrementSessionCount(context);
                log('Auto Accept: CDP now available. Running.');
            }
            updateStatusBar();
            log('=== handleToggle COMPLETE (BLOCKED -> setup) ===');
            return;
        }

        // NORMAL CASE: Toggle user intent
        // 1. Toggle user intent UNCONDITIONALLY - this is the user's choice
        userWantsEnabled = !userWantsEnabled;
        await context.globalState.update(USER_WANTS_ENABLED_KEY, userWantsEnabled);
        log(`  User intent updated: userWantsEnabled = ${userWantsEnabled}`);

        // 2. Update UI immediately to reflect user's choice
        updateStatusBar();

        // 3. If user wants enabled, check system capability
        if (userWantsEnabled) {
            log('Auto Accept: User enabled. Checking CDP...');
            cdpAvailable = cdpHandler ? await cdpHandler.isCDPAvailable() : false;

            if (cdpAvailable) {
                // System supports it -> start running
                await startPolling();
                isRunning = true;
                startStatsCollection(context);
                incrementSessionCount(context);
                log('Auto Accept: Running.');
            } else {
                // System doesn't support -> trigger setup, stay in BLOCKED state
                isRunning = false;
                log('Auto Accept: CDP not available. Triggering setup...');
                if (relauncher) {
                    await relauncher.ensureCDPAndRelaunch();
                }
            }
        } else {
            // User disabled -> stop everything
            log('Auto Accept: User disabled.');
            isRunning = false;

            // Fire-and-forget: Show session summary notification
            if (cdpHandler) {
                cdpHandler.getSessionSummary()
                    .then(summary => showSessionSummaryNotification(context, summary))
                    .catch(() => { });
            }

            // Fire-and-forget: collect stats and stop
            collectAndSaveStats(context).catch(() => { });
            stopPolling().catch(() => { });
        }

        // Update status bar again after operations
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

    log('Initiating CDP Setup flow...');
    await relauncher.ensureCDPAndRelaunch();
}

async function handleFrequencyUpdate(context, freq) {
    pollFrequency = freq;
    await context.globalState.update(FREQ_STATE_KEY, freq);
    log(`Poll frequency updated to: ${freq}ms`);
    if (isRunning) {
        await syncSessions();
    }
}

async function handleBannedCommandsUpdate(context, commands) {
    // Only Pro users can customize the banned list
    if (!isPro) {
        log('Banned commands customization requires Pro');
        return;
    }
    bannedCommands = Array.isArray(commands) ? commands : [];
    await context.globalState.update(BANNED_COMMANDS_KEY, bannedCommands);
    log(`Banned commands updated: ${bannedCommands.length} patterns`);
    if (bannedCommands.length > 0) {
        log(`Banned patterns: ${bannedCommands.slice(0, 5).join(', ')}${bannedCommands.length > 5 ? '...' : ''}`);
    }
    if (isRunning) {
        await syncSessions();
    }
}

async function handleBackgroundToggle(context) {
    log('Background toggle clicked');

    // Free tier: Show Pro message

    if (!isPro) {
        vscode.window.showInformationMessage(
            Loc.t('Background Mode is a Pro feature.'),
            Loc.t('Learn More')
        ).then(choice => {
            if (choice === Loc.t('Learn More')) {
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
        const message = Loc.t('Background Mode allows Auto Accept to work across ALL browser tabs simultaneously, even when they\'re not focused. This is a Pro feature.');
        const enable = Loc.t('Enable');
        const dontShow = Loc.t('Don\'t Show Again & Enable');
        const choice = await vscode.window.showInformationMessage(
            message,
            { modal: true },
            enable,
            dontShow
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

        // Hide overlay in background if being disabled
        if (!backgroundModeEnabled && cdpHandler) {
            cdpHandler.hideBackgroundOverlay().catch(() => { });
        }
    }

    // Update UI immediately
    updateStatusBar();

    // Sync sessions in background (don't block)
    if (isRunning) {
        syncSessions().catch(() => { });
    }
}



async function syncSessions() {
    if (cdpHandler && !isLockedOut) {
        log(`CDP: Syncing sessions (Mode: ${backgroundModeEnabled ? 'Background' : 'Simple'})...`);
        try {
            // Read autoAcceptFileEdits config
            const config = vscode.workspace.getConfiguration('autoAccept');
            const autoAcceptFileEdits = config.get('autoAcceptFileEdits', true);

            await cdpHandler.start({
                isPro,
                isBackgroundMode: backgroundModeEnabled,
                pollInterval: pollFrequency,
                ide: currentIDE,
                bannedCommands: bannedCommands,
                autoAcceptFileEdits: autoAcceptFileEdits
            });
        } catch (err) {
            log(`CDP: Sync error: ${err.message}`);
        }
    }
}

async function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    log('Auto Accept: Monitoring session...');

    // Initial trigger
    await syncSessions();

    // Polling now primarily handles the Instance Lock and ensures CDP is active
    pollTimer = setInterval(async () => {
        if (!isRunning) return;

        // Check for instance locking - only the first extension instance should control CDP
        const lockKey = `${currentIDE.toLowerCase()}-instance-lock`;
        const activeInstance = globalContext.globalState.get(lockKey);
        const myId = globalContext.extension.id;

        if (activeInstance && activeInstance !== myId) {
            const lastPing = globalContext.globalState.get(`${lockKey}-ping`);
            if (lastPing && (Date.now() - lastPing) < 15000) {
                if (!isLockedOut) {
                    log(`CDP Control: Locked by another instance (${activeInstance}). Standby mode.`);
                    isLockedOut = true;
                    updateStatusBar();
                }
                return;
            }
        }

        // We are the leader or lock is dead
        globalContext.globalState.update(lockKey, myId);
        globalContext.globalState.update(`${lockKey}-ping`, Date.now());

        if (isLockedOut) {
            log('CDP Control: Lock acquired. Resuming control.');
            isLockedOut = false;
            updateStatusBar();
        }

        await syncSessions();
    }, 5000);
}

async function stopPolling() {
    if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
    }
    if (statsCollectionTimer) {
        clearInterval(statsCollectionTimer);
        statsCollectionTimer = null;
    }
    if (cdpHandler) await cdpHandler.stop();
    log('Auto Accept: Polling stopped');
}

// --- ROI Stats Collection ---

function getWeekStart() {
    const now = new Date();
    const dayOfWeek = now.getDay(); // 0 = Sunday
    const diff = now.getDate() - dayOfWeek;
    const weekStart = new Date(now.setDate(diff));
    weekStart.setHours(0, 0, 0, 0);
    return weekStart.getTime();
}

async function loadROIStats(context) {
    const defaultStats = {
        weekStart: getWeekStart(),
        clicksThisWeek: 0,
        blockedThisWeek: 0,
        sessionsThisWeek: 0
    };

    let stats = context.globalState.get(ROI_STATS_KEY, defaultStats);

    // Check if we need to reset for a new week
    const currentWeekStart = getWeekStart();
    if (stats.weekStart !== currentWeekStart) {
        log(`ROI Stats: New week detected. Showing summary and resetting.`);

        // Show weekly summary notification if there were meaningful stats
        if (stats.clicksThisWeek > 0) {
            await showWeeklySummaryNotification(context, stats);
        }

        // Reset for new week
        stats = { ...defaultStats, weekStart: currentWeekStart };
        await context.globalState.update(ROI_STATS_KEY, stats);
    }

    return stats;
}

async function showWeeklySummaryNotification(context, lastWeekStats) {
    const timeSavedSeconds = lastWeekStats.clicksThisWeek * SECONDS_PER_CLICK;
    const timeSavedMinutes = Math.round(timeSavedSeconds / 60);

    let timeStr;
    if (timeSavedMinutes >= 60) {
        timeStr = `${(timeSavedMinutes / 60).toFixed(1)} hours`;
    } else {
        timeStr = `${timeSavedMinutes} minutes`;
    }

    const message = `📊 Last week, Auto Accept saved you ${timeStr} by auto-clicking ${lastWeekStats.clicksThisWeek} buttons!`;

    let detail = '';
    if (lastWeekStats.sessionsThisWeek > 0) {
        detail += `Recovered ${lastWeekStats.sessionsThisWeek} stuck sessions. `;
    }
    if (lastWeekStats.blockedThisWeek > 0) {
        detail += `Blocked ${lastWeekStats.blockedThisWeek} dangerous commands.`;
    }

    const choice = await vscode.window.showInformationMessage(
        message,
        { detail: detail.trim() || undefined },
        'View Details'
    );

    if (choice === 'View Details') {
        const panel = getSettingsPanel();
        if (panel) {
            panel.createOrShow(context.extensionUri, context);
        }
    }
}

// --- SESSION SUMMARY NOTIFICATION ---
// Called when user finishes a session (e.g., leaves conversation view)
async function showSessionSummaryNotification(context, summary) {
    log(`[Notification] showSessionSummaryNotification called with: ${JSON.stringify(summary)}`);
    if (!summary || summary.clicks === 0) {
        log(`[Notification] Session summary skipped: no clicks`);
        return;
    }
    log(`[Notification] Showing session summary for ${summary.clicks} clicks`);

    const lines = [
        `✅ This session:`,
        `• ${summary.clicks} actions auto-accepted`,
        `• ${summary.terminalCommands} terminal commands`,
        `• ${summary.fileEdits} file edits`,
        `• ${summary.blocked} interruptions blocked`
    ];

    if (summary.estimatedTimeSaved) {
        lines.push(`\n⏱ Estimated time saved: ~${summary.estimatedTimeSaved} minutes`);
    }

    const message = lines.join('\n');

    vscode.window.showInformationMessage(
        `🤖 Auto Accept: ${summary.clicks} actions handled this session`,
        { detail: message },
        'View Stats'
    ).then(choice => {
        if (choice === 'View Stats') {
            const panel = getSettingsPanel();
            if (panel) panel.createOrShow(context.extensionUri, context);
        }
    });
}

// --- "AWAY" ACTIONS NOTIFICATION ---
// Called when user returns after window was minimized/unfocused
async function showAwayActionsNotification(context, actionsCount) {
    log(`[Notification] showAwayActionsNotification called with: ${actionsCount}`);
    if (!actionsCount || actionsCount === 0) {
        log(`[Notification] Away actions skipped: count is 0 or undefined`);
        return;
    }
    log(`[Notification] Showing away actions notification for ${actionsCount} actions`);

    const message = `🚀 Auto Accept handled ${actionsCount} action${actionsCount > 1 ? 's' : ''} while you were away.`;
    const detail = `Agents stayed autonomous while you focused elsewhere.`;

    vscode.window.showInformationMessage(
        message,
        { detail },
        'View Dashboard'
    ).then(choice => {
        if (choice === 'View Dashboard') {
            const panel = getSettingsPanel();
            if (panel) panel.createOrShow(context.extensionUri, context);
        }
    });
}

// --- BACKGROUND MODE UPSELL ---
// Called when free user switches tabs (could have been auto-handled)
async function showBackgroundModeUpsell(context) {
    if (isPro) return; // Already Pro, no upsell

    const UPSELL_COOLDOWN_KEY = 'auto-accept-bg-upsell-last';
    const UPSELL_COOLDOWN_MS = 1000 * 60 * 30; // 30 minutes between upsells

    const lastUpsell = context.globalState.get(UPSELL_COOLDOWN_KEY, 0);
    const now = Date.now();

    if (now - lastUpsell < UPSELL_COOLDOWN_MS) return; // Too soon

    await context.globalState.update(UPSELL_COOLDOWN_KEY, now);

    const choice = await vscode.window.showInformationMessage(
        `💡 Auto Accept could've handled this tab switch automatically.`,
        { detail: 'Enable Background Mode to keep all your agents moving in parallel—no manual tab switching needed.' },
        'Enable Background Mode',
        'Not Now'
    );

    if (choice === 'Enable Background Mode') {
        const panel = getSettingsPanel();
        if (panel) panel.createOrShow(context.extensionUri, context);
    }
}

// --- AWAY MODE POLLING ---
// Check for "away actions" when user returns (called periodically)
let lastAwayCheck = Date.now();
async function checkForAwayActions(context) {
    log(`[Away] checkForAwayActions called. cdpHandler=${!!cdpHandler}, isRunning=${isRunning}`);
    if (!cdpHandler || !isRunning) {
        log(`[Away] Skipping check: cdpHandler=${!!cdpHandler}, isRunning=${isRunning}`);
        return;
    }

    try {
        log(`[Away] Calling cdpHandler.getAwayActions()...`);
        const awayActions = await cdpHandler.getAwayActions();
        log(`[Away] Got awayActions: ${awayActions}`);
        if (awayActions > 0) {
            log(`[Away] Detected ${awayActions} actions while user was away. Showing notification...`);
            await showAwayActionsNotification(context, awayActions);
        } else {
            log(`[Away] No away actions to report`);
        }
    } catch (e) {
        log(`[Away] Error checking away actions: ${e.message}`);
    }
}

async function collectAndSaveStats(context) {
    if (!cdpHandler) return;

    try {
        // Get stats from browser and reset them
        const browserStats = await cdpHandler.resetStats();

        if (browserStats.clicks > 0 || browserStats.blocked > 0) {
            const currentStats = await loadROIStats(context);
            currentStats.clicksThisWeek += browserStats.clicks;
            currentStats.blockedThisWeek += browserStats.blocked;

            await context.globalState.update(ROI_STATS_KEY, currentStats);
            log(`ROI Stats collected: +${browserStats.clicks} clicks, +${browserStats.blocked} blocked (Total: ${currentStats.clicksThisWeek} clicks, ${currentStats.blockedThisWeek} blocked)`);
        }
    } catch (e) {
        // Silently fail - stats collection should not interrupt normal operation
    }
}

async function incrementSessionCount(context) {
    const stats = await loadROIStats(context);
    stats.sessionsThisWeek++;
    await context.globalState.update(ROI_STATS_KEY, stats);
    log(`ROI Stats: Session count incremented to ${stats.sessionsThisWeek}`);
}

function startStatsCollection(context) {
    if (statsCollectionTimer) clearInterval(statsCollectionTimer);

    // Collect stats every 30 seconds and check for away actions + notifications
    statsCollectionTimer = setInterval(async () => {
        if (isRunning) {
            collectAndSaveStats(context);
            checkForAwayActions(context); // Check if user returned from away

            // Check for pending notifications (e.g., retry circuit breaker)
            if (cdpHandler && cdpHandler.getPendingNotification) {
                try {
                    const notification = await cdpHandler.getPendingNotification();
                    if (notification && notification.type === 'retry_circuit_broken') {
                        log(`[CircuitBreaker] Received circuit breaker notification. Showing alert...`);
                        const choice = await vscode.window.showWarningMessage(
                            Loc.t('⚠️ Auto Accept stopped retrying after multiple failures. The AI agent may be stuck.'),
                            Loc.t('Resume Retry'),
                            Loc.t('Open IDE')
                        );
                        if (choice === Loc.t('Resume Retry')) {
                            // Reset circuit breaker
                            if (cdpHandler.resetRetryCircuit) {
                                await cdpHandler.resetRetryCircuit();
                                log(`[CircuitBreaker] User chose to resume retry. Circuit reset.`);
                            }
                        } else if (choice === Loc.t('Open IDE')) {
                            // Bring focus to IDE (no action needed - just dismissing notification)
                            log(`[CircuitBreaker] User chose to check manually.`);
                        }
                    }
                } catch (e) {
                    // Ignore notification errors
                }
            }
        }
    }, 30000);

    log('ROI Stats: Collection started (every 30s)');
}


function updateStatusBar() {
    if (!statusBarItem) return;

    // NEW STATE MODEL: Three states - OFF, BLOCKED, ON
    if (!userWantsEnabled) {
        // User wants OFF -> show OFF
        statusBarItem.text = `$(circle-slash) ${Loc.t('Auto Accept: OFF')}`;
        statusBarItem.tooltip = Loc.t('Click to enable Auto Accept.');
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');

        // Hide Background Mode toggle when Auto Accept is OFF
        if (statusBackgroundItem) {
            statusBackgroundItem.hide();
        }
    } else if (!cdpAvailable) {
        // User wants ON but CDP unavailable -> BLOCKED
        statusBarItem.text = `$(debug-disconnect) ${Loc.t('Auto Accept: BLOCKED')}`;
        statusBarItem.tooltip = Loc.t('Auto Accept is enabled but cannot connect. Click to configure.');
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');

        // Hide Background Mode toggle when BLOCKED
        if (statusBackgroundItem) {
            statusBackgroundItem.hide();
        }
    } else {
        // User wants ON and CDP available -> ON
        let tooltip = Loc.t('Auto Accept is running.');
        let bgColor = undefined;
        let icon = '$(check)';
        let displayStatus = Loc.t('Auto Accept: ON');

        const cdpConnected = cdpHandler && cdpHandler.getConnectionCount() > 0;

        if (cdpConnected) {
            tooltip += Loc.t(' (CDP Connected)');
        }

        if (isLockedOut) {
            displayStatus = `Auto Accept: ${Loc.t('PAUSED (Multi-window)')}`;
            bgColor = new vscode.ThemeColor('statusBarItem.warningBackground');
            icon = '$(sync~spin)';
        }

        statusBarItem.text = `${icon} ${displayStatus}`;
        statusBarItem.tooltip = tooltip;
        statusBarItem.backgroundColor = bgColor;

        // Show Background Mode toggle when Auto Accept is ON
        if (statusBackgroundItem) {
            if (backgroundModeEnabled) {
                statusBackgroundItem.text = `$(sync~spin) ${Loc.t('Background: ON')}`;
                statusBackgroundItem.tooltip = Loc.t('Background Mode is on. Click to turn off.');
                statusBackgroundItem.backgroundColor = undefined;
            } else {
                statusBackgroundItem.text = `$(globe) ${Loc.t('Background: OFF')}`;
                statusBackgroundItem.tooltip = Loc.t('Click to turn on Background Mode (works on all your chats).');
                statusBackgroundItem.backgroundColor = undefined;
            }
            statusBackgroundItem.show();
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

// Handle Pro activation (called from URI handler or command)
async function handleProActivation(context) {
    log('Pro Activation: Starting verification process...');

    // Show progress notification
    vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: 'Auto Accept: Verifying Pro status...',
            cancellable: false
        },
        async (progress) => {
            progress.report({ increment: 30 });

            // Give webhook a moment to process (Stripe webhooks can have slight delay)
            await new Promise(resolve => setTimeout(resolve, 1500));
            progress.report({ increment: 30 });

            // Verify license
            const isProNow = await verifyLicense(context);
            progress.report({ increment: 40 });

            if (isProNow) {
                // Update state
                isPro = true;
                await context.globalState.update(PRO_STATE_KEY, true);

                // Update CDP handler if running
                if (cdpHandler && cdpHandler.setProStatus) {
                    cdpHandler.setProStatus(true);
                }

                // Update poll frequency to pro default
                pollFrequency = context.globalState.get(FREQ_STATE_KEY, 1000);

                // Sync sessions with new pro status
                if (isRunning) {
                    await syncSessions();
                }

                // Update UI
                updateStatusBar();

                log('Pro Activation: SUCCESS - User is now Pro!');
                vscode.window.showInformationMessage(
                    Loc.t('🎉 Pro Activated! Thank you for your support. All Pro features are now unlocked.'),
                    'Open Dashboard'
                ).then(choice => {
                    if (choice === 'Open Dashboard') {
                        const panel = getSettingsPanel();
                        if (panel) panel.createOrShow(context.extensionUri, context);
                    }
                });
            } else {
                log('Pro Activation: License not found yet. Starting background polling...');
                // Start background polling in case webhook is delayed
                startProPolling(context);
            }
        }
    );
}

// Background polling for delayed webhook scenarios
let proPollingTimer = null;
let proPollingAttempts = 0;
const MAX_PRO_POLLING_ATTEMPTS = 24; // 2 minutes (5s intervals)

function startProPolling(context) {
    if (proPollingTimer) {
        clearInterval(proPollingTimer);
    }

    proPollingAttempts = 0;
    log('Pro Polling: Starting background verification (checking every 5s for up to 2 minutes)...');

    vscode.window.showInformationMessage(
        'Payment received! Verifying your Pro status... This may take a moment.'
    );

    proPollingTimer = setInterval(async () => {
        proPollingAttempts++;
        log(`Pro Polling: Attempt ${proPollingAttempts}/${MAX_PRO_POLLING_ATTEMPTS}`);

        if (proPollingAttempts > MAX_PRO_POLLING_ATTEMPTS) {
            clearInterval(proPollingTimer);
            proPollingTimer = null;
            log('Pro Polling: Max attempts reached. User should check manually.');
            vscode.window.showWarningMessage(
                'Pro verification is taking longer than expected. Please click "Check Pro Status" in settings, or contact support if the issue persists.',
                'Open Settings'
            ).then(choice => {
                if (choice === 'Open Settings') {
                    const panel = getSettingsPanel();
                    if (panel) panel.createOrShow(context.extensionUri, context);
                }
            });
            return;
        }

        const isProNow = await verifyLicense(context);
        if (isProNow) {
            clearInterval(proPollingTimer);
            proPollingTimer = null;

            // Update state
            isPro = true;
            await context.globalState.update(PRO_STATE_KEY, true);

            if (cdpHandler && cdpHandler.setProStatus) {
                cdpHandler.setProStatus(true);
            }

            pollFrequency = context.globalState.get(FREQ_STATE_KEY, 1000);

            if (isRunning) {
                await syncSessions();
            }

            updateStatusBar();

            log('Pro Polling: SUCCESS - Pro status confirmed!');
            vscode.window.showInformationMessage(
                '🎉 Pro Activated! Thank you for your support. All Pro features are now unlocked.',
                'Open Dashboard'
            ).then(choice => {
                if (choice === 'Open Dashboard') {
                    const panel = getSettingsPanel();
                    if (panel) panel.createOrShow(context.extensionUri, context);
                }
            });
        }
    }, 5000);
}

async function showVersionNotification(context) {
    const hasShown = context.globalState.get(VERSION_7_0_KEY, false);
    if (hasShown) return;

    // Copy for v7.0
    const title = "🚀 What's new in Auto Accept 7.0";
    const body = `Smarter. Faster. More reliable.

✅ Smart Away Notifications — Get notified only when actions happened while you were truly away.

📊 Session Insights — See exactly what happened when you turn off Auto Accept: file edits, terminal commands, and blocked interruptions.

⚡ Improved Background Mode — Faster, more reliable multi-chat handling.

🛡️ Enhanced Stability — Complete analytics rewrite for rock-solid tracking.`;
    const btnDashboard = "View Dashboard";
    const btnGotIt = "Got it";

    // Mark as shown immediately to prevent loops/multiple showings
    await context.globalState.update(VERSION_7_0_KEY, true);

    const selection = await vscode.window.showInformationMessage(
        `${title}\n\n${body}`,
        { modal: true },
        btnGotIt,
        btnDashboard
    );

    if (selection === btnDashboard) {
        const panel = getSettingsPanel();
        if (panel) panel.createOrShow(context.extensionUri, context);
    }
}



function deactivate() {
    stopPolling();
    if (cdpHandler) {
        cdpHandler.stop();
    }
}

module.exports = { activate, deactivate };
