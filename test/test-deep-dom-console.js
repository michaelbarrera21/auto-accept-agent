// ============================================
// DEEP DOM SEARCH TEST - BROWSER CONSOLE SCRIPT
// ============================================
// INSTRUCTIONS:
// 1. Open Cursor/Antigravity
// 2. Press Ctrl+Shift+I to open DevTools
// 3. Go to Console tab
// 4. Paste this entire script and press Enter
// 5. Results will appear in the console
// ============================================

(function () {
    'use strict';

    console.clear();
    console.log('%c╔═══════════════════════════════════════════════════════════╗', 'color: cyan');
    console.log('%c║           Deep DOM Search Test Script                     ║', 'color: cyan');
    console.log('%c╚═══════════════════════════════════════════════════════════╝', 'color: cyan');

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
        if (!text || text.length === 0 || text.length > 30) return false; // Shorter max length
        const lower = text.toLowerCase().trim();

        // More restrictive patterns - prefer exact or near-exact matches
        const patterns = [
            { p: 'accept all', exact: false },
            { p: 'accept', exact: true },      // EXACT - avoid 'auto-accept'
            { p: 'run command', exact: false },
            { p: 'run', exact: true },         // EXACT - avoid 'Run' menu
            { p: 'apply', exact: true },
            { p: 'execute', exact: true },
            { p: 'resume', exact: true },
            { p: 'retry', exact: true },
            { p: 'try again', exact: false }
        ];

        const matched = patterns.some(({ p, exact }) =>
            exact ? (lower === p) : lower.includes(p)
        );
        const excluded = EXCLUDED.some(p => lower.includes(p));
        return matched && !excluded;
    }

    function isValidButtonElement(el) {
        // Exclude IDE chrome by class
        const className = el.className?.toString?.() || '';
        const excludedClasses = [
            'menubar', 'statusbar', 'tab-label', 'monaco-list',
            'command', 'codicon', 'action-label', 'badge', 'quick-input',
            // File explorer / panes
            'pane-header', 'explorer', 'monaco-icon-label', 'folder-icon',
            'file-icon', 'title', 'tree-', 'list-row'
        ];
        if (excludedClasses.some(c => className.includes(c))) return false;

        // Exclude by tag - H1-H6 are typically headers, not buttons
        const tag = el.tagName;
        if (['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'LI'].includes(tag)) return false;

        // Exclude by ancestor
        let ancestor = el.parentElement;
        let depth = 0;
        while (ancestor && depth < 10) {
            const ancestorClass = ancestor.className?.toString?.() || '';
            if (['menubar', 'statusbar', 'tabs-container', 'quick-input',
                'explorer', 'pane-body', 'sidebar'].some(c => ancestorClass.includes(c))) {
                return false;
            }
            ancestor = ancestor.parentElement;
            depth++;
        }
        return true;
    }

    function getElementInfo(el, location) {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return {
            text: el.textContent?.trim().substring(0, 50),
            tag: el.tagName,
            visible: style.display !== 'none' && style.visibility !== 'hidden',
            inViewport: rect.width > 0 && rect.height > 0,
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
                if (isButtonText(el.textContent) && isValidButtonElement(el)) {
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
            try {
                root.querySelectorAll(selector).forEach(el => results.push(el));
            } catch (e) { }

            try {
                root.querySelectorAll('*').forEach(el => {
                    if (el.shadowRoot) {
                        deepQuerySelectorAll(el.shadowRoot, selector, results);
                    }
                });
            } catch (e) { }

            return results;
        }

        const selectors = ['button', '[class*="button"]', '[role="button"]'];
        selectors.forEach(sel => {
            deepQuerySelectorAll(document, sel).forEach(el => {
                if (isButtonText(el.textContent) && isValidButtonElement(el)) {
                    let inShadow = false;
                    let parent = el;
                    while (parent) {
                        if (parent.host) { inShadow = true; break; }
                        parent = parent.parentNode;
                    }
                    found.push(getElementInfo(el, inShadow ? 'SHADOW-DOM' : 'LIGHT-DOM'));
                }
            });
        });

        return { name: 'Shadow DOM Traversal', found };
    }

    // ==================== APPROACH 3: Input Box Context ====================
    function approach3_InputBoxContext() {
        console.log('[Test] Approach 3: Input Box Context Search');
        const found = [];

        const inputBox = document.querySelector('div.full-input-box');
        if (!inputBox) {
            return { name: 'Input Box Context', found, note: 'No input box found' };
        }

        let sibling = inputBox.previousElementSibling;
        let count = 0;
        while (sibling && count < 10) {
            sibling.querySelectorAll('button, [class*="button"]').forEach(el => {
                if (isButtonText(el.textContent)) {
                    found.push(getElementInfo(el, 'INPUT-SIBLING'));
                }
            });

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

    // ==================== APPROACH 4: ARIA/Role-based Search ====================
    function approach4_ARIA() {
        console.log('[Test] Approach 4: ARIA/Role-based Search');
        const found = [];

        function deepARIA(root) {
            try {
                root.querySelectorAll('[role="button"], [aria-label*="accept" i], [aria-label*="run" i]').forEach(el => {
                    if ((isButtonText(el.textContent) || isButtonText(el.getAttribute('aria-label'))) && isValidButtonElement(el)) {
                        found.push(getElementInfo(el, 'ARIA'));
                    }
                });

                root.querySelectorAll('*').forEach(el => {
                    if (el.shadowRoot) deepARIA(el.shadowRoot);
                });
            } catch (e) { }
        }

        deepARIA(document);
        return { name: 'ARIA/Role', found };
    }

    // ==================== RUN ALL APPROACHES ====================
    const approaches = [
        approach1_StandardDOM,
        approach2_ShadowDOM,
        approach3_InputBoxContext,
        approach4_ARIA
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
        } catch (e) {
            console.error('Approach ' + (i + 1) + ' failed:', e.message);
        }
    });

    // ==================== SUMMARY ====================
    console.log('\n%c========== RESULTS ==========', 'color: yellow; font-weight: bold');

    Object.entries(results.approaches).forEach(([name, approach]) => {
        const emoji = approach.found.length > 0 ? '✅' : '❌';
        console.log(`${emoji} ${name}: ${approach.found.length} buttons`);
        approach.found.forEach(btn => {
            console.log(`    → "${btn.text}" [${btn.location}] visible=${btn.visible}`);
        });
    });

    console.log('\n%c========== SUMMARY ==========', 'color: green; font-weight: bold');
    console.log('Working approaches:', results.summary.workingApproaches.join(', ') || 'None');

    // Deduplicate
    const uniqueButtons = new Map();
    Object.values(results.approaches).forEach(approach => {
        approach.found.forEach(btn => {
            const key = btn.text + '|' + btn.className;
            if (!uniqueButtons.has(key)) uniqueButtons.set(key, btn);
        });
    });

    console.log('Unique buttons found:', uniqueButtons.size);

    if (uniqueButtons.size === 0) {
        console.log('%c⚠️ No buttons found! This may indicate:', 'color: orange');
        console.log('   • Buttons are virtualized (not in DOM)');
        console.log('   • Buttons are in closed Shadow DOM');
        console.log('   • No agent action is pending');
    }

    // Store for inspection
    window.__deepDomTestResults = results;
    console.log('\nResults saved to: window.__deepDomTestResults');

    return results;
})();
