/**
 * Relauncher
 * Cross-platform relauncher with CDP flag support.
 * Handles shortcut discovery, modification, and relaunch for all OS.
 */

const vscode = require('vscode');
const { execSync, spawn } = require('child_process');
const os = require('os');
const http = require('http');
const fs = require('fs');
const path = require('path');

const BASE_CDP_PORT = 9222;
const CDP_FLAG = `--remote-debugging-port=${BASE_CDP_PORT}`;

class Relauncher {
    constructor(logger = null) {
        this.platform = os.platform();
        this.logger = logger || console.log;
        this.logFile = path.join(os.tmpdir(), 'auto_accept_relaunch.log');
    }

    log(msg) {
        try {
            const timestamp = new Date().toISOString();
            const formattedMsg = `[Relauncher ${timestamp}] ${msg}`;
            if (this.logger && typeof this.logger === 'function') {
                this.logger(formattedMsg);
            }
            console.log(formattedMsg);
        } catch (e) {
            console.error('Relauncher log error:', e);
        }
    }

    logToFile(msg) {
        const line = `[${new Date().toISOString()}] ${msg}\n`;
        try {
            fs.appendFileSync(this.logFile, line);
        } catch (e) { /* ignore */ }
        this.log(msg);
    }

    // ==================== STEP 1: CDP CHECK ====================

    /**
     * Check if CDP is available on a port
     */
    async isCDPRunning(port = BASE_CDP_PORT) {
        return new Promise((resolve) => {
            const req = http.get(`http://127.0.0.1:${port}/json/version`, (res) => {
                resolve(res.statusCode === 200);
            });
            req.on('error', () => resolve(false));
            req.setTimeout(2000, () => {
                req.destroy();
                resolve(false);
            });
        });
    }

    // ==================== STEP 2: FIND SHORTCUTS ====================

    /**
     * Detect the current IDE name from vscode.env
     */
    getIDEName() {
        try {
            const appName = vscode.env.appName || '';
            if (appName.toLowerCase().includes('cursor')) return 'Cursor';
            if (appName.toLowerCase().includes('antigravity')) return 'Antigravity';
            return 'Code'; // VS Code fallback
        } catch (e) {
            return 'Cursor'; // Default
        }
    }

    /**
     * Find all shortcuts for the current IDE
     * Returns array of { path, hasFlag, type }
     */
    async findIDEShortcuts() {
        const ideName = this.getIDEName();
        this.log(`Finding shortcuts for: ${ideName}`);

        if (this.platform === 'win32') {
            return await this._findWindowsShortcuts(ideName);
        } else if (this.platform === 'darwin') {
            return await this._findMacOSShortcuts(ideName);
        } else {
            return await this._findLinuxShortcuts(ideName);
        }
    }

    async _findWindowsShortcuts(ideName) {
        const shortcuts = [];
        const possiblePaths = [
            // Start Menu (most reliable)
            path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', ideName, `${ideName}.lnk`),
            // Desktop
            path.join(process.env.USERPROFILE || '', 'Desktop', `${ideName}.lnk`),
            // Taskbar (Windows 10+)
            path.join(process.env.APPDATA || '', 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar', `${ideName}.lnk`),
        ];

        for (const shortcutPath of possiblePaths) {
            if (fs.existsSync(shortcutPath)) {
                const info = await this._readWindowsShortcut(shortcutPath);
                shortcuts.push({
                    path: shortcutPath,
                    hasFlag: info.hasFlag,
                    type: shortcutPath.includes('Start Menu') ? 'startmenu' :
                        shortcutPath.includes('Desktop') ? 'desktop' : 'taskbar',
                    args: info.args,
                    target: info.target
                });
            }
        }

        this.log(`Found ${shortcuts.length} Windows shortcuts`);
        return shortcuts;
    }

    async _readWindowsShortcut(shortcutPath) {
        try {
            const psCommand = `
                $ErrorActionPreference = "Stop"
                $shell = New-Object -ComObject WScript.Shell
                $shortcut = $shell.CreateShortcut('${shortcutPath.replace(/'/g, "''")}')
                Write-Output "ARGS:$($shortcut.Arguments)"
                Write-Output "TARGET:$($shortcut.TargetPath)"
            `.trim().replace(/\n/g, '; ');

            const result = execSync(`powershell -Command "${psCommand}"`, {
                encoding: 'utf8',
                timeout: 5000
            });

            const lines = result.split('\n').map(l => l.trim());
            const argsLine = lines.find(l => l.startsWith('ARGS:')) || 'ARGS:';
            const targetLine = lines.find(l => l.startsWith('TARGET:')) || 'TARGET:';

            const args = argsLine.substring(5);
            const target = targetLine.substring(7);
            const hasFlag = args.includes('--remote-debugging-port');

            this.log(`Read shortcut: args="${args}", hasFlag=${hasFlag}`);
            return { args, target, hasFlag };
        } catch (e) {
            this.log(`Error reading shortcut ${shortcutPath}: ${e.message}`);
            return { args: '', target: '', hasFlag: false };
        }
    }

    async _findMacOSShortcuts(ideName) {
        const shortcuts = [];

        // Check for our wrapper script
        const wrapperPath = path.join(os.homedir(), '.local', 'bin', `${ideName.toLowerCase()}-cdp`);
        if (fs.existsSync(wrapperPath)) {
            const content = fs.readFileSync(wrapperPath, 'utf8');
            shortcuts.push({
                path: wrapperPath,
                hasFlag: content.includes('--remote-debugging-port'),
                type: 'wrapper'
            });
        }

        // Check the .app bundle exists
        const appPath = `/Applications/${ideName}.app`;
        if (fs.existsSync(appPath)) {
            shortcuts.push({
                path: appPath,
                hasFlag: false, // .app bundles don't have modifiable args
                type: 'app'
            });
        }

        this.log(`Found ${shortcuts.length} macOS shortcuts/apps`);
        return shortcuts;
    }

    async _findLinuxShortcuts(ideName) {
        const shortcuts = [];
        const desktopLocations = [
            path.join(os.homedir(), '.local', 'share', 'applications', `${ideName.toLowerCase()}.desktop`),
            `/usr/share/applications/${ideName.toLowerCase()}.desktop`,
        ];

        for (const desktopPath of desktopLocations) {
            if (fs.existsSync(desktopPath)) {
                const content = fs.readFileSync(desktopPath, 'utf8');
                const execMatch = content.match(/^Exec=(.*)$/m);
                const execLine = execMatch ? execMatch[1] : '';

                shortcuts.push({
                    path: desktopPath,
                    hasFlag: execLine.includes('--remote-debugging-port'),
                    type: desktopPath.includes('.local') ? 'user' : 'system',
                    execLine
                });
            }
        }

        this.log(`Found ${shortcuts.length} Linux .desktop files`);
        return shortcuts;
    }

    // ==================== STEP 3: MODIFY SHORTCUTS ====================

    /**
     * Ensure the shortcut has the CDP flag
     * Returns { success, modified, message }
     */
    async ensureShortcutHasFlag(shortcut) {
        if (shortcut.hasFlag) {
            return { success: true, modified: false, message: 'Already has CDP flag' };
        }

        if (this.platform === 'win32') {
            return await this._modifyWindowsShortcut(shortcut.path);
        } else if (this.platform === 'darwin') {
            return await this._createMacOSWrapper();
        } else {
            return await this._modifyLinuxDesktop(shortcut.path);
        }
    }

    async _modifyWindowsShortcut(shortcutPath) {
        try {
            // Note: We avoid newlines in the command passed to powershell -Command to prevent parsing issues
            const psCommand = `
                $ErrorActionPreference = "Stop"
                $shell = New-Object -ComObject WScript.Shell
                $shortcut = $shell.CreateShortcut('${shortcutPath.replace(/'/g, "''")}')
                if ($shortcut.Arguments -notlike '*--remote-debugging-port*') {
                    $shortcut.Arguments = '--remote-debugging-port=9222 ' + $shortcut.Arguments
                    $shortcut.Save()
                    Write-Output "MODIFIED"
                } else {
                    Write-Output "ALREADY_SET"
                }
            `.trim().replace(/\n/g, '; ');

            const result = execSync(`powershell -Command "${psCommand}"`, {
                encoding: 'utf8',
                timeout: 5000
            }).trim();

            if (result.includes('MODIFIED')) {
                this.log(`Modified shortcut: ${shortcutPath}`);
                // Verify explicitly by reading it back? Optional but good.
                return { success: true, modified: true, message: `Modified: ${path.basename(shortcutPath)}` };
            } else if (result.includes('ALREADY_SET')) {
                this.log(`Shortcut already has CDP flag`);
                return { success: true, modified: false, message: 'Already configured' };
            } else {
                this.log(`Unexpected result: ${result}`);
                return { success: false, modified: false, message: `Unexpected result: ${result}` };
            }
        } catch (e) {
            this.log(`Error modifying shortcut: ${e.message}`);
            return { success: false, modified: false, message: e.message };
        }
    }

    async _createMacOSWrapper() {
        const ideName = this.getIDEName();
        const wrapperDir = path.join(os.homedir(), '.local', 'bin');
        const wrapperPath = path.join(wrapperDir, `${ideName.toLowerCase()}-cdp`);

        try {
            // Ensure directory exists
            fs.mkdirSync(wrapperDir, { recursive: true });

            // Find the correct binary path - Electron apps can have binaries in different locations
            const appBundle = `/Applications/${ideName}.app`;
            const possibleBinaries = [
                // Standard macOS app binary location
                path.join(appBundle, 'Contents', 'MacOS', ideName),
                // Electron app binary location (e.g., VS Code, Cursor)
                path.join(appBundle, 'Contents', 'Resources', 'app', 'bin', ideName.toLowerCase()),
                // Some apps use 'Electron' as the binary name
                path.join(appBundle, 'Contents', 'MacOS', 'Electron'),
            ];

            let binaryPath = null;
            for (const binPath of possibleBinaries) {
                if (fs.existsSync(binPath)) {
                    binaryPath = binPath;
                    this.log(`Found macOS binary at: ${binPath}`);
                    break;
                }
            }

            if (!binaryPath) {
                // Fall back to using 'open -a' command which is more reliable
                this.log(`No direct binary found, using 'open -a' method`);
                const scriptContent = `#!/bin/bash
# Auto Accept - ${ideName} with CDP enabled
# Generated: ${new Date().toISOString()}
# Uses 'open -a' for reliable app launching with arguments
open -a "${appBundle}" --args ${CDP_FLAG} "$@"
`;
                fs.writeFileSync(wrapperPath, scriptContent, { mode: 0o755 });
                this.log(`Created macOS wrapper (open -a method): ${wrapperPath}`);
            } else {
                const scriptContent = `#!/bin/bash
# Auto Accept - ${ideName} with CDP enabled
# Generated: ${new Date().toISOString()}
"${binaryPath}" ${CDP_FLAG} "$@"
`;
                fs.writeFileSync(wrapperPath, scriptContent, { mode: 0o755 });
                this.log(`Created macOS wrapper (direct binary): ${wrapperPath}`);
            }

            return {
                success: true,
                modified: true,
                message: `Created wrapper script. Launch via: ${wrapperPath}`,
                wrapperPath
            };
        } catch (e) {
            this.log(`Error creating macOS wrapper: ${e.message}`);
            return { success: false, modified: false, message: e.message };
        }
    }

    async _modifyLinuxDesktop(desktopPath) {
        try {
            let content = fs.readFileSync(desktopPath, 'utf8');

            // Check if already modified
            if (content.includes('--remote-debugging-port')) {
                return { success: true, modified: false, message: 'Already configured' };
            }

            // Modify the Exec line
            content = content.replace(
                /^(Exec=)(.*)$/m,
                `$1$2 ${CDP_FLAG}`
            );

            // Write to user location if modifying system file
            const userDesktopDir = path.join(os.homedir(), '.local', 'share', 'applications');
            const targetPath = desktopPath.includes('.local') ? desktopPath :
                path.join(userDesktopDir, path.basename(desktopPath));

            fs.mkdirSync(userDesktopDir, { recursive: true });
            fs.writeFileSync(targetPath, content);

            this.log(`Modified Linux .desktop: ${targetPath}`);
            return { success: true, modified: true, message: `Modified: ${path.basename(targetPath)}` };
        } catch (e) {
            this.log(`Error modifying .desktop: ${e.message}`);
            return { success: false, modified: false, message: e.message };
        }
    }

    // ==================== STEP 4: RELAUNCH ====================

    /**
     * Get current workspace folders as command line arguments
     */
    getWorkspaceFolders() {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) return [];
        return folders.map(f => f.uri.fsPath);
    }

    /**
     * Relaunch the IDE via the modified shortcut
     */
    async relaunchViaShortcut(shortcut) {
        const workspaceFolders = this.getWorkspaceFolders();

        fs.writeFileSync(this.logFile, `=== Relaunch started at ${new Date().toISOString()} ===\n`);
        this.logToFile(`Relaunching via: ${shortcut.path}`);
        this.logToFile(`Workspaces: ${workspaceFolders.join(', ') || '(none)'}`);

        if (this.platform === 'win32') {
            return await this._relaunchWindows(shortcut, workspaceFolders);
        } else if (this.platform === 'darwin') {
            return await this._relaunchMacOS(shortcut, workspaceFolders);
        } else {
            return await this._relaunchLinux(shortcut, workspaceFolders);
        }
    }

    async _relaunchWindows(shortcut, workspaceFolders) {
        const folderArgs = workspaceFolders.map(f => `"${f}"`).join(' ');

        // Create batch file for reliable relaunch via shortcut
        const batchPath = path.join(os.tmpdir(), 'relaunch_ide.bat');
        const batchContent = `@echo off
REM Auto Accept - IDE Relaunch Script
timeout /t 2 /nobreak >nul
start "" "${shortcut.path}" ${folderArgs}
`;

        try {
            fs.writeFileSync(batchPath, batchContent, 'utf8');
            this.log(`Created relaunch batch: ${batchPath}`);
            this.log(`Shortcut path: ${shortcut.path}`);

            const child = spawn('cmd.exe', ['/c', batchPath], {
                detached: true,
                stdio: 'ignore',
                windowsHide: true
            });
            child.unref();

            // Schedule quit
            setTimeout(() => {
                this.log('Closing current window...');
                vscode.commands.executeCommand('workbench.action.quit');
            }, 1500);

            return { success: true };
        } catch (e) {
            this.log(`Relaunch failed: ${e.message}`);
            return { success: false, error: e.message };
        }
    }

    async _relaunchMacOS(shortcut, workspaceFolders) {
        const folderArgs = workspaceFolders.map(f => `"${f}"`).join(' ');

        const scriptPath = path.join(os.tmpdir(), 'relaunch_ide.sh');
        const launchCommand = shortcut.type === 'wrapper'
            ? `"${shortcut.path}" ${folderArgs}`
            : `open -a "${shortcut.path}" --args ${CDP_FLAG} ${folderArgs}`;

        const scriptContent = `#!/bin/bash
sleep 2
${launchCommand}
`;

        try {
            fs.writeFileSync(scriptPath, scriptContent, { mode: 0o755 });
            this.log(`Created macOS relaunch script: ${scriptPath}`);
            this.log(`Shortcut type: ${shortcut.type}`);
            this.log(`Launch command: ${launchCommand}`);

            const child = spawn('/bin/bash', [scriptPath], {
                detached: true,
                stdio: 'ignore'
            });
            child.unref();

            setTimeout(() => {
                vscode.commands.executeCommand('workbench.action.quit');
            }, 1500);

            return { success: true };
        } catch (e) {
            this.log(`macOS relaunch error: ${e.message}`);
            return { success: false, error: e.message };
        }
    }

    async _relaunchLinux(shortcut, workspaceFolders) {
        const folderArgs = workspaceFolders.map(f => `"${f}"`).join(' ');
        const ideName = this.getIDEName().toLowerCase();

        // Parse the Exec line from the .desktop file to get the actual command
        // This is the most reliable method for launching with custom args
        let execCommand = '';
        if (shortcut.execLine) {
            // Remove field codes (%f, %F, %u, %U, etc.) from the Exec line
            execCommand = shortcut.execLine.replace(/%[fFuUdDnNickvm]/g, '').trim();
        }

        const scriptPath = path.join(os.tmpdir(), 'relaunch_ide.sh');
        const desktopFileName = path.basename(shortcut.path, '.desktop');

        // Build the launch script with multiple fallback methods:
        // 1. gio launch (most reliable for .desktop files)
        // 2. Direct execution of the Exec command from .desktop file
        // 3. gtk-launch (alternative)
        // 4. Direct binary execution
        // Note: All JS variables are interpolated at generation time, not at bash runtime
        const scriptContent = `#!/bin/bash
sleep 2

# Method 1: gio launch (most reliable for .desktop files)
if command -v gio &> /dev/null; then
    gio launch "${shortcut.path}" ${folderArgs} 2>/dev/null && exit 0
fi

# Method 2: Direct execution from Exec line
${execCommand ? `${execCommand} ${folderArgs} 2>/dev/null && exit 0` : '# No Exec line available'}

# Method 3: gtk-launch fallback
if command -v gtk-launch &> /dev/null; then
    gtk-launch "${desktopFileName}" ${folderArgs} 2>/dev/null && exit 0
fi

# Method 4: Try to find and run the IDE binary directly
for bin in "/usr/bin/${ideName}" "/usr/share/${ideName}/bin/${ideName}" "/opt/${ideName}/bin/${ideName}"; do
    if [ -x "$bin" ]; then
        "$bin" ${CDP_FLAG} ${folderArgs} &
        exit 0
    fi
done

echo "Failed to launch IDE" >&2
exit 1
`;

        try {
            fs.writeFileSync(scriptPath, scriptContent, { mode: 0o755 });
            this.log(`Created Linux relaunch script: ${scriptPath}`);
            this.log(`Desktop file: ${shortcut.path}`);
            this.log(`Exec command: ${execCommand || '(none parsed)'}`);

            const child = spawn('/bin/bash', [scriptPath], {
                detached: true,
                stdio: 'ignore'
            });
            child.unref();

            setTimeout(() => {
                vscode.commands.executeCommand('workbench.action.quit');
            }, 1500);

            return { success: true };
        } catch (e) {
            this.log(`Linux relaunch error: ${e.message}`);
            return { success: false, error: e.message };
        }
    }

    // ==================== MAIN ENTRY POINT ====================

    /**
     * Single entry point: Check CDP → Find Shortcut → Modify → Relaunch
     * Called from the single notification hook in extension.js
     */
    async relaunchWithCDP() {
        this.log('Starting relaunchWithCDP flow...');

        // Step 1: Check if CDP is already available
        const cdpAvailable = await this.isCDPRunning();
        if (cdpAvailable) {
            this.log('CDP already running, no relaunch needed');
            return { success: true, action: 'none', message: 'CDP already available' };
        }

        // Step 2: Find shortcuts
        const shortcuts = await this.findIDEShortcuts();
        if (shortcuts.length === 0) {
            this.log('No shortcuts found');
            return {
                success: false,
                action: 'error',
                message: 'No IDE shortcuts found. Please create a shortcut first.'
            };
        }

        // Prefer Start Menu shortcut on Windows, wrapper on macOS, user desktop on Linux
        const primaryShortcut = shortcuts.find(s =>
            s.type === 'startmenu' || s.type === 'wrapper' || s.type === 'user'
        ) || shortcuts[0];

        // Step 3: Ensure shortcut has CDP flag
        const modifyResult = await this.ensureShortcutHasFlag(primaryShortcut);
        if (!modifyResult.success) {
            return {
                success: false,
                action: 'error',
                message: `Failed to modify shortcut: ${modifyResult.message}`
            };
        }

        // Refresh shortcut info after modification
        if (modifyResult.modified) {
            primaryShortcut.hasFlag = true;
        }

        // Step 4: Relaunch via shortcut
        this.log('Relaunching IDE...');
        const relaunchResult = await this.relaunchViaShortcut(primaryShortcut);

        if (relaunchResult.success) {
            return {
                success: true,
                action: 'relaunched',
                message: modifyResult.modified
                    ? 'Shortcut updated. Relaunching with CDP enabled...'
                    : 'Relaunching with CDP enabled...'
            };
        } else {
            return {
                success: false,
                action: 'error',
                message: `Relaunch failed: ${relaunchResult.error}`
            };
        }
    }

    /**
     * Legacy compatibility: Alias for launchAndReplace
     */
    async launchAndReplace() {
        return await this.relaunchWithCDP();
    }

    /**
     * Show the single relaunch prompt (single notification hook)
     */
    async showRelaunchPrompt() {
        this.log('Showing relaunch prompt');

        const choice = await vscode.window.showInformationMessage(
            'Auto Accept requires a quick one-time setup to enable background mode. This will restart your IDE with necessary permissions.',
            { modal: false },
            'Setup & Restart',
            'Not Now'
        );

        this.log(`User chose: ${choice}`);

        if (choice === 'Setup & Restart') {
            const result = await this.relaunchWithCDP();

            if (!result.success) {
                vscode.window.showErrorMessage(`Setup failed: ${result.message}`);
            }
            // Success case: IDE will close, no need for message

            return result.success ? 'relaunched' : 'failed';
        }

        return 'cancelled';
    }

    /**
     * Legacy compatibility: Alias for showLaunchPrompt  
     */
    async showLaunchPrompt() {
        return await this.showRelaunchPrompt();
    }

    getLogFilePath() {
        return this.logFile;
    }
}

module.exports = { Relauncher, BASE_CDP_PORT };
