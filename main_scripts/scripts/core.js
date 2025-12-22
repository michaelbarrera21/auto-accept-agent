// ============================================
// CORE.JS - Shared utilities for Auto-Accept
// ============================================
// Contains: logging, element detection, click simulation
// Used by all polling strategies.
// ============================================

(function (exports) {
    'use strict';

    const LOG_PREFIX = '[AutoAccept]';
    const DEBUG = true;

    // ========================================
    // LOGGING
    // ========================================
    exports.log = function (...args) {
        if (DEBUG) console.log(LOG_PREFIX, ...args);
    };

    // ========================================
    // IDE DETECTION
    // ========================================
    exports.detectIDE = function () {
        // Check multiple indicators for Antigravity
        const titleCheck = document.title.includes('Antigravity');
        const panelCheck = !!document.getElementById('antigravity.agentPanel');
        const classCheck = !!document.querySelector('[class*="antigravity"]');

        // Also check for Cursor indicators
        const isCursorTitle = document.title.toLowerCase().includes('cursor');

        // Log detection details
        if (DEBUG) {
            console.log(LOG_PREFIX, 'IDE Detection:', {
                documentTitle: document.title,
                titleCheck,
                panelCheck,
                classCheck,
                isCursorTitle
            });
        }

        const isAntigravity = titleCheck || panelCheck || classCheck;
        const isCursor = isCursorTitle && !isAntigravity;

        const result = {
            isAntigravity,
            isCursor,
            name: isAntigravity ? 'Antigravity' : (isCursor ? 'Cursor' : 'Unknown'),
            _debug: {
                documentTitle: document.title,
                titleCheck,
                panelCheck,
                classCheck,
                isCursorTitle
            }
        };

        if (DEBUG) {
            console.log(LOG_PREFIX, 'IDE Detection Result:', result);
        }

        return result;
    };

    // ========================================
    // DOCUMENT ACCESS
    // ========================================
    exports.getDocument = function (ide) {
        // For Antigravity, try to get the agent panel iframe document
        if (ide.isAntigravity) {
            const frame = document.getElementById('antigravity.agentPanel');
            if (frame) {
                try {
                    return frame.contentDocument || frame.contentWindow.document;
                } catch (e) {
                    return document;
                }
            }
        }
        return document;
    };

    // ========================================
    // VISIBILITY CHECKS
    // ========================================
    exports.isElementVisible = function (el, backgroundMode = false) {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();

        if (backgroundMode) {
            // Background mode: relaxed (element exists in DOM)
            return style.display !== 'none' && style.visibility !== 'hidden';
        }
        // Foreground mode: strict (must be visible on screen)
        return style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            parseFloat(style.opacity) > 0.1 &&
            rect.width > 0 &&
            rect.height > 0;
    };

    exports.isElementClickable = function (el, backgroundMode = false) {
        if (backgroundMode) return !el.disabled;
        return getComputedStyle(el).pointerEvents !== 'none' && !el.disabled;
    };

    // ========================================
    // BUTTON DETECTION
    // ========================================
    const ACCEPT_PATTERNS = [
        { pattern: 'accept all', exact: false },
        { pattern: 'acceptalt', exact: false },
        { pattern: 'run command', exact: false },
        { pattern: 'run', exact: true },
        { pattern: 'apply', exact: true },
        { pattern: 'execute', exact: true },
        { pattern: 'resume', exact: true },
        { pattern: 'retry', exact: true },
        { pattern: 'try again', exact: false }
    ];

    const REJECT_PATTERNS = ['skip', 'reject', 'cancel', 'discard', 'deny', 'close'];

    exports.isAcceptButton = function (el, backgroundMode = false) {
        if (!el || !el.textContent) return false;
        const text = el.textContent.toLowerCase().trim();
        if (text.length === 0 || text.length > 50) return false;

        const matchesPattern = ACCEPT_PATTERNS.some(p =>
            p.exact ? text === p.pattern : text.includes(p.pattern)
        );
        if (!matchesPattern) return false;
        if (REJECT_PATTERNS.some(p => text.includes(p))) return false;

        return exports.isElementVisible(el, backgroundMode) &&
            exports.isElementClickable(el, backgroundMode);
    };

    exports.findAcceptButtons = function (doc, backgroundMode = false) {
        if (!doc) return [];
        const buttons = [];

        // Try specific class first
        doc.querySelectorAll('.bg-ide-button-background').forEach(el => {
            if (exports.isAcceptButton(el, backgroundMode)) buttons.push(el);
        });

        // Fallback to generic
        if (buttons.length === 0) {
            doc.querySelectorAll('button, [role="button"], div[class*="button"]').forEach(el => {
                if (exports.isAcceptButton(el, backgroundMode)) buttons.push(el);
            });
        }

        return buttons;
    };

    // ========================================
    // CLICK SIMULATION
    // ========================================
    exports.simulateClick = function (el, label = null) {
        if (!el) return false;

        if (label) {
            exports.log(`Click: ${label} on <${el.tagName}> "${el.textContent?.slice(0, 20)}..."`);
        }

        try {
            const rect = el.getBoundingClientRect();
            const centerX = rect.width > 0 ? rect.left + rect.width / 2 : 0;
            const centerY = rect.height > 0 ? rect.top + rect.height / 2 : 0;

            // Full event sequence
            ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(type => {
                const EventClass = type.startsWith('pointer') ? PointerEvent : MouseEvent;
                el.dispatchEvent(new EventClass(type, {
                    bubbles: true, cancelable: true, view: window,
                    clientX: centerX, clientY: centerY,
                    pointerId: 1, isPrimary: true
                }));
            });

            // Direct click
            if (typeof el.click === 'function') el.click();

            // Focus + Enter fallback
            if (el.focus) el.focus();
            el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
            el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));

            return true;
        } catch (e) {
            console.error(LOG_PREFIX, 'Click error:', e);
            return false;
        }
    };

    // ========================================
    // STATE MANAGEMENT
    // ========================================
    if (!window.__autoAcceptState) {
        window.__autoAcceptState = {
            clickCount: 0,
            lastActionTime: Date.now(),
            sessionHasAccepted: false
        };
    }
    exports.state = window.__autoAcceptState;

})(window.__autoAcceptCore = window.__autoAcceptCore || {});
