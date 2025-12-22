// ============================================
// CURSOR_BACKGROUND.JS - Cursor background accept polling
// ============================================
// Used by: Cursor (when unfocused, Pro only)
// Logic: Accept button clicking with RELAXED visibility
// Note: Cursor doesn't have tab cycling like Antigravity
// ============================================

(function (exports) {
    'use strict';

    const core = window.__autoAcceptCore;
    const focus = window.__autoAcceptFocus;

    /**
     * Cursor background accept polling.
     * Same as standard accept polling but with RELAXED visibility checks.
     * No tab cycling (Cursor doesn't have the same sidebar UI).
     * 
     * @param {object} ide - IDE detection result
     * @returns {object} { clicked: boolean, count: number, skipped: boolean }
     */
    exports.cursorBackgroundPoll = function (ide) {
        core.log(`=== cursorBackgroundPoll START [${ide.name}] ===`);

        // Check if window is focused - if so, skip background logic
        if (focus.isWindowFocused()) {
            core.log(`Window is FOCUSED - skipping background poll`);
            return { clicked: false, count: 0, skipped: true, reason: 'window_focused' };
        }

        const doc = core.getDocument(ide);
        const buttons = core.findAcceptButtons(doc, true); // true = relaxed visibility

        let clicked = 0;
        for (const btn of buttons) {
            if (core.simulateClick(btn, 'Accept (background)')) {
                clicked++;
                core.state.clickCount++;
                core.state.lastActionTime = Date.now();
                core.state.sessionHasAccepted = true;
            }
        }

        core.log(`=== cursorBackgroundPoll END: clicked=${clicked} ===`);
        return { clicked: clicked > 0, count: clicked, skipped: false };
    };

})(window.__autoAcceptPolling = window.__autoAcceptPolling || {});
