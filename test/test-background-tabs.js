const WebSocket = require('ws');
const http = require('http');

console.log('=== Feasibility Test: Background Tab Elements ===');
console.log('Ensure you have a Cursor window open with a BACKGROUND tab containing a pending "Run Command" or "Accept" button.');

async function getPages(port) {
    return new Promise((resolve) => {
        http.get(`http://127.0.0.1:${port}/json/list`, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); } catch { resolve([]); }
            });
        }).on('error', () => resolve([]));
    });
}

// The core logic to run inside the browser
const INJECTED_SCRIPT = `
(function() {
    const buttons = [];
    const keywords = ['run command', 'accept', 'apply'];
    
    // 1. Scan ALL buttons
    const allElements = document.querySelectorAll('button, div[class*="button"]');
    
    allElements.forEach(el => {
        const text = el.textContent ? el.textContent.toLowerCase().trim() : '';
        if (!text || text.length > 30) return;
        
        // Check if interesting
        const isInteresting = keywords.some(k => text.includes(k));
        if (!isInteresting) return;
        
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        
        // Find parent 'tab' or container to guess context
        let parent = el.parentElement;
        let containerInfo = 'unknown';
        while(parent && parent !== document.body) {
            if (parent.className && typeof parent.className === 'string') {
                 if (parent.className.includes('pane') || parent.className.includes('tab') || parent.className.includes('editor')) {
                     containerInfo = parent.className.substring(0, 50);
                     // Keep going to find top container
                 }
            }
            parent = parent.parentElement;
        }

        buttons.push({
            text: text,
            visible: (style.display !== 'none' && style.visibility !== 'hidden'),
            display: style.display,
            visibility: style.visibility,
            opacity: style.opacity,
            width: rect.width,
            height: rect.height,
            x: rect.x,
            y: rect.y,
            container: containerInfo,
            html: el.outerHTML.substring(0, 100)
        });
    });
    
    return buttons;
})()
`;

async function run() {
    // Scan ports
    for (let port = 9222; port <= 9232; port++) {
        const pages = await getPages(port);
        const page = pages.find(p => p.webSocketDebuggerUrl);
        if (!page) continue;

        console.log(`\nConnecting to Cursor on port ${port}...`);
        const ws = new WebSocket(page.webSocketDebuggerUrl);

        ws.on('open', () => {
            const id = 1;
            ws.send(JSON.stringify({
                id: id,
                method: "Runtime.evaluate",
                params: {
                    expression: INJECTED_SCRIPT,
                    returnByValue: true
                }
            }));
        });

        ws.on('message', (data) => {
            const response = JSON.parse(data);
            if (response.id === 1) {
                const buttons = response.result.result.value || [];
                console.log(`Found ${buttons.length} potential buttons:\n`);

                buttons.forEach((b, i) => {
                    console.log(`[${i}] "${b.text}"`);
                    console.log(`    Visible: ${b.visible}`);
                    console.log(`    Props: display=${b.display}, visibility=${b.visibility}, size=${b.width}x${b.height}`);
                    console.log(`    Container: ${b.container}`);
                    console.log('-----------------------------------');
                });

                ws.close();
                process.exit(0);
            }
        });
    }
}

run();
