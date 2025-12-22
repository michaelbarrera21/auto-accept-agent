// ============================================
// CONVERSATION_LOGIC.JS - Conversation state detection
// ============================================
// Detects if conversation is completed by looking for Good/Bad badge
// ============================================

(function (exports) {
    'use strict';

    /**
     * Detects if conversation is completed by finding Good/Bad badge.
     * @param {Document} doc - The document context
     * @returns {object} { completed: boolean }
     */
    exports.detectConversationState = function (doc) {
        if (!doc) return { completed: false };

        // Look for Good/Bad feedback badge
        // Container: div.ml-auto that contains span.opacity-70 with text "Good" or "Bad"
        const feedbackContainer = doc.querySelector('div.ml-auto.flex.flex-row.items-center.gap-2');
        if (feedbackContainer) {
            const spans = feedbackContainer.querySelectorAll('span.opacity-70');
            for (const span of spans) {
                const text = span.textContent?.trim();
                if (text === 'Good' || text === 'Bad') {
                    return { completed: true };
                }
            }
        }

        // Fallback: Check for any span.opacity-70 with Good/Bad text
        const allSpans = doc.querySelectorAll('span.opacity-70');
        for (const span of allSpans) {
            const text = span.textContent?.trim();
            if (text === 'Good' || text === 'Bad') {
                return { completed: true };
            }
        }

        return { completed: false };
    };

    /**
     * Gets the current conversation name from the document.
     * @param {Document} doc
     * @returns {string}
     */
    exports.getConversationName = function (doc) {
        if (!doc) return 'Conversation';

        // Try to find conversation title from various sources
        // 1. Look for a header/title element
        const header = doc.querySelector('h1, h2, [class*="title"], [class*="header"]');
        if (header && header.textContent?.trim().length > 0 && header.textContent.trim().length < 50) {
            return header.textContent.trim();
        }

        // 2. Fallback to document title
        if (doc.title && doc.title.length < 50) {
            return doc.title;
        }

        return 'Conversation';
    };

})(window.__autoAcceptLogic = window.__autoAcceptLogic || {});
