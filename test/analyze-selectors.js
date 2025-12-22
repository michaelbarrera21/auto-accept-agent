/**
 * DOM Selector Analysis for Antigravity
 * 
 * Run this in DevTools to find exact selectors for:
 * 1. Conversation tabs (before "See all")
 * 2. Accept/Run buttons
 */

(function () {
    console.log('=== Antigravity DOM Analysis ===\n');

    const agentFrame = document.getElementById('antigravity.agentPanel');
    if (!agentFrame) {
        console.log('❌ Antigravity iframe not found');
        return;
    }

    let frameDoc;
    try {
        frameDoc = agentFrame.contentDocument || agentFrame.contentWindow.document;
    } catch (e) {
        console.log('❌ Cannot access iframe:', e.message);
        return;
    }

    console.log('✅ Antigravity iframe accessible\n');

    // === 1. Find conversation list items ===
    console.log('=== CONVERSATION LIST ===\n');

    // Look for clickable elements that could be conversation tabs
    // Based on screenshot: they have title + timestamp
    const clickables = frameDoc.querySelectorAll('a, div[role="button"], button, [onclick], [class*="clickable"], [class*="cursor-pointer"]');
    console.log(`Found ${clickables.length} clickable elements`);

    // Look for elements with timestamps (2m, 5m, 2h pattern)
    const allElements = frameDoc.querySelectorAll('*');
    const convCandidates = [];

    allElements.forEach(el => {
        const text = el.textContent?.trim() || '';
        // Match timestamp pattern at end
        if (/\d+[smh]$/.test(text) && text.length < 80) {
            const rect = el.getBoundingClientRect();
            convCandidates.push({
                tag: el.tagName,
                class: el.className?.toString()?.substring(0, 60) || '',
                text: text.substring(0, 50),
                y: Math.round(rect.y),
                parent: el.parentElement?.tagName,
                parentClass: el.parentElement?.className?.toString()?.substring(0, 40) || ''
            });
        }
    });

    console.log('Elements with timestamps (potential conversation items):');
    console.table(convCandidates);

    // === 2. Find "See all" button ===
    console.log('\n=== SEE ALL BUTTON ===\n');

    const seeAllCandidates = [];
    allElements.forEach(el => {
        const text = el.textContent?.toLowerCase().trim() || '';
        if (text === 'see all' || text.includes('see all')) {
            seeAllCandidates.push({
                tag: el.tagName,
                class: el.className?.toString() || '',
                text: el.textContent.trim()
            });
        }
    });
    console.log('See all buttons:');
    console.table(seeAllCandidates);

    // === 3. Look for specific class patterns ===
    console.log('\n=== CLASS PATTERNS ===\n');

    // Common patterns to look for
    const patterns = ['conversation', 'chat', 'thread', 'message', 'task', 'history'];
    patterns.forEach(pattern => {
        const matches = frameDoc.querySelectorAll(`[class*="${pattern}"]`);
        if (matches.length > 0) {
            console.log(`[class*="${pattern}"]: ${matches.length} elements`);
        }
    });

    // === 4. Find buttons with accept/run text ===
    console.log('\n=== ACCEPT/RUN BUTTONS ===\n');

    const buttons = frameDoc.querySelectorAll('button, [role="button"]');
    const actionButtons = [];

    buttons.forEach(btn => {
        const text = btn.textContent?.toLowerCase().trim() || '';
        if (['accept', 'run', 'apply', 'execute', 'retry'].some(p => text === p)) {
            actionButtons.push({
                tag: btn.tagName,
                class: btn.className?.toString()?.substring(0, 60) || '',
                text: btn.textContent.trim(),
                visible: btn.offsetWidth > 0
            });
        }
    });

    console.log('Action buttons:');
    console.table(actionButtons);

    // === 5. Check structure around conversation items ===
    console.log('\n=== STRUCTURE ANALYSIS ===\n');

    // Get first conversation candidate and trace its structure
    if (convCandidates.length > 0) {
        const firstConv = convCandidates[0];
        console.log('Sample conversation item structure:');
        console.log(`  Tag: ${firstConv.tag}`);
        console.log(`  Class: ${firstConv.class}`);
        console.log(`  Parent: ${firstConv.parent}.${firstConv.parentClass}`);
    }

    // === 6. Return clickable selectors for conversation tabs ===
    console.log('\n=== RECOMMENDED SELECTORS ===\n');
    console.log('Based on analysis, try these selectors:');
    console.log('1. Conversation tabs: [look for parent elements of timestamp spans]');
    console.log('2. Accept buttons: button, [role="button"] with exact text match');

    return {
        conversationCandidates: convCandidates,
        seeAllButtons: seeAllCandidates,
        actionButtons: actionButtons
    };
})();
