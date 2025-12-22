/**
 * Background Deep Accept Verification Script v2
 * 
 * More strict matching - only finds ACTUAL action buttons
 * Run when an "Accept" or "Run" button is visible in a conversation
 */

(function () {
    console.log('=== Background Deep Accept Verification v2 ===\n');

    // STRICT patterns - exact matches only for main keywords
    const EXACT_PATTERNS = ['accept', 'run', 'apply', 'execute', 'resume', 'retry'];
    const CONTAINS_PATTERNS = ['accept all', 'run command', 'try again'];
    const EXCLUDE_PATTERNS = ['skip', 'reject', 'cancel', 'discard', 'deny', 'close', 'other', 'auto-accept', 'see all'];
    const BUTTON_SELECTORS = ['button', '[role="button"]', 'div[class*="button"]'];

    // Strict check for actual action buttons
    function isRealActionButton(el) {
        if (!el || !el.textContent) return false;

        const text = el.textContent.toLowerCase().trim();

        // Skip if too short or too long (action buttons are short)
        if (text.length < 2 || text.length > 25) return false;

        // Skip if has numbers/timestamps (likely conversation title)
        if (/\d+[smh]$/.test(text)) return false;

        // Skip excluded patterns
        if (EXCLUDE_PATTERNS.some(p => text.includes(p))) return false;

        // Check for exact match
        const isExact = EXACT_PATTERNS.includes(text);

        // Check for contains match (for multi-word)
        const isContains = CONTAINS_PATTERNS.some(p => text === p);

        if (!isExact && !isContains) return false;

        // Additional checks - must be a clickable element
        const tag = el.tagName.toLowerCase();
        const role = el.getAttribute('role');
        const className = el.className?.toString() || '';

        // Prefer actual buttons or button-role elements
        const isButtonElement = tag === 'button' || role === 'button' ||
            className.includes('button') || className.includes('btn');

        // Skip if disabled
        if (el.disabled || el.hasAttribute('disabled')) return false;

        // Skip if it's a link/navigation element
        if (tag === 'a' && !className.includes('button')) return false;

        return isButtonElement;
    }

    function findRealButtons(root, sourceName) {
        const buttons = [];
        const seen = new Set();

        BUTTON_SELECTORS.forEach(selector => {
            try {
                root.querySelectorAll(selector).forEach(el => {
                    if (seen.has(el)) return;
                    seen.add(el);

                    if (isRealActionButton(el)) {
                        const rect = el.getBoundingClientRect();
                        buttons.push({
                            text: el.textContent.trim(),
                            tag: el.tagName,
                            source: sourceName,
                            visible: rect.width > 0 && rect.height > 0,
                            position: `${Math.round(rect.x)},${Math.round(rect.y)}`,
                            className: el.className?.toString()?.substring(0, 50) || '',
                            // For clicking test
                            element: el
                        });
                    }
                });
            } catch (e) { }
        });
        return buttons;
    }

    let allButtons = [];

    // Search main document
    console.log('Searching main document...');
    const mainDocButtons = findRealButtons(document, 'MAIN-DOC');
    allButtons = allButtons.concat(mainDocButtons);
    console.log(`  Found ${mainDocButtons.length} buttons`);

    // Search Antigravity iframe
    const agentFrame = document.getElementById('antigravity.agentPanel');
    if (agentFrame) {
        try {
            const frameDoc = agentFrame.contentDocument || agentFrame.contentWindow.document;
            if (frameDoc) {
                console.log('Searching Antigravity iframe...');
                const iframeButtons = findRealButtons(frameDoc, 'IFRAME');
                allButtons = allButtons.concat(iframeButtons);
                console.log(`  Found ${iframeButtons.length} buttons`);
            }
        } catch (e) {
            console.log('Cannot access Antigravity iframe:', e.message);
        }
    }

    // Also search all iframes (in case there are nested ones)
    document.querySelectorAll('iframe').forEach((frame, idx) => {
        if (frame.id === 'antigravity.agentPanel') return; // Already searched
        try {
            const frameDoc = frame.contentDocument || frame.contentWindow.document;
            if (frameDoc) {
                console.log(`Searching iframe ${idx} (${frame.id || 'unnamed'})...`);
                const buttons = findRealButtons(frameDoc, `IFRAME-${idx}`);
                if (buttons.length > 0) {
                    console.log(`  Found ${buttons.length} buttons`);
                    allButtons = allButtons.concat(buttons);
                }
            }
        } catch (e) { }
    });

    console.log('\n=== RESULTS ===\n');
    console.log(`Total REAL action buttons found: ${allButtons.length}`);

    if (allButtons.length > 0) {
        console.log('\n✅ Found action buttons:');
        console.table(allButtons.map(b => ({
            text: b.text,
            source: b.source,
            visible: b.visible,
            position: b.position,
            class: b.className
        })));

        // Provide click test function
        console.log('\nTo test clicking the first button, run:');
        console.log('  window.__testButtons[0].element.click()');
        window.__testButtons = allButtons;
    } else {
        console.log('\n⚠️ No real action buttons found.');
        console.log('\nMake sure:');
        console.log('  1. You have an active agent task');
        console.log('  2. An "Accept" or "Run" button is VISIBLE on screen');
        console.log('  3. The button text matches exactly (e.g., "Accept", "Run")');
    }

    return allButtons;
})();
