/**
 * Antigravity Architecture Investigation
 * 
 * Run this to explore how Antigravity works under the hood
 * Looking for: WebSocket connections, React state, conversation indicators
 */

(function () {
    console.log('=== Antigravity Architecture Investigation ===\n');

    // ===== 1. Find WebSocket connections =====
    console.log('1. WEBSOCKET CONNECTIONS\n');

    // Check for active WebSocket connections
    if (window.WebSocket) {
        const originalWS = window.WebSocket;
        console.log('WebSocket is available');

        // Try to find existing connections by checking common patterns
        const wsProps = Object.getOwnPropertyNames(window).filter(p => {
            try {
                const val = window[p];
                return val && (val instanceof WebSocket ||
                    (val.constructor && val.constructor.name === 'WebSocket'));
            } catch (e) { return false; }
        });
        console.log('Window properties that might be WebSockets:', wsProps);
    }

    // Check performance entries for WebSocket URLs
    const wsEntries = performance.getEntriesByType('resource')
        .filter(e => e.name.includes('ws://') || e.name.includes('wss://'));
    console.log('WebSocket URLs in performance entries:', wsEntries.map(e => e.name));

    // ===== 2. Find React internals =====
    console.log('\n2. REACT INTERNALS\n');

    // Check for React DevTools hook
    if (window.__REACT_DEVTOOLS_GLOBAL_HOOK__) {
        console.log('✅ React DevTools hook found');
        const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
        console.log('React renderers:', Object.keys(hook.renderers || {}));
    }

    // Find React root
    const reactRoot = document.getElementById('root') || document.querySelector('[data-reactroot]');
    if (reactRoot) {
        console.log('React root element found:', reactRoot.id || reactRoot.tagName);

        // Try to access React fiber
        const fiberKey = Object.keys(reactRoot).find(k => k.startsWith('__reactFiber$'));
        if (fiberKey) {
            console.log('✅ React Fiber key found:', fiberKey);
            console.log('(Fiber contains component state - can be explored)');
        }
    }

    // ===== 3. Check Antigravity iframe specifically =====
    console.log('\n3. ANTIGRAVITY IFRAME ANALYSIS\n');

    const agentFrame = document.getElementById('antigravity.agentPanel');
    if (agentFrame) {
        console.log('✅ Antigravity iframe found');
        try {
            const frameDoc = agentFrame.contentDocument;
            const frameWin = agentFrame.contentWindow;

            // Check for global state/store
            const storeKeys = ['__store', '__STORE__', 'store', '__REDUX_STORE__',
                '__APOLLO_CLIENT__', 'apolloClient', '__NEXT_DATA__'];
            storeKeys.forEach(key => {
                if (frameWin[key]) {
                    console.log(`✅ Found global: ${key}`, typeof frameWin[key]);
                }
            });

            // Check for React in iframe
            const iframeReactRoot = frameDoc.getElementById('root') ||
                frameDoc.querySelector('[data-reactroot]') ||
                frameDoc.body.firstElementChild;
            if (iframeReactRoot) {
                const fiberKey = Object.keys(iframeReactRoot).find(k => k.startsWith('__reactFiber$'));
                if (fiberKey) {
                    console.log('✅ React Fiber in iframe found');
                }
            }

            // Look for pending action indicators in conversation list
            console.log('\n--- Conversation List Analysis ---');
            const conversations = frameDoc.querySelectorAll('span');
            const convItems = [];
            conversations.forEach(el => {
                const text = el.textContent?.trim() || '';
                const parent = el.parentElement;
                const grandparent = parent?.parentElement;

                // Look for timestamps (2m, 5m, 2h)
                if (/^\d+[smh]$/.test(text)) {
                    const siblingText = el.previousElementSibling?.textContent?.trim();
                    if (siblingText) {
                        convItems.push({
                            title: siblingText.substring(0, 40),
                            time: text,
                            parentClass: parent?.className || '',
                            hasBadge: !!parent?.querySelector('.badge, .dot, .indicator, [class*="badge"]'),
                            parentStyles: parent ? {
                                bg: getComputedStyle(parent).backgroundColor,
                                border: getComputedStyle(parent).border
                            } : null
                        });
                    }
                }
            });

            if (convItems.length > 0) {
                console.log('Found conversations:');
                console.table(convItems);
            }

        } catch (e) {
            console.log('Cannot access iframe internals:', e.message);
        }
    }

    // ===== 4. Network/Fetch Interception possibilities =====
    console.log('\n4. NETWORK INTERCEPTION\n');

    // Check if fetch is wrapped
    const fetchString = fetch.toString();
    console.log('fetch is native:', fetchString.includes('[native code]'));

    // ===== 5. Look for message passing (postMessage) =====
    console.log('\n5. MESSAGE PASSING\n');

    // Check for message event listeners
    console.log('Tip: You can intercept postMessage by running:');
    console.log(`
    const origPost = window.postMessage;
    window.postMessage = function(...args) {
        console.log('postMessage:', args);
        return origPost.apply(this, args);
    };
    `);

    // ===== 6. Suggestions =====
    console.log('\n=== INVESTIGATION COMPLETE ===\n');
    console.log('Next steps to try:');
    console.log('1. Run WebSocket interceptor (see below)');
    console.log('2. Check if conversation items have visual indicators for pending actions');
    console.log('3. Explore React fiber for state access');

    console.log('\n--- WebSocket Interceptor ---');
    console.log('Run this to capture all WebSocket messages:');
    console.log(`
const OrigWS = window.WebSocket;
window.WebSocket = function(...args) {
    console.log('🔌 New WebSocket:', args[0]);
    const ws = new OrigWS(...args);
    
    const origSend = ws.send.bind(ws);
    ws.send = function(data) {
        console.log('📤 WS Send:', typeof data === 'string' ? JSON.parse(data) : data);
        return origSend(data);
    };
    
    ws.addEventListener('message', (e) => {
        console.log('📥 WS Recv:', typeof e.data === 'string' ? JSON.parse(e.data) : e.data);
    });
    
    return ws;
};
    `);

    return 'Investigation complete - check console output above';
})();
