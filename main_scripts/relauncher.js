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
    constructor(logger = console.log, context = null) {
        this.platform = os.platform();
        this.logger = logger;
        this.context = context; // VS Code extension context for globalState
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
            // User notification is handled by _showModificationResults in modifyShortcut
            return { success: true, relaunched: false };
        } else {
            this.log(`Failed to ensure shortcut configuration. Status: ${status}`);
            const ideName = this.getIdeName();
            vscode.window.showErrorMessage(
                `Auto Accept: Could not configure automatically. Please add --remote-debugging-port=9000 to your ${ideName} shortcut manually, then restart.`,
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
        return /--remote-debugging-port=\d+/.test(args);
    }

    /**
     * Modify the primary launch shortcut for the current platform
     * DISABLED: Returns 'SKIPPED' to avoid modifying system shortcuts
     */
    async modifyShortcut() {
        const ideName = this.getIdeName();
        // 1. Confirm with user
        const selection = await vscode.window.showInformationMessage(
            `Auto Accept needs to modify your ${ideName} shortcut to enable connection. This adds the "--remote-debugging-port" flag so the extension can see the IDE.`,
            { modal: true },
            'Proceed'
        );

        if (selection !== 'Proceed') {
            this.log('User cancelled shortcut modification.');
            return 'CANCELLED';
        }

        try {
            if (this.platform === 'win32') {
                // Run both shortcut and registry modifications on Windows
                const shortcutResult = await this._modifyWindowsShortcut();
                const registryResult = await this._modifyWindowsRegistry();

                // Log registry results
                this.log(`Registry modifications: ${JSON.stringify(registryResult)}`);

                // Return overall status (shortcut result takes precedence)
                return shortcutResult;
            }
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

        // PowerShell script to find and patch shortcuts by TARGET PATH
        // Logic:
        // 1. Search ALL .lnk files in common locations
        // 2. Check if TargetPath ends with IDE executable (Antigravity.exe, Cursor.exe, Code.exe)
        // 3. Calculate unique port based on --user-data-dir if present
        // 4. Update arguments and collect results

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

# Target executable name to match - ONLY the current IDE
$TargetExeName = "${ideName}.exe"

$modifiedList = @()
$readyList = @()
$searchedFolders = @()

foreach ($folder in $TargetFolders) {
    if (Test-Path $folder) {
        $searchedFolders += $folder
        Write-Output "DEBUG: Searching folder: $folder"
        
        # Search ALL .lnk files
        $files = Get-ChildItem -Path $folder -Filter "*.lnk" -Recurse -ErrorAction SilentlyContinue
        foreach ($file in $files) {
            try {
                $shortcut = $WshShell.CreateShortcut($file.FullName)
                $targetPath = $shortcut.TargetPath
                
                # Check if target matches current IDE executable
                if ($targetPath -notlike "*$TargetExeName") { continue }
                
                Write-Output "DEBUG: Found matching shortcut: $($file.FullName) -> $targetPath"
                
                $args = $shortcut.Arguments
                
                # --- Port Calculation Logic ---
                $portToUse = 9000
                if ($args -match '--user-data-dir=["'']?([^"''\\s]+)["'']?') {
                    $profilePath = $Matches[1]
                    Write-Output "DEBUG: Found user-data-dir: $profilePath"
                    
                    # Calculate stable hash for port 9001-9050
                    $md5 = [System.Security.Cryptography.MD5]::Create()
                    $pathBytes = [System.Text.Encoding]::UTF8.GetBytes($profilePath)
                    $hashBytes = $md5.ComputeHash($pathBytes)
                    $val = [BitConverter]::ToUInt16($hashBytes, 0)
                    $portToUse = 9001 + ($val % 50)
                    Write-Output "DEBUG: Calculated dynamic port: $portToUse"
                } else {
                    Write-Output "DEBUG: No user-data-dir found, using default port 9000"
                }
                
                $portFlag = "--remote-debugging-port=$portToUse"

                if ($args -notlike "*--remote-debugging-port=$portToUse*") {
                    # Remove existing port flag if any (different port)
                    if ($args -match "--remote-debugging-port=\\d+") {
                        $shortcut.Arguments = $args -replace "--remote-debugging-port=\\d+", $portFlag
                    } else {
                        $shortcut.Arguments = "$portFlag " + $args
                    }
                    
                    $shortcut.Save()
                    Write-Output "DEBUG: SUCCESSFULLY MODIFIED: $($file.FullName) to use port $portToUse"
                    $modifiedList += "$($file.Name)|$portToUse"
                } else {
                    Write-Output "DEBUG: Correct flag already present in: $($file.FullName)"
                    $readyList += "$($file.Name)|$portToUse"
                }
            } catch {
                Write-Output "DEBUG: ERROR processing $($file.FullName): $($_.Exception.Message)"
            }
        }
    }
}

# Output results in parseable format
if ($modifiedList.Count -gt 0) {
    Write-Output "RESULT: MODIFIED"
    foreach ($item in $modifiedList) {
        Write-Output "MODIFIED_ITEM: $item"
    }
} elseif ($readyList.Count -gt 0) {
    Write-Output "RESULT: READY"
    foreach ($item in $readyList) {
        Write-Output "READY_ITEM: $item"
    }
} else {
    Write-Output "RESULT: NOT_FOUND"
    Write-Output "SEARCHED_FOLDERS: $($searchedFolders -join '; ')"
}
`;
        const result = this._runPowerShell(script);
        this.log(`PowerShell Output:\n${result}`);

        // Parse results for user display
        if (result.includes('RESULT: MODIFIED')) {
            const modifiedItems = this._parseResultItems(result, 'MODIFIED_ITEM');
            this._showModificationResults(modifiedItems, 'modified');
            return 'MODIFIED';
        }
        if (result.includes('RESULT: READY')) {
            const readyItems = this._parseResultItems(result, 'READY_ITEM');
            this._showModificationResults(readyItems, 'ready');
            return 'READY';
        }
        return 'NOT_FOUND';
    }

    _parseResultItems(output, prefix) {
        const items = [];
        const lines = output.split('\n');
        for (const line of lines) {
            if (line.startsWith(`${prefix}: `)) {
                const parts = line.substring(prefix.length + 2).trim().split('|');
                if (parts.length === 2) {
                    items.push({ name: parts[0], port: parts[1] });
                }
            }
        }
        return items;
    }

    _showModificationResults(items, status) {
        if (items.length === 0) return;

        const ideName = this.getIdeName();
        let message = '';
        let detail = '';

        if (status === 'modified') {
            message = `✅ Auto Accept: 已修改 ${items.length} 个快捷方式`;
            detail = items.map(i => `• ${i.name} → 端口 ${i.port}`).join('\n');
        } else {
            message = `✅ Auto Accept: ${items.length} 个快捷方式已就绪`;
            detail = items.map(i => `• ${i.name} → 端口 ${i.port}`).join('\n');
        }

        vscode.window.showInformationMessage(
            `${message}\n\n${detail}\n\n请完全关闭并重启 ${ideName} 以应用更改。`,
            { modal: true },
            'Got it'
        ).then(() => {
            // Set pending enable flag so Auto Accept auto-enables after restart
            if (this.context && this.context.globalState) {
                this.context.globalState.update('auto-accept-pending-enable', true);
                this.log('Set pending enable flag for auto-start after restart');
            }
        });
    }

    /**
     * Modify Windows registry context menu entries
     * Returns: { modified: string[], ready: string[], failed: string[] }
     */
    async _modifyWindowsRegistry() {
        const ideName = this.getIdeName();
        this.log(`Starting Windows registry modification for ${ideName}...`);

        // PowerShell script to find and patch registry context menu entries
        // Using simple string concatenation to avoid escaping issues
        const script = [
            '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
            '$ErrorActionPreference = "Continue"',
            '',
            '# Registry paths where context menu commands live',
            '$RegistryPaths = @(',
            '    "Registry::HKEY_CLASSES_ROOT\\*\\shell",',
            '    "Registry::HKEY_CLASSES_ROOT\\Directory\\shell",',
            '    "Registry::HKEY_CLASSES_ROOT\\Directory\\Background\\shell"',
            ')',
            '',
            `$TargetExeName = "${ideName}.exe"`,
            '$PortFlag = "--remote-debugging-port=9000"',
            '',
            '$modifiedList = @()',
            '$readyList = @()',
            '$failedList = @()',
            '',
            'foreach ($basePath in $RegistryPaths) {',
            '    if (-not (Test-Path $basePath)) { continue }',
            '    $subkeys = Get-ChildItem -Path $basePath -ErrorAction SilentlyContinue',
            '    foreach ($subkey in $subkeys) {',
            '        $commandPath = Join-Path $subkey.PSPath "command"',
            '        if (-not (Test-Path $commandPath)) { continue }',
            '        try {',
            '            $cmdValue = (Get-ItemProperty -Path $commandPath -Name "(default)" -ErrorAction SilentlyContinue)."(default)"',
            '            if (-not $cmdValue) { continue }',
            '            if ($cmdValue -notlike "*$TargetExeName*") { continue }',
            '            $friendlyName = $subkey.PSChildName',
            '            Write-Output "DEBUG: Found: $friendlyName"',
            '            if ($cmdValue -like "*--remote-debugging-port=*") {',
            '                Write-Output "DEBUG: Already configured: $friendlyName"',
            '                $readyList += $friendlyName',
            '                continue',
            '            }',
            '            # Insert port flag before %V or %1',
            '            if ($cmdValue -match \'"%V"\' -or $cmdValue -match \'%V\') {',
            '                $newValue = $cmdValue -replace \'("%V"|%V)\', "$PortFlag `$1"',
            '            } elseif ($cmdValue -match \'"%1"\' -or $cmdValue -match \'%1\') {',
            '                $newValue = $cmdValue -replace \'("%1"|%1)\', "$PortFlag `$1"',
            '            } else {',
            '                $newValue = "$cmdValue $PortFlag"',
            '            }',
            '            Write-Output "DEBUG: New value: $newValue"',
            '            Set-ItemProperty -Path $commandPath -Name "(default)" -Value $newValue -ErrorAction Stop',
            '            Write-Output "DEBUG: MODIFIED: $friendlyName"',
            '            $modifiedList += $friendlyName',
            '        } catch {',
            '            Write-Output "DEBUG: FAILED: $($subkey.PSChildName) - $($_.Exception.Message)"',
            '            $failedList += $subkey.PSChildName',
            '        }',
            '    }',
            '}',
            '',
            'if ($modifiedList.Count -gt 0) {',
            '    Write-Output "REGISTRY_RESULT: MODIFIED"',
            '    foreach ($item in $modifiedList) { Write-Output "REGISTRY_MODIFIED: $item" }',
            '}',
            'if ($readyList.Count -gt 0) {',
            '    Write-Output "REGISTRY_RESULT: READY"',
            '    foreach ($item in $readyList) { Write-Output "REGISTRY_READY: $item" }',
            '}',
            'if ($failedList.Count -gt 0) {',
            '    Write-Output "REGISTRY_RESULT: FAILED"',
            '    foreach ($item in $failedList) { Write-Output "REGISTRY_FAILED: $item" }',
            '}',
            'if ($modifiedList.Count -eq 0 -and $readyList.Count -eq 0) {',
            '    Write-Output "REGISTRY_RESULT: NOT_FOUND"',
            '}'
        ].join('\n');

        const result = this._runPowerShell(script);
        this.log(`Registry PowerShell Output:\n${result}`);

        // Parse results
        const modified = this._parseRegistryItems(result, 'REGISTRY_MODIFIED');
        const ready = this._parseRegistryItems(result, 'REGISTRY_READY');
        const failed = this._parseRegistryItems(result, 'REGISTRY_FAILED');

        return { modified, ready, failed };
    }

    _parseRegistryItems(output, prefix) {
        const items = [];
        const lines = output.split('\n');
        for (const line of lines) {
            if (line.startsWith(`${prefix}: `)) {
                items.push(line.substring(prefix.length + 2).trim());
            }
        }
        return items;
    }


    async _modifyMacOSShortcut() {
        const ideName = this.getIdeName();
        const binDir = path.join(os.homedir(), '.local', 'bin');
        if (!fs.existsSync(binDir)) fs.mkdirSync(binDir, { recursive: true });

        const wrapperPath = path.join(binDir, `${ideName.toLowerCase()} -cdp`);

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

        const content = `#!/bin/bash\nopen - a "${foundAppPath}" --args--remote - debugging - port=9000 "$@"`;
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
            const result = execSync(`powershell - ExecutionPolicy Bypass - File "${tempFile}"`, { encoding: 'utf8' });
            fs.unlinkSync(tempFile);
            return result;
        } catch (e) {
            return '';
        }
    }
}

module.exports = { Relauncher };
