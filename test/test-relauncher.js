/**
 * Relauncher Test Script
 * Tests the relauncher logic on Windows without vscode dependency
 * 
 * Usage:
 *   node test-relauncher.js              # Dry run - report only
 *   node test-relauncher.js --apply      # Actually modify shortcuts
 *   node test-relauncher.js --cdp-only   # Only test CDP detection
 */

const { execSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const BASE_CDP_PORT = 9222;
const CDP_FLAG = `--remote-debugging-port=${BASE_CDP_PORT}`;

// Mock vscode for testing
const mockVscode = {
    env: { appName: 'Cursor' },
    workspace: { workspaceFolders: null }
};

console.log('╔═══════════════════════════════════════════════════════════╗');
console.log('║           Relauncher Test Script (Windows)               ║');
console.log('╚═══════════════════════════════════════════════════════════╝\n');

// Parse args
const args = process.argv.slice(2);
const applyMode = args.includes('--apply');
const cdpOnly = args.includes('--cdp-only');

if (applyMode) {
    console.log('⚠️  APPLY MODE: Will actually modify shortcuts!\n');
} else {
    console.log('ℹ️  DRY RUN MODE: No changes will be made. Use --apply to modify.\n');
}

// ==================== CDP TEST ====================

async function testCDPAvailable() {
    console.log('─── Step 1: Testing CDP Availability ───');

    return new Promise((resolve) => {
        const req = http.get(`http://127.0.0.1:${BASE_CDP_PORT}/json/version`, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode === 200) {
                    try {
                        const info = JSON.parse(data);
                        console.log(`✅ CDP is RUNNING on port ${BASE_CDP_PORT}`);
                        console.log(`   Browser: ${info.Browser || 'Unknown'}`);
                        console.log(`   WebSocket: ${info.webSocketDebuggerUrl || 'N/A'}`);
                        resolve(true);
                    } catch (e) {
                        console.log(`✅ CDP is RUNNING (but response parse failed)`);
                        resolve(true);
                    }
                } else {
                    console.log(`❌ CDP responded but with status ${res.statusCode}`);
                    resolve(false);
                }
            });
        });
        req.on('error', (e) => {
            console.log(`❌ CDP is NOT running on port ${BASE_CDP_PORT}`);
            console.log(`   Error: ${e.message}`);
            resolve(false);
        });
        req.setTimeout(3000, () => {
            req.destroy();
            console.log(`❌ CDP check timed out`);
            resolve(false);
        });
    });
}

// ==================== SHORTCUT DISCOVERY TEST ====================

function getIDEName() {
    return 'Cursor'; // Hardcode for test
}

async function readWindowsShortcut(shortcutPath) {
    try {
        const psCommand = `
            $shell = New-Object -ComObject WScript.Shell
            $shortcut = $shell.CreateShortcut('${shortcutPath.replace(/'/g, "''")}')
            Write-Output "ARGS:$($shortcut.Arguments)"
            Write-Output "TARGET:$($shortcut.TargetPath)"
        `.trim();

        const result = execSync(`powershell -Command "${psCommand}"`, { encoding: 'utf8' });
        const lines = result.split('\n').map(l => l.trim());
        const argsLine = lines.find(l => l.startsWith('ARGS:')) || 'ARGS:';
        const targetLine = lines.find(l => l.startsWith('TARGET:')) || 'TARGET:';

        const shortcutArgs = argsLine.substring(5);
        const target = targetLine.substring(7);
        const hasFlag = shortcutArgs.includes('--remote-debugging-port');

        return { args: shortcutArgs, target, hasFlag };
    } catch (e) {
        return { args: '', target: '', hasFlag: false, error: e.message };
    }
}

async function testFindShortcuts() {
    console.log('\n─── Step 2: Finding IDE Shortcuts ───');

    const ideName = getIDEName();
    console.log(`Looking for: ${ideName}`);

    const possiblePaths = [
        // Start Menu
        path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', ideName, `${ideName}.lnk`),
        // Desktop
        path.join(process.env.USERPROFILE || '', 'Desktop', `${ideName}.lnk`),
        // Taskbar
        path.join(process.env.APPDATA || '', 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar', `${ideName}.lnk`),
    ];

    const found = [];

    for (const shortcutPath of possiblePaths) {
        const exists = fs.existsSync(shortcutPath);
        const type = shortcutPath.includes('Start Menu') ? 'Start Menu' :
            shortcutPath.includes('Desktop') ? 'Desktop' : 'Taskbar';

        if (exists) {
            const info = await readWindowsShortcut(shortcutPath);
            console.log(`\n✅ FOUND: ${type}`);
            console.log(`   Path: ${shortcutPath}`);
            console.log(`   Target: ${info.target || '(unable to read)'}`);
            console.log(`   Args: ${info.args || '(none)'}`);
            console.log(`   Has CDP Flag: ${info.hasFlag ? '✅ YES' : '❌ NO'}`);

            found.push({ path: shortcutPath, type, ...info });
        } else {
            console.log(`\n❌ NOT FOUND: ${type}`);
            console.log(`   Looked at: ${shortcutPath}`);
        }
    }

    return found;
}

// ==================== SHORTCUT MODIFICATION TEST ====================

async function testModifyShortcut(shortcutPath, dryRun = true) {
    console.log(`\n─── Step 3: ${dryRun ? 'Would Modify' : 'Modifying'} Shortcut ───`);
    console.log(`   Target: ${shortcutPath}`);

    if (dryRun) {
        console.log(`   Action: Would add "${CDP_FLAG}" to Arguments`);
        console.log(`   Status: SKIPPED (dry run)`);
        return { modified: false, dryRun: true };
    }

    try {
        const psCommand = `
            $shell = New-Object -ComObject WScript.Shell
            $shortcut = $shell.CreateShortcut('${shortcutPath.replace(/'/g, "''")}')
            if ($shortcut.Arguments -notlike '*--remote-debugging-port*') {
                $shortcut.Arguments = '${CDP_FLAG} ' + $shortcut.Arguments
                $shortcut.Save()
                Write-Output 'MODIFIED'
            } else {
                Write-Output 'ALREADY_SET'
            }
        `.trim();

        const result = execSync(`powershell -Command "${psCommand}"`, { encoding: 'utf8' }).trim();

        if (result === 'MODIFIED') {
            console.log(`   ✅ Shortcut MODIFIED successfully!`);
            return { modified: true };
        } else {
            console.log(`   ℹ️  Shortcut already has the flag.`);
            return { modified: false, alreadySet: true };
        }
    } catch (e) {
        console.log(`   ❌ Error: ${e.message}`);
        return { modified: false, error: e.message };
    }
}

// ==================== MAIN ====================

async function main() {
    // Step 1: CDP Check
    const cdpRunning = await testCDPAvailable();

    if (cdpOnly) {
        console.log('\n─── CDP-Only Mode Complete ───');
        process.exit(cdpRunning ? 0 : 1);
    }

    // Step 2: Find Shortcuts
    const shortcuts = await testFindShortcuts();

    if (shortcuts.length === 0) {
        console.log('\n❌ No shortcuts found! Cannot proceed.');
        process.exit(1);
    }

    // Step 3: Modify (primary shortcut only)
    const primary = shortcuts.find(s => s.type === 'Start Menu') || shortcuts[0];

    if (!primary.hasFlag) {
        await testModifyShortcut(primary.path, !applyMode);
    } else {
        console.log('\n─── Step 3: No Modification Needed ───');
        console.log(`   Primary shortcut already has CDP flag.`);
    }

    // Summary
    console.log('\n╔═══════════════════════════════════════════════════════════╗');
    console.log('║                        Summary                            ║');
    console.log('╠═══════════════════════════════════════════════════════════╣');
    console.log(`║ CDP Running:     ${cdpRunning ? '✅ Yes' : '❌ No'}                                 ║`);
    console.log(`║ Shortcuts Found: ${shortcuts.length}                                     ║`);
    console.log(`║ Needs Modify:    ${shortcuts.filter(s => !s.hasFlag).length > 0 ? '⚠️  Yes' : '✅ No'}                                 ║`);
    console.log('╚═══════════════════════════════════════════════════════════╝');

    if (!cdpRunning && !applyMode && shortcuts.some(s => !s.hasFlag)) {
        console.log('\n💡 Tip: Run with --apply to modify shortcuts and enable CDP on next launch.');
    }
}

main().catch(e => {
    console.error('Test failed:', e);
    process.exit(1);
});
