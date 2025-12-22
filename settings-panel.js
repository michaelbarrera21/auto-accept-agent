const vscode = require('vscode');
const { STRIPE_LINKS } = require('./config');

const LICENSE_API = 'https://auto-accept-backend.onrender.com/api';

class SettingsPanel {
    static currentPanel = undefined;
    static viewType = 'autoAcceptSettings';

    static createOrShow(extensionUri, context, mode = 'settings') {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        // If we already have a panel, show it.
        if (SettingsPanel.currentPanel) {
            // If requesting prompt mode but panel is open, reveal it and update mode
            SettingsPanel.currentPanel.panel.reveal(column);
            SettingsPanel.currentPanel.updateMode(mode);
            return;
        }

        // Otherwise, create a new panel.
        const panel = vscode.window.createWebviewPanel(
            SettingsPanel.viewType,
            mode === 'prompt' ? 'Auto Accept Agent' : 'Auto Accept Settings',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
                retainContextWhenHidden: true
            }
        );

        SettingsPanel.currentPanel = new SettingsPanel(panel, extensionUri, context, mode);
    }

    static showUpgradePrompt(context) {
        SettingsPanel.createOrShow(context.extensionUri, context, 'prompt');
    }

    constructor(panel, extensionUri, context, mode) {
        this.panel = panel;
        this.extensionUri = extensionUri;
        this.context = context;
        this.mode = mode; // 'settings' | 'prompt'
        this.disposables = [];

        this.update();

        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

        this.panel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.command) {
                    case 'setFrequency':
                        if (this.isPro()) {
                            await this.context.globalState.update('auto-accept-frequency', message.value);
                            vscode.commands.executeCommand('auto-accept.updateFrequency', message.value);
                        }
                        break;
                    case 'getStats':
                        this.sendStats();
                        break;
                    case 'resetStats':
                        if (this.isPro()) {
                            await this.context.globalState.update('auto-accept-stats', {
                                clicks: 0,
                                sessions: 0,
                                lastSession: null
                            });
                            this.sendStats();
                        }
                        break;
                    case 'upgrade':
                        // Existing upgrade logic (maybe from Settings mode)
                        // For prompt mode, links are direct <a> tags usually, but if we need logic:
                        this.openUpgrade(message.promoCode); // Keeps existing logic for legacy/settings
                        this.startPolling(this.getUserId());
                        break;
                    case 'checkPro':
                        this.handleCheckPro();
                        break;
                    case 'dismissPrompt':
                        await this.handleDismiss();
                        break;
                }
            },
            null,
            this.disposables
        );
    }

    async handleDismiss() {
        // Persist dismissal timestamp
        const now = Date.now();
        await this.context.globalState.update('auto-accept-lastDismissedAt', now);
        this.dispose();
    }

    async handleCheckPro() {
        const isPro = await this.checkProStatus(this.getUserId());
        if (isPro) {
            await this.context.globalState.update('auto-accept-isPro', true);
            vscode.window.showInformationMessage('Auto Accept: Pro status verified!');
            this.update();
        } else {
            // New: Downgrade logic if check fails (e.g. subscription cancelled)
            await this.context.globalState.update('auto-accept-isPro', false);
            vscode.window.showWarningMessage('Pro license not found. Standard limits applied.');
            this.update();
        }
    }

    isPro() {
        return this.context.globalState.get('auto-accept-isPro', false);
    }

    getUserId() {
        let userId = this.context.globalState.get('auto-accept-userId');
        if (!userId) {
            // Generate UUID v4 format
            userId = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
                const r = Math.random() * 16 | 0;
                const v = c === 'x' ? r : (r & 0x3 | 0x8);
                return v.toString(16);
            });
            this.context.globalState.update('auto-accept-userId', userId);
        }
        return userId;
    }

    openUpgrade(promoCode) {
        // Fallback legacy method or used by Settings
        // We might not need this if we use direct links, but keeping for compatibility
    }

    updateMode(mode) {
        this.mode = mode;
        this.panel.title = mode === 'prompt' ? 'Auto Accept Agent' : 'Auto Accept Settings';
        this.update();
    }

    sendStats() {
        const stats = this.context.globalState.get('auto-accept-stats', {
            clicks: 0,
            sessions: 0,
            lastSession: null
        });
        const isPro = this.isPro();
        // If not Pro, force display of 300ms
        const frequency = isPro ? this.context.globalState.get('auto-accept-frequency', 1000) : 300;

        this.panel.webview.postMessage({
            command: 'updateStats',
            stats,
            frequency,
            isPro
        });
    }

    update() {
        this.panel.webview.html = this.getHtmlContent();
        setTimeout(() => this.sendStats(), 100);
    }

    getHtmlContent() {
        const isPro = this.isPro();
        const isPrompt = this.mode === 'prompt';
        const stripeLinks = STRIPE_LINKS; // { MONTHLY, YEARLY }

        // Common CSS
        const css = `
            :root {
                --bg-color: var(--vscode-editor-background);
                --fg-color: var(--vscode-editor-foreground);
                --accent: #9333ea;
                --border: var(--vscode-widget-border);
            }
            body {
                font-family: var(--vscode-font-family);
                background: var(--bg-color);
                color: var(--fg-color);
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                min-height: 100vh;
                margin: 0;
                padding: 20px;
            }
            .container {
                max-width: ${isPrompt ? '500px' : '600px'};
                width: 100%;
            }
            .btn-primary {
                background: var(--accent);
                color: white;
                border: none;
                padding: 12px;
                width: 100%;
                border-radius: 6px;
                font-weight: 600;
                cursor: pointer;
                text-decoration: none;
                display: block;
                text-align: center;
                box-sizing: border-box;
                margin-top: 10px;
            }
            .btn-primary:hover {
                opacity: 0.9;
            }
            .link-secondary {
                color: var(--vscode-textLink-foreground);
                cursor: pointer;
                text-decoration: none;
                font-size: 13px;
                display: block;
                text-align: center;
                margin-top: 16px;
            }
            .link-secondary:hover { text-decoration: underline; }
            
            /* Prompt Specific */
            .prompt-card {
                background: var(--vscode-sideBar-background);
                border: 1px solid var(--border);
                border-radius: 8px;
                padding: 32px;
                text-align: center;
                box-shadow: 0 4px 20px rgba(0,0,0,0.3);
            }
            .prompt-title { font-size: 18px; font-weight: 600; margin-bottom: 12px; }
            .prompt-text { font-size: 14px; opacity: 0.8; line-height: 1.5; margin-bottom: 24px; }

            /* Settings Specific */
            .settings-card { /* ... existing styles condensed ... */ }
        `;

        if (isPrompt) {
            return `<!DOCTYPE html>
            <html>
            <head><style>${css}</style></head>
            <body>
                <div class="container">
                    <div class="prompt-card">
                        <div class="prompt-title">Agent appears stuck</div>
                        <div class="prompt-text">
                            Cursor's auto-accept rules failed to continue execution.<br/><br/>
                            Auto Accept Pro can automatically recover stalled agents so you don't have to babysit them.
                        </div>
                        <a href="${stripeLinks.MONTHLY}" class="btn-primary">
                            🔓 Enable Resilient Mode (Pro) - $5/mo
                        </a>
                        <a href="${stripeLinks.YEARLY}" class="btn-primary" style="background: transparent; border: 1px solid var(--border); margin-top: 8px;">
                            Or $29/year (Save 50%)
                        </a>

                        <a class="link-secondary" onclick="dismiss()">
                            Keep waiting (agent remains paused)
                        </a>
                    </div>
                    <div style="font-size: 11px; opacity: 0.5; margin-top: 20px; text-align: center;">
                        User ID: ${this.getUserId()}
                    </div>
                </div>
                <script>
                    const vscode = acquireVsCodeApi();
                    function dismiss() {
                        vscode.postMessage({ command: 'dismissPrompt' });
                    }
                </script>
            </body>
            </html>`;
        }

        // Settings Mode (Legacy/Existing but cleaner)
        // I will essentially recreate a simplified version of the old HTML for 'settings' mode
        // referencing the config links.
        return `<!DOCTYPE html>
        <html>
        <head>
            <style>${css}</style>
            <style>
                .settings-header { text-align: center; margin-bottom: 30px; }
                .settings-section { background: rgba(255,255,255,0.03); padding: 20px; border-radius: 8px; margin-bottom: 20px; }
                label { display: block; margin-bottom: 8px; font-size: 12px; font-weight: 600; opacity: 0.7; }
                input[type=range] { width: 100%; }
                .val-display { float: right; font-family: monospace; }
                .pro-badge { background: var(--accent); color: white; padding: 2px 6px; border-radius: 4px; font-size: 10px; }
                .locked { opacity: 0.5; pointer-events: none; }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="settings-header">
                    <h1>Auto Accept ${isPro ? '<span class="pro-badge">PRO</span>' : ''}</h1>
                    <div style="opacity: 0.7">Automate your AI workflow</div>
                </div>

                ${!isPro ? `
                <div class="settings-section" style="border: 1px solid var(--accent);">
                    <div style="font-weight: 600; margin-bottom: 8px;">
                        Upgrade to Pro
                    </div>

                    <div style="font-size: 13px; margin-bottom: 12px; opacity: 0.9;">
                        Run AI agents without babysitting.
                    </div>

                    <div style="font-size: 13px; margin-bottom: 16px; opacity: 0.8;">
                        • Accept actions in background conversations — no tab watching<br/>
                        • Works across multiple Cursor / Antigravity windows<br/>
                        • Faster, configurable accept speed<br/>
                        • Automatically handles stuck or pending agent actions
                    </div>

                    <a href="${stripeLinks.MONTHLY}" class="btn-primary">
                        Subscribe Monthly — $5/month
                    </a>

                    <a href="${stripeLinks.YEARLY}" class="btn-primary"
                        style="background: transparent; border: 1px solid var(--border);">
                        Subscribe Yearly — $29/year
                    </a>

                    <div class="link-secondary" id="checkStatusBtn">
                        Already paid? Check status
                    </div>
                </div>

                ` : ''}

                <div class="settings-section">
                    <label>POLLING FREQUENCY <span class="val-display" id="freqVal">...</span></label>
                    <div class="${!isPro ? 'locked' : ''}">
                        <input type="range" id="freqSlider" min="200" max="3000" step="100" value="1000">
                    </div>
                    ${!isPro ? '<div style="font-size: 11px; margin-top: 4px; color: var(--accent);">⚠ Upgrade to adjust speed</div>' : ''}
                </div>

                 <div class="settings-section">
                    <label>ANALYTICS</label>
                    <div style="display: flex; justify-content: space-between; margin-top: 10px;">
                        <div>
                            <div style="font-size: 24px" id="clickCount">0</div>
                            <div style="font-size: 11px; opacity: 0.6">Clicks</div>
                        </div>
                        <div>
                            <div style="font-size: 24px" id="sessionCount">0</div>
                            <div style="font-size: 11px; opacity: 0.6">Sessions</div>
                        </div>
                    </div>
                </div>

                <div style="text-align: center; font-size: 11px; opacity: 0.4; margin-top: 40px;">
                    ID: ${this.getUserId()}
                </div>
            </div>

            <script>
                const vscode = acquireVsCodeApi();
                
                // ... Simple event listeners for slider, check status ...
                document.getElementById('checkStatusBtn')?.addEventListener('click', () => {
                    const el = document.getElementById('checkStatusBtn');
                    el.innerText = 'Checking...';
                    vscode.postMessage({ command: 'checkPro' });
                });

                const slider = document.getElementById('freqSlider');
                const valDisplay = document.getElementById('freqVal');
                
                if (slider) {
                    slider.addEventListener('input', (e) => {
                         valDisplay.innerText = (e.target.value/1000) + 's';
                         vscode.postMessage({ command: 'setFrequency', value: e.target.value });
                    });
                }
                
                window.addEventListener('message', e => {
                    const msg = e.data;
                    if (msg.command === 'updateStats') {
                        document.getElementById('clickCount').innerText = msg.stats.clicks;
                        document.getElementById('sessionCount').innerText = msg.stats.sessions;
                        if (slider && !${!isPro}) { // Only update slider if Pro (enabled)
                            slider.value = msg.frequency;
                            valDisplay.innerText = (msg.frequency/1000) + 's';
                        }
                        if (${!isPro}) {
                            valDisplay.innerText = '0.3s (Fixed)';
                        }
                    }
                });

                vscode.postMessage({ command: 'getStats' });
            </script>
        </body>
        </html>`;
    }

    dispose() {
        SettingsPanel.currentPanel = undefined;
        if (this.pollTimer) clearInterval(this.pollTimer);
        this.panel.dispose();
        while (this.disposables.length) {
            const d = this.disposables.pop();
            if (d) d.dispose();
        }
    }

    async checkProStatus(userId) {
        return new Promise((resolve) => {
            const https = require('https');
            https.get(`${LICENSE_API}/verify?userId=${userId}`, (res) => {
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

    startPolling(userId) {
        // Poll every 5s for 5 minutes
        let attempts = 0;
        const maxAttempts = 60;

        if (this.pollTimer) clearInterval(this.pollTimer);

        this.pollTimer = setInterval(async () => {
            attempts++;
            if (attempts > maxAttempts) {
                clearInterval(this.pollTimer);
                return;
            }

            const isPro = await this.checkProStatus(userId);
            if (isPro) {
                clearInterval(this.pollTimer);
                await this.context.globalState.update('auto-accept-isPro', true);
                vscode.window.showInformationMessage('Auto Accept: Pro status verified! Thank you for your support.');
                this.update(); // Refresh UI
                vscode.commands.executeCommand('auto-accept.updateFrequency', 1000);
            }
        }, 5000);
    }
}

module.exports = { SettingsPanel };
