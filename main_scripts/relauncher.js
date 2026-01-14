const vscode = require('vscode');
const { execSync, spawn } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');

const CDP_PORT = 9000;
const CDP_FLAG = `--remote-debugging-port=${CDP_PORT}`;

/**
 * Robust cross-platform manager for IDE shortcuts and relaunching
 */
class Relauncher {
    constructor(logger = console.log) {
        this.platform = os.platform();
        this.logger = logger;
    }

    log(msg) {
        this.logger(`[Relauncher] ${msg}`);
    }

    /**
     * Get the human-readable name of the IDE (Cursor, Antigravity, VS Code)
     */
    getIdeName() {
        const appName = vscode.env.appName || '';
        if (appName.toLowerCase().includes('cursor')) return 'Cursor';
        if (appName.toLowerCase().includes('antigravity')) return 'Antigravity';
        return 'Code';
    }

    /**
     * Main entry point: ensures CDP is enabled and relaunches if necessary
     */
    async ensureCDPAndRelaunch() {
        this.log('Checking if current process has CDP flag...');
        const hasFlag = await this.checkShortcutFlag();

        if (hasFlag) {
            this.log('CDP flag already present in current process.');
            return { success: true, relaunched: false };
        }

        this.log('CDP flag missing in current process. Attempting to ensure shortcut is correctly configured...');
        const status = await this.modifyShortcut();
        this.log(`Shortcut modification result: ${status}`);

        if (status === 'MODIFIED' || status === 'READY') {
            const ideName = this.getIdeName();
            const msg = status === 'MODIFIED'
                ? `Auto Accept: Shortcut updated! Please CLOSE and RESTART ${ideName} completely to enable Background Mode.`
                : `Auto Accept: Shortcut is already configured correctly, but this window isn't using it. Please CLOSE and RESTART ${ideName} completely to apply changes.`;

            // Use modal to ensure the user sees the instructions
            await vscode.window.showInformationMessage(msg, { modal: true }, 'Got it');
            return { success: true, relaunched: false };
        } else {
            this.log(`Failed to ensure shortcut configuration. Status: ${status}`);
            const ideName = this.getIdeName();
            vscode.window.showErrorMessage(
                `Auto Accept: Could not enable background mode automatically. Please add --remote-debugging-port=9000 to your ${ideName} shortcut manually, then restart.`,
                'View Help'
            ).then(selection => {
                if (selection === 'View Help') {
                    vscode.env.openExternal(vscode.Uri.parse('https://github.com/Antigravity-AI/auto-accept#background-mode-setup'));
                }
            });
        }

        return { success: false, relaunched: false };
    }

    /**
     * Platform-specific check if the current launch shortcut has the flag
     */
    async checkShortcutFlag() {
        // Optimization: checking the process arguments of the current instance
        // This is the most reliable way to know if WE were launched with it
        const args = process.argv.join(' ');
        return args.includes('--remote-debugging-port=9000');
    }

    /**
     * Modify the primary launch shortcut for the current platform
     */
    async modifyShortcut() {
        try {
            if (this.platform === 'win32') return await this._modifyWindowsShortcut();
            if (this.platform === 'darwin') return await this._modifyMacOSShortcut() ? 'MODIFIED' : 'FAILED';
            if (this.platform === 'linux') return await this._modifyLinuxShortcut() ? 'MODIFIED' : 'FAILED';
        } catch (e) {
            this.log(`Modification error: ${e.message}`);
        }
        return 'FAILED';
    }

    async _modifyWindowsShortcut() {
        const ideName = this.getIdeName();
        this.log(`Starting Windows shortcut modification for ${ideName}...`);
        const script = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = "Continue"
$WshShell = New-Object -ComObject WScript.Shell

$TargetFolders = @(
    [Environment]::GetFolderPath("Desktop"),
    [Environment]::GetFolderPath("Programs"),
    [Environment]::GetFolderPath("CommonPrograms"),
    [Environment]::GetFolderPath("StartMenu"),
    [System.IO.Path]::Combine($env:APPDATA, "Microsoft", "Internet Explorer", "Quick Launch", "User Pinned", "TaskBar"),
    [System.IO.Path]::Combine($env:USERPROFILE, "Desktop")
)

# Search ONLY for the current IDE variant
$SearchPatterns = @("*${ideName}*")

$anyModified = $false
$anyReady = $false

foreach ($folder in $TargetFolders) {
    if (Test-Path $folder) {
        Write-Output "DEBUG: Searching folder: $folder"
        foreach ($pattern in $SearchPatterns) {
            $files = Get-ChildItem -Path $folder -Filter "$pattern.lnk" -Recurse
            foreach ($file in $files) {
                Write-Output "DEBUG: Found shortcut: $($file.FullName)"
                try {
                    $shortcut = $WshShell.CreateShortcut($file.FullName)
                    if ($shortcut.Arguments -notlike "*--remote-debugging-port=9000*") {
                        if ($shortcut.Arguments -match "--remote-debugging-port=\\d+") {
                            $shortcut.Arguments = $shortcut.Arguments -replace "--remote-debugging-port=\\d+", "--remote-debugging-port=9000"
                        } else {
                            $shortcut.Arguments = "--remote-debugging-port=9000 " + $shortcut.Arguments
                        }
                        $shortcut.Save()
                        Write-Output "DEBUG: SUCCESSFULLY MODIFIED: $($file.FullName)"
                        $anyModified = $true
                    } else {
                        Write-Output "DEBUG: Flag already present in: $($file.FullName)"
                        $anyReady = $true
                    }
                } catch {
                    Write-Output "DEBUG: ERROR modifying $($file.FullName): $($_.Exception.Message)"
                }
            }
        }
    }
}

if ($anyModified) { Write-Output "RESULT: MODIFIED" } 
elseif ($anyReady) { Write-Output "RESULT: READY" }
else { Write-Output "RESULT: NOT_FOUND" }
`;
        const result = this._runPowerShell(script);
        this.log(`PowerShell Output:\n${result}`);

        if (result.includes('RESULT: MODIFIED')) return 'MODIFIED';
        if (result.includes('RESULT: READY')) return 'READY';
        return 'NOT_FOUND';
    }

    async _modifyMacOSShortcut() {
        const ideName = this.getIdeName();
        const binDir = path.join(os.homedir(), '.local', 'bin');
        if (!fs.existsSync(binDir)) fs.mkdirSync(binDir, { recursive: true });

        const wrapperPath = path.join(binDir, `${ideName.toLowerCase()}-cdp`);

        // Search for the app in common locations
        const locations = ['/Applications', path.join(os.homedir(), 'Applications')];
        const appNames = [`${ideName}.app`, 'Cursor.app', 'Visual Studio Code.app'];

        let foundAppPath = '';
        for (const loc of locations) {
            for (const name of appNames) {
                const p = path.join(loc, name);
                if (fs.existsSync(p)) {
                    foundAppPath = p;
                    break;
                }
            }
            if (foundAppPath) break;
        }

        if (!foundAppPath) return false;

        const content = `#!/bin/bash\nopen -a "${foundAppPath}" --args --remote-debugging-port=9000 "$@"`;
        fs.writeFileSync(wrapperPath, content, { mode: 0o755 });
        this.log(`Created macOS wrapper at ${wrapperPath} for ${foundAppPath}`);
        return true;
    }

    async _modifyLinuxShortcut() {
        const ideName = this.getIdeName().toLowerCase();
        const desktopDirs = [
            path.join(os.homedir(), '.local', 'share', 'applications'),
            '/usr/share/applications',
            '/usr/local/share/applications'
        ];

        let modified = false;
        for (const dir of desktopDirs) {
            if (!fs.existsSync(dir)) continue;

            const files = fs.readdirSync(dir).filter(f => f.endsWith('.desktop'));
            for (const file of files) {
                if (file.includes(ideName) || file.includes('cursor')) {
                    const p = path.join(dir, file);
                    try {
                        let content = fs.readFileSync(p, 'utf8');
                        if (!content.includes('--remote-debugging-port=9000')) {
                            content = content.replace(/^Exec=(.*)$/m, 'Exec=$1 --remote-debugging-port=9000');

                            // Always write to user's local applications to avoid sudo issues
                            const userDir = path.join(os.homedir(), '.local', 'share', 'applications');
                            if (!fs.existsSync(userDir)) fs.mkdirSync(userDir, { recursive: true });

                            const userPath = path.join(userDir, file);
                            fs.writeFileSync(userPath, content);
                            modified = true;
                        }
                    } catch (e) { }
                }
            }
        }
        return modified;
    }



    _runPowerShell(script) {
        try {
            const tempFile = path.join(os.tmpdir(), `relaunch_${Date.now()}.ps1`);
            fs.writeFileSync(tempFile, script, 'utf8');
            const result = execSync(`powershell -ExecutionPolicy Bypass -File "${tempFile}"`, { encoding: 'utf8' });
            fs.unlinkSync(tempFile);
            return result;
        } catch (e) {
            return '';
        }
    }
}

module.exports = { Relauncher };
