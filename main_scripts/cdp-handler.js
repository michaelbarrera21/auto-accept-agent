const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const BASE_PORT = 9000;
const PORT_RANGE = 3; // 9000 +/- 3

class CDPHandler {
    /**
     * @param {Function} logger - Logger function
     * @param {Object} options - Configuration options
     * @param {number|null} options.cdpPort - CDP port override (from VS Code settings)
     */
    constructor(logger = console.log, options = {}) {
        this.logger = logger;
        this.connections = new Map(); // port:pageId -> {ws, injected}
        this.isEnabled = false;
        this.msgId = 1;
        this.configCdpPort = options.cdpPort || null;
        this.targetPort = this._detectPort();
    }

    log(msg) {
        this.logger(`[CDP] ${msg}`);
    }

    /**
     * Detect the CDP port to use. Priority:
     * 1. CDP_PORT from config (user override)
     * 2. --remote-debugging-port from parent process command line (Windows WMI)
     * 3. --remote-debugging-port from process.argv (unlikely but try)
     * 4. null (will fall back to port range scan)
     */
    _detectPort() {
        // 1. Check config override (from VS Code settings)
        if (this.configCdpPort) {
            this.log(`Using cdpPort from settings: ${this.configCdpPort}`);
            return this.configCdpPort;
        }

        // 2. Try to detect from parent process command line (Windows only)
        // Extension Host is a child process, its parent is the main Electron process
        const parentPort = this._getParentProcessPort();
        if (parentPort) {
            this.log(`Detected --remote-debugging-port from parent process: ${parentPort}`);
            return parentPort;
        }

        // 3. Try to detect from current process.argv (unlikely to work)
        const args = process.argv.join(' ');
        const match = args.match(/--remote-debugging-port[=\s]+(\d+)/);
        if (match) {
            const port = parseInt(match[1], 10);
            this.log(`Detected --remote-debugging-port from process.argv: ${port}`);
            return port;
        }

        // 4. Check ELECTRON_REMOTE_DEBUGGING_PORT env var (some setups use this)
        if (process.env.ELECTRON_REMOTE_DEBUGGING_PORT) {
            const port = parseInt(process.env.ELECTRON_REMOTE_DEBUGGING_PORT, 10);
            this.log(`Detected port from ELECTRON_REMOTE_DEBUGGING_PORT env: ${port}`);
            return port;
        }

        this.log('Strict Mode: No specific port detected. Auto-scan is disabled.');
        return null;
    }

    /**
     * Get the remote-debugging-port from parent process command line
     * Cross-platform implementation: Windows, macOS, Linux
     */
    _getParentProcessPort() {
        switch (process.platform) {
            case 'win32':
                return this._getParentProcessPortWindows();
            case 'darwin':
                return this._getParentProcessPortMacOS();
            case 'linux':
                return this._getParentProcessPortLinux();
            default:
                this.log(`Parent process detection: Unsupported platform ${process.platform}`);
                return null;
        }
    }

    /**
     * Windows: Use PowerShell + WMI to traverse process tree
     */
    _getParentProcessPortWindows() {
        try {
            const { execSync } = require('child_process');
            const os = require('os');
            const pathModule = require('path');
            const ppid = process.ppid;

            if (!ppid) {
                this.log('Parent process detection: Cannot get parent PID');
                return null;
            }

            this.log(`Parent process detection [Windows]: Current PID=${process.pid}, Parent PID=${ppid}`);

            // Write PowerShell script to temp file to avoid escaping issues
            const scriptContent = `$current = ${ppid}
for ($i = 0; $i -lt 10; $i++) {
    try {
        $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $current" -ErrorAction SilentlyContinue
        if ($proc -and $proc.CommandLine) {
            if ($proc.CommandLine -match '--remote-debugging-port=(\\d+)') {
                Write-Output $Matches[1]
                exit 0
            }
        }
        if ($proc -and $proc.ParentProcessId -and $proc.ParentProcessId -ne 0) {
            $current = $proc.ParentProcessId
        } else {
            break
        }
    } catch {
        break
    }
}
`;
            const tempFile = pathModule.join(os.tmpdir(), `cdp-detect-${Date.now()}.ps1`);
            fs.writeFileSync(tempFile, scriptContent, 'utf8');

            try {
                const result = execSync(`powershell -ExecutionPolicy Bypass -File "${tempFile}"`, {
                    encoding: 'utf8',
                    timeout: 5000,
                    windowsHide: true
                }).trim();

                this.log(`Parent process detection [Windows]: PowerShell result = "${result}"`);

                if (result && /^\d+$/.test(result)) {
                    return parseInt(result, 10);
                }
            } finally {
                try { fs.unlinkSync(tempFile); } catch (e) { }
            }
        } catch (e) {
            this.log(`Parent process detection [Windows] failed: ${e.message}`);
        }

        return null;
    }

    /**
     * macOS: Use 'ps' command to read parent process command line
     */
    _getParentProcessPortMacOS() {
        try {
            const { execSync } = require('child_process');
            let ppid = process.ppid;

            if (!ppid) {
                this.log('Parent process detection [macOS]: Cannot get parent PID');
                return null;
            }

            this.log(`Parent process detection [macOS]: Current PID=${process.pid}, Parent PID=${ppid}`);

            // Traverse up the process tree (max 10 levels)
            for (let i = 0; i < 10 && ppid > 1; i++) {
                try {
                    const cmd = execSync(`ps -p ${ppid} -o args=`, {
                        encoding: 'utf8',
                        timeout: 2000
                    }).trim();

                    this.log(`Parent process detection [macOS]: PID ${ppid} args = "${cmd.substring(0, 100)}..."`);

                    const match = cmd.match(/--remote-debugging-port[=\s]+(\d+)/);
                    if (match) {
                        const port = parseInt(match[1], 10);
                        this.log(`Parent process detection [macOS]: Found port ${port}`);
                        return port;
                    }

                    // Get parent's parent PID
                    const ppidResult = execSync(`ps -p ${ppid} -o ppid=`, {
                        encoding: 'utf8'
                    }).trim();
                    ppid = parseInt(ppidResult, 10);
                } catch (e) {
                    break;
                }
            }
        } catch (e) {
            this.log(`Parent process detection [macOS] failed: ${e.message}`);
        }

        return null;
    }

    /**
     * Linux: Use /proc/[pid]/cmdline filesystem
     */
    _getParentProcessPortLinux() {
        try {
            let ppid = process.ppid;

            if (!ppid) {
                this.log('Parent process detection [Linux]: Cannot get parent PID');
                return null;
            }

            this.log(`Parent process detection [Linux]: Current PID=${process.pid}, Parent PID=${ppid}`);

            // Traverse up the process tree (max 10 levels)
            for (let i = 0; i < 10 && ppid > 1; i++) {
                const cmdlinePath = `/proc/${ppid}/cmdline`;
                if (!fs.existsSync(cmdlinePath)) break;

                // cmdline file uses \0 as separator
                const cmdline = fs.readFileSync(cmdlinePath, 'utf8').replace(/\0/g, ' ');

                this.log(`Parent process detection [Linux]: PID ${ppid} cmdline = "${cmdline.substring(0, 100)}..."`);

                const match = cmdline.match(/--remote-debugging-port[=\s]+(\d+)/);
                if (match) {
                    const port = parseInt(match[1], 10);
                    this.log(`Parent process detection [Linux]: Found port ${port}`);
                    return port;
                }

                // Read parent's parent PID from /proc/[pid]/stat
                const statPath = `/proc/${ppid}/stat`;
                if (!fs.existsSync(statPath)) break;

                const stat = fs.readFileSync(statPath, 'utf8');
                // stat format: pid (comm) state ppid ...
                const statMatch = stat.match(/\d+ \([^)]+\) \w+ (\d+)/);
                if (!statMatch) break;

                ppid = parseInt(statMatch[1], 10);
            }
        } catch (e) {
            this.log(`Parent process detection [Linux] failed: ${e.message}`);
        }

        return null;
    }

    /**
     * Check if CDP port is active
     */
    async isCDPAvailable() {
        if (!this.targetPort) {
            this.log('isCDPAvailable: No target port identified. CDP unavailable.');
            return false;
        }

        this.log(`isCDPAvailable: Checking target port ${this.targetPort}...`);
        try {
            const pages = await this._getPages(this.targetPort);
            if (pages.length > 0) {
                this.log(`isCDPAvailable: Found active pages on port ${this.targetPort}`);
                return true;
            }
        } catch (e) { }

        this.log(`isCDPAvailable: Target port ${this.targetPort} not responding or valid`);
        return false;
    }

    /**
     * Start/maintain the CDP connection and injection loop
     */
    async start(config) {
        if (!this.targetPort) {
            this.log('Start: No target port identified. Aborting.');
            return;
        }

        this.isEnabled = true;
        this.log(`Start: Connecting to port ${this.targetPort}...`);

        try {
            const pages = await this._getPages(this.targetPort);
            for (const page of pages) {
                const id = `${this.targetPort}:${page.id}`;
                if (!this.connections.has(id)) {
                    await this._connect(id, page.webSocketDebuggerUrl);
                }
                await this._inject(id, config);
            }
        } catch (e) {
            this.log(`Start: Connection failed: ${e.message}`);
        }
    }



    async stop() {
        this.isEnabled = false;
        for (const [id, conn] of this.connections) {
            try {
                await this._evaluate(id, 'if(window.__autoAcceptStop) window.__autoAcceptStop()');
                conn.ws.close();
            } catch (e) { }
        }
        this.connections.clear();
    }

    async _getPages(port) {
        return new Promise((resolve, reject) => {
            const req = http.get({ hostname: '127.0.0.1', port, path: '/json/list', timeout: 500 }, (res) => {
                let body = '';
                res.on('data', chunk => body += chunk);
                res.on('end', () => {
                    try {
                        const pages = JSON.parse(body);
                        // Filter for pages that look like IDE windows (usually type "page" or "background_page")
                        resolve(pages.filter(p => p.webSocketDebuggerUrl && (p.type === 'page' || p.type === 'webview')));
                    } catch (e) { resolve([]); }
                });
            });
            req.on('error', () => resolve([]));
            req.on('timeout', () => { req.destroy(); resolve([]); });
        });
    }

    async _connect(id, url) {
        return new Promise((resolve) => {
            const ws = new WebSocket(url);
            ws.on('open', () => {
                this.connections.set(id, { ws, injected: false });
                this.log(`Connected to page ${id}`);
                resolve(true);
            });
            ws.on('error', () => resolve(false));
            ws.on('close', () => {
                this.connections.delete(id);
                this.log(`Disconnected from page ${id}`);
            });
        });
    }

    async _inject(id, config) {
        const conn = this.connections.get(id);
        if (!conn) return;

        try {
            if (!conn.injected) {
                const scriptPath = path.join(__dirname, '..', 'main_scripts', 'full_cdp_script.js');
                const script = fs.readFileSync(scriptPath, 'utf8');
                await this._evaluate(id, script);
                conn.injected = true;
                this.log(`Script injected into ${id}`);
            }

            await this._evaluate(id, `if(window.__autoAcceptStart) window.__autoAcceptStart(${JSON.stringify(config)})`);
        } catch (e) {
            this.log(`Injection failed for ${id}: ${e.message}`);
        }
    }

    async _evaluate(id, expression) {
        const conn = this.connections.get(id);
        if (!conn || conn.ws.readyState !== WebSocket.OPEN) return;

        return new Promise((resolve, reject) => {
            const currentId = this.msgId++;
            const timeout = setTimeout(() => reject(new Error('CDP Timeout')), 2000);

            const onMessage = (data) => {
                const msg = JSON.parse(data.toString());
                if (msg.id === currentId) {
                    conn.ws.off('message', onMessage);
                    clearTimeout(timeout);
                    resolve(msg.result);
                }
            };

            conn.ws.on('message', onMessage);
            conn.ws.send(JSON.stringify({
                id: currentId,
                method: 'Runtime.evaluate',
                params: { expression, userGesture: true, awaitPromise: true }
            }));
        });
    }

    async getStats() {
        const stats = { clicks: 0, blocked: 0, fileEdits: 0, terminalCommands: 0 };
        for (const [id] of this.connections) {
            try {
                const res = await this._evaluate(id, 'JSON.stringify(window.__autoAcceptGetStats ? window.__autoAcceptGetStats() : {})');
                if (res?.result?.value) {
                    const s = JSON.parse(res.result.value);
                    stats.clicks += s.clicks || 0;
                    stats.blocked += s.blocked || 0;
                    stats.fileEdits += s.fileEdits || 0;
                    stats.terminalCommands += s.terminalCommands || 0;
                }
            } catch (e) { }
        }
        return stats;
    }

    async getSessionSummary() { return this.getStats(); } // Compatibility
    async setFocusState(isFocused) {
        for (const [id] of this.connections) {
            try {
                await this._evaluate(id, `if(window.__autoAcceptSetFocusState) window.__autoAcceptSetFocusState(${isFocused})`);
            } catch (e) { }
        }
    }

    getConnectionCount() { return this.connections.size; }
    async getAwayActions() { return 0; } // Placeholder
    async resetStats() { return { clicks: 0, blocked: 0 }; } // Placeholder
    async hideBackgroundOverlay() { } // Placeholder
}

module.exports = { CDPHandler };
