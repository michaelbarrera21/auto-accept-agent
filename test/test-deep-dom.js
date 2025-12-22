/**
 * Deep DOM Search Test Script
 * Tests multiple approaches to find buttons in Shadow DOM/Hidden/Virtualized elements
 * 
 * Run this in the browser console of Cursor/Antigravity when a button should be visible
 * OR run via node with CDP connection
 * 
 * Usage:
 *   node test-deep-dom.js
 */

const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

// Redirect console output to test_output.txt
const logFile = path.join(__dirname, 'test_output.txt');
const logStream = fs.createWriteStream(logFile, { flags: 'w' });

// Preserve original console functions
const originalLog = console.log;
const originalError = console.error;

// Override console functions to write to both file and stdout
console.log = (...args) => {
    const output = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg, null, 2) : arg).join(' ');
    logStream.write(output + '\n');
    originalLog(...args);
};

console.error = (...args) => {
    const output = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg, null, 2) : arg).join(' ');
    logStream.write('[ERROR] ' + output + '\n');
    originalError(...args);
};

console.log('╔═══════════════════════════════════════════════════════════╗');
console.log('║           Deep DOM Search Test Script                     ║');
console.log('╚═══════════════════════════════════════════════════════════╝\n');

// The comprehensive search script we inject into the browser
const DEEP_SEARCH_SCRIPT = `
(function() {
    'use strict';
    
    const results = {
        approaches: {},
        summary: { total: 0, found: 0, workingApproaches: [] },
        timestamp: Date.now()
    };
    
    // Button patterns to search for
    const BUTTON_PATTERNS = [
        'accept all', 'accept', 'run command', 'run', 'apply', 
        'execute', 'resume', 'try again', 'retry'
    ];
    const EXCLUDED = ['skip', 'reject', 'cancel', 'discard', 'deny', 'close'];
    
    function isButtonText(text) {
        if (!text || text.length === 0 || text.length > 50) return false;
        const lower = text.toLowerCase().trim();
        const matched = BUTTON_PATTERNS.some(p => lower.includes(p));
        const excluded = EXCLUDED.some(p => lower.includes(p));
        return matched && !excluded;
    }
    
    function getElementInfo(el, location) {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return {
            text: el.textContent?.trim().substring(0, 50),
            tag: el.tagName,
            visible: style.display !== 'none' && style.visibility !== 'hidden',
            inViewport: rect.width > 0 && rect.height > 0,
            display: style.display,
            visibility: style.visibility,
            opacity: style.opacity,
            rect: { w: rect.width, h: rect.height, x: rect.x, y: rect.y },
            location: location,
            className: el.className?.toString?.().substring(0, 100) || ''
        };
    }
    
    // ==================== APPROACH 1: Standard DOM ====================
    function approach1_StandardDOM() {
        console.log('[Test] Approach 1: Standard DOM querySelectorAll');
        const found = [];
        const selectors = ['button', '[class*="button"]', '[role="button"]'];
        
        selectors.forEach(sel => {
            document.querySelectorAll(sel).forEach(el => {
                if (isButtonText(el.textContent)) {
                    found.push(getElementInfo(el, 'STANDARD-DOM'));
                }
            });
        });
        
        return { name: 'Standard DOM', found };
    }
    
    // ==================== APPROACH 2: Deep Shadow DOM Traversal ====================
    function approach2_ShadowDOM() {
        console.log('[Test] Approach 2: Shadow DOM Traversal');
        const found = [];
        
        function deepQuerySelectorAll(root, selector, results = []) {
            // Search current root
            try {
                root.querySelectorAll(selector).forEach(el => results.push(el));
            } catch(e) {}
            
            // Search all elements that might have shadow roots
            try {
                root.querySelectorAll('*').forEach(el => {
                    if (el.shadowRoot) {
                        deepQuerySelectorAll(el.shadowRoot, selector, results);
                    }
                });
            } catch(e) {}
            
            return results;
        }
        
        const selectors = ['button', '[class*="button"]', '[role="button"]'];
        selectors.forEach(sel => {
            deepQuerySelectorAll(document, sel).forEach(el => {
                if (isButtonText(el.textContent)) {
                    // Check if this element is inside a shadow root
                    let inShadow = false;
                    let parent = el;
                    while (parent) {
                        if (parent.host) {
                            inShadow = true;
                            break;
                        }
                        parent = parent.parentNode;
                    }
                    found.push(getElementInfo(el, inShadow ? 'SHADOW-DOM' : 'LIGHT-DOM'));
                }
            });
        });
        
        return { name: 'Shadow DOM Traversal', found };
    }
    
    // ==================== APPROACH 3: All Elements Brute Force ====================
    function approach3_BruteForce() {
        console.log('[Test] Approach 3: Brute Force All Elements');
        const found = [];
        
        function walkDOM(node, depth = 0) {
            if (depth > 50) return; // Prevent infinite loops
            
            try {
                // Check this node
                if (node.nodeType === 1) { // Element node
                    const text = node.textContent;
                    if (isButtonText(text)) {
                        // Only add if it's a clickable element
                        const tag = node.tagName?.toLowerCase();
                        if (tag === 'button' || 
                            node.getAttribute?.('role') === 'button' ||
                            node.className?.toString?.().includes('button') ||
                            node.onclick) {
                            found.push(getElementInfo(node, 'BRUTE-FORCE'));
                        }
                    }
                    
                    // Walk children
                    node.childNodes.forEach(child => walkDOM(child, depth + 1));
                    
                    // Walk shadow root if present
                    if (node.shadowRoot) {
                        walkDOM(node.shadowRoot, depth + 1);
                    }
                }
            } catch(e) {}
        }
        
        walkDOM(document.body);
        return { name: 'Brute Force', found };
    }
    
    // ==================== APPROACH 4: TreeWalker API ====================
    function approach4_TreeWalker() {
        console.log('[Test] Approach 4: TreeWalker API');
        const found = [];
        
        function walkWithTreeWalker(root) {
            const walker = document.createTreeWalker(
                root,
                NodeFilter.SHOW_ELEMENT,
                {
                    acceptNode: (node) => {
                        if (isButtonText(node.textContent) && 
                            (node.tagName === 'BUTTON' || 
                             node.getAttribute?.('role') === 'button' ||
                             node.className?.toString?.().includes('button'))) {
                            return NodeFilter.FILTER_ACCEPT;
                        }
                        return NodeFilter.FILTER_SKIP;
                    }
                }
            );
            
            let node;
            while (node = walker.nextNode()) {
                found.push(getElementInfo(node, 'TREEWALKER'));
            }
            
            // Also check shadow roots
            const allElements = root.querySelectorAll('*');
            allElements.forEach(el => {
                if (el.shadowRoot) {
                    walkWithTreeWalker(el.shadowRoot);
                }
            });
        }
        
        walkWithTreeWalker(document);
        return { name: 'TreeWalker', found };
    }
    
    // ==================== APPROACH 5: Input Box Sibling Search ====================
    function approach5_InputBoxContext() {
        console.log('[Test] Approach 5: Input Box Context Search');
        const found = [];
        
        // Find the input box
        const inputBox = document.querySelector('div.full-input-box');
        if (!inputBox) {
            return { name: 'Input Box Context', found, note: 'No input box found' };
        }
        
        // Search siblings and their shadow roots
        let sibling = inputBox.previousElementSibling;
        let count = 0;
        while (sibling && count < 10) {
            // Search light DOM
            sibling.querySelectorAll('button, [class*="button"]').forEach(el => {
                if (isButtonText(el.textContent)) {
                    found.push(getElementInfo(el, 'INPUT-SIBLING'));
                }
            });
            
            // Search shadow roots within sibling
            sibling.querySelectorAll('*').forEach(el => {
                if (el.shadowRoot) {
                    el.shadowRoot.querySelectorAll('button, [class*="button"]').forEach(btn => {
                        if (isButtonText(btn.textContent)) {
                            found.push(getElementInfo(btn, 'INPUT-SIBLING-SHADOW'));
                        }
                    });
                }
            });
            
            sibling = sibling.previousElementSibling;
            count++;
        }
        
        return { name: 'Input Box Context', found };
    }
    
    // ==================== APPROACH 6: ARIA/Role-based Search ====================
    function approach6_ARIA() {
        console.log('[Test] Approach 6: ARIA/Role-based Search');
        const found = [];
        
        function deepARIA(root) {
            try {
                root.querySelectorAll('[role="button"], [aria-label*="accept" i], [aria-label*="run" i], [aria-label*="apply" i]').forEach(el => {
                    if (isButtonText(el.textContent) || isButtonText(el.getAttribute('aria-label'))) {
                        found.push(getElementInfo(el, 'ARIA'));
                    }
                });
                
                root.querySelectorAll('*').forEach(el => {
                    if (el.shadowRoot) deepARIA(el.shadowRoot);
                });
            } catch(e) {}
        }
        
        deepARIA(document);
        return { name: 'ARIA/Role', found };
    }
    
    // ==================== RUN ALL APPROACHES ====================
    const approaches = [
        approach1_StandardDOM,
        approach2_ShadowDOM,
        approach3_BruteForce,
        approach4_TreeWalker,
        approach5_InputBoxContext,
        approach6_ARIA
    ];
    
    approaches.forEach((fn, i) => {
        try {
            const result = fn();
            results.approaches[result.name] = result;
            results.summary.total++;
            if (result.found.length > 0) {
                results.summary.found++;
                results.summary.workingApproaches.push(result.name);
            }
            console.log('[Test] ' + result.name + ': ' + result.found.length + ' buttons found');
        } catch(e) {
            console.error('[Test] Approach ' + (i+1) + ' failed:', e.message);
        }
    });
    
    // ==================== SUMMARY ====================
    console.log('\\n[Test] ========== SUMMARY ==========');
    console.log('[Test] Total approaches: ' + results.summary.total);
    console.log('[Test] Approaches with results: ' + results.summary.found);
    console.log('[Test] Working approaches: ' + results.summary.workingApproaches.join(', '));
    
    // Deduplicate and show unique buttons
    const uniqueButtons = new Map();
    Object.values(results.approaches).forEach(approach => {
        approach.found.forEach(btn => {
            const key = btn.text + '|' + btn.className;
            if (!uniqueButtons.has(key)) {
                uniqueButtons.set(key, btn);
            }
        });
    });
    
    results.uniqueButtons = Array.from(uniqueButtons.values());
    console.log('[Test] Total unique buttons: ' + results.uniqueButtons.length);
    results.uniqueButtons.forEach((btn, i) => {
        console.log('[Test]   [' + i + '] "' + btn.text + '" [' + btn.location + '] visible=' + btn.visible + ' inViewport=' + btn.inViewport);
    });
    
    return results;
})();
`;

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

async function runTest() {
    // Find CDP port
    for (let port = 9222; port <= 9232; port++) {
        const pages = await getPages(port);
        const page = pages.find(p => p.webSocketDebuggerUrl);
        if (!page) continue;

        console.log(`\n📡 Connecting to CDP on port ${port}...`);
        console.log(`   Page: ${page.title || page.url}`);

        const ws = new WebSocket(page.webSocketDebuggerUrl);

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                ws.close();
                reject(new Error('Timeout'));
            }, 30000);

            ws.on('open', () => {
                console.log('✅ Connected! Injecting test script...\n');
                ws.send(JSON.stringify({
                    id: 1,
                    method: "Runtime.evaluate",
                    params: {
                        expression: DEEP_SEARCH_SCRIPT,
                        returnByValue: true
                    }
                }));
            });

            ws.on('message', (data) => {
                const response = JSON.parse(data);
                if (response.id === 1) {
                    clearTimeout(timeout);

                    const results = response.result?.result?.value;
                    if (results) {
                        console.log('\n╔═══════════════════════════════════════════════════════════╗');
                        console.log('║                    TEST RESULTS                           ║');
                        console.log('╠═══════════════════════════════════════════════════════════╣');

                        Object.entries(results.approaches).forEach(([name, approach]) => {
                            const status = approach.found.length > 0 ? '✅' : '❌';
                            console.log(`║ ${status} ${name.padEnd(25)} ${approach.found.length} buttons`);
                        });

                        console.log('╠═══════════════════════════════════════════════════════════╣');
                        console.log(`║ Working approaches: ${results.summary.workingApproaches.join(', ') || 'None'}`);
                        console.log(`║ Unique buttons found: ${results.uniqueButtons.length}`);
                        console.log('╚═══════════════════════════════════════════════════════════╝');

                        if (results.uniqueButtons.length > 0) {
                            console.log('\n📍 Found Buttons:');
                            results.uniqueButtons.forEach((btn, i) => {
                                console.log(`   [${i}] "${btn.text}" [${btn.location}]`);
                                console.log(`       visible=${btn.visible}, inViewport=${btn.inViewport}`);
                            });
                        }

                        // Recommendation
                        console.log('\n💡 RECOMMENDATION:');
                        if (results.summary.workingApproaches.length > 0) {
                            const best = results.summary.workingApproaches[0];
                            console.log(`   Best approach: "${best}"`);
                            console.log('   → Update cdp-handler.js to use this approach');
                        } else {
                            console.log('   No buttons found - this may indicate:');
                            console.log('   • Virtualization (buttons not in DOM)');
                            console.log('   • Closed Shadow DOM (not accessible)');
                            console.log('   • Wrong timing (buttons not rendered yet)');
                        }

                        resolve(results);
                    } else {
                        console.log('❌ No results returned');
                        console.log('Response:', JSON.stringify(response, null, 2));
                        reject(new Error('No results'));
                    }

                    ws.close();
                }
            });

            ws.on('error', (err) => {
                clearTimeout(timeout);
                reject(err);
            });
        });
    }

    throw new Error('No CDP endpoint found. Make sure Cursor/Antigravity is running with --remote-debugging-port=9222');
}

runTest()
    .then(() => {
        console.log('\n✅ Test complete.');
        process.exit(0);
    })
    .catch(err => {
        console.error('\n❌ Test failed:', err.message);
        process.exit(1);
    });
