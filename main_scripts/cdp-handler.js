const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const LOG_PREFIX = '[CDP]';

class CDPHandler {
    constructor(startPort = 9222, endPort = 9232, logger = console.log) {
        this.startPort = startPort;
        this.endPort = endPort;
        this.logger = logger;
        this.connections = new Map(); // id -> {ws, injected}
        this.messageId = 1;
        this.pendingMessages = new Map();
        this.isEnabled = false;
        this.isPro = false;
        this.logFilePath = null;
    }

    setLogFile(filePath) {
        this.logFilePath = filePath;
        if (filePath) {
            fs.writeFileSync(filePath, `[${new Date().toISOString()}] CDP Log Initialized\n`);
        }
    }

    log(...args) {
        const msg = `${LOG_PREFIX} ${args.join(' ')}`;
        if (this.logger) this.logger(msg);
        if (this.logFilePath) {
            try {
                fs.appendFileSync(this.logFilePath, `[${new Date().toISOString()}] ${msg}\n`);
            } catch (e) { }
        }
    }

    setProStatus(isPro) {
        this.isPro = isPro;
    }

    async isCDPAvailable() {
        const instances = await this.scanForInstances();
        return instances.length > 0;
    }

    async scanForInstances() {
        const instances = [];
        for (let port = this.startPort; port <= this.endPort; port++) {
            try {
                const pages = await this.getPages(port);
                if (pages.length > 0) instances.push({ port, pages });
            } catch (e) { }
        }
        return instances;
    }

    getPages(port) {
        return new Promise((resolve, reject) => {
            const req = http.get({ hostname: '127.0.0.1', port, path: '/json/list', timeout: 1000 }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try { resolve(JSON.parse(data).filter(p => p.webSocketDebuggerUrl)); }
                    catch (e) { reject(e); }
                });
            });
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        });
    }

    async start(config) {
        this.isEnabled = true;
        const instances = await this.scanForInstances();

        for (const instance of instances) {
            for (const page of instance.pages) {
                if (!this.connections.has(page.id)) {
                    await this.connectToPage(page);
                }
                if (this.connections.has(page.id)) {
                    await this.injectAndStart(page.id, config);
                }
            }
        }
    }

    async stop() {
        this.isEnabled = false;
        for (const [pageId] of this.connections) {
            try {
                await this.sendCommand(pageId, 'Runtime.evaluate', {
                    expression: 'if(typeof window !== "undefined" && window.__autoAcceptStop) window.__autoAcceptStop()'
                });
            } catch (e) { }
        }
        this.disconnectAll();
    }

    async connectToPage(page) {
        return new Promise((resolve) => {
            const ws = new WebSocket(page.webSocketDebuggerUrl);
            ws.on('open', () => {
                this.connections.set(page.id, { ws, injected: false });
                resolve(true);
            });
            ws.on('message', (data) => {
                try {
                    const msg = JSON.parse(data.toString());
                    if (msg.id && this.pendingMessages.has(msg.id)) {
                        const { resolve: res, reject: rej } = this.pendingMessages.get(msg.id);
                        this.pendingMessages.delete(msg.id);
                        msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
                    }
                } catch (e) { }
            });
            ws.on('error', (err) => {
                this.log(`WS Error on ${page.id}: ${err.message}`);
                this.connections.delete(page.id);
                resolve(false);
            });
            ws.on('close', () => {
                this.connections.delete(page.id);
            });
        });
    }

    async injectAndStart(pageId, config) {
        const conn = this.connections.get(pageId);
        if (!conn) return;

        try {
            // 1. Inject core bundle only once
            if (!conn.injected) {
                const script = this.getComposedScript();
                const result = await this.sendCommand(pageId, 'Runtime.evaluate', {
                    expression: script,
                    userGesture: true,
                    awaitPromise: true
                });

                if (result.exceptionDetails) {
                    this.log(`Injection Exception on ${pageId}: ${result.exceptionDetails.text} ${result.exceptionDetails.exception.description}`);
                } else {
                    conn.injected = true;
                    this.log(`Injected core onto ${pageId}`);
                }
            }

            // 2. Start/Update configuration
            if (conn.injected) {
                const res = await this.sendCommand(pageId, 'Runtime.evaluate', {
                    expression: `(function(){
                        const g = (typeof window !== 'undefined') ? window : (typeof globalThis !== 'undefined' ? globalThis : self);
                        if(g && typeof g.__autoAcceptStart === 'function'){
                            g.__autoAcceptStart(${JSON.stringify(config)});
                            return "started";
                        }
                        return "not_found";
                    })()`
                });
                this.log(`Start signal on ${pageId}: ${JSON.stringify(res.result?.value || res)}`);
            }
        } catch (e) {
            this.log(`Failed to start/update on ${pageId}: ${e.message}`);
        }
    }

    getComposedScript() {
        const scriptPath = path.join(__dirname, '..', 'main_scripts', 'full_cdp_script.js');
        return fs.readFileSync(scriptPath, 'utf8');
    }

    sendCommand(pageId, method, params = {}) {
        const conn = this.connections.get(pageId);
        if (!conn || conn.ws.readyState !== WebSocket.OPEN) return Promise.reject('dead');
        const id = this.messageId++;
        return new Promise((resolve, reject) => {
            this.pendingMessages.set(id, { resolve, reject });
            conn.ws.send(JSON.stringify({ id, method, params }));
            setTimeout(() => {
                if (this.pendingMessages.has(id)) {
                    this.pendingMessages.delete(id);
                    reject(new Error('timeout'));
                }
            }, 10000);
        });
    }

    async hideBackgroundOverlay() {
        for (const [pageId] of this.connections) {
            try {
                await this.sendCommand(pageId, 'Runtime.evaluate', {
                    expression: 'if(typeof window !== "undefined" && typeof hideOverlay === "function") hideOverlay()'
                });
            } catch (e) { }
        }
    }

    getConnectionCount() { return this.connections.size; }
    disconnectAll() {
        for (const [, conn] of this.connections) try { conn.ws.close(); } catch (e) { }
        this.connections.clear();
    }
}

module.exports = { CDPHandler };
