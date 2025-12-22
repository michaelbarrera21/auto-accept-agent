// ============================================
// ACCEPT_POLL.JS - Standard foreground accept polling
// ============================================
// Used by: Cursor (always), Antigravity (when focused)
// Logic: Find and click accept buttons with strict visibility
// ============================================

(function (exports) {
    'use strict';

    const core = window.__autoAcceptCore;

    /**
     * Standard accept polling - clicks visible accept buttons.
     * Works for both Cursor and Antigravity in foreground mode.
     * Uses STRICT visibility checks (element must be on screen).
     * 
     * @param {object} ide - IDE detection result from core.detectIDE()
     * @returns {object} { clicked: boolean, count: number }
     */
    exports.acceptPoll = function (ide) {
        core.log(`=== acceptPoll START [${ide.name}] (foreground) ===`);

        const doc = core.getDocument(ide);
        const buttons = core.findAcceptButtons(doc, false); // false = strict visibility

        let clicked = 0;
        for (const btn of buttons) {
            if (core.simulateClick(btn, 'Accept')) {
                clicked++;
                core.state.clickCount++;
                core.state.lastActionTime = Date.now();
                core.state.sessionHasAccepted = true;
            }
        }

        core.log(`=== acceptPoll END: clicked=${clicked} ===`);
        return { clicked: clicked > 0, count: clicked };
    };

})(window.__autoAcceptPolling = window.__autoAcceptPolling || {});
