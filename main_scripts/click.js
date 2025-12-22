
// --- Configuration & Constants ---
const DEBUG = true;
function log(...args) { if (DEBUG) console.log('[AutoAcceptCDP]', ...args); }

// Config default values
const config = {
    enableAcceptAll: true,
    enableAccept: true,
    enableRun: true,
    enableRunCommand: true,
    enableApply: true,
    enableExecute: true,
    enableResume: true,
    enableTryAgain: true,
    stuckThresholdMs: 3000,
    inactivityThresholdMs: 10000,
    buttonDecayMs: 30000
};

// --- State Tracking ---
if (!window.__autoAcceptState) {
    window.__autoAcceptState = {
        clickCount: 0,
        lastActionTime: Date.now(),
        pendingButtons: new Map(), // Element unique ID -> timestamp
        sessionHasAccepted: false, // Tracks if we HAVE accepted anything this session
        inputBoxVisible: false
    };
}
const state = window.__autoAcceptState;
let backgroundMode = false;
// Try to detect IDE type
const isAntigravity = document.title.includes('Antigravity') ||
    !!document.getElementById('antigravity.agentPanel') ||
    !!document.querySelector('[class*="antigravity"]');

// --- Helper Functions ---

function getElementUniqueId(el) {
    if (el.dataset.aaId) return el.dataset.aaId;
    const id = 'aa-' + Math.random().toString(36).substr(2, 9);
    el.dataset.aaId = id;
    return id;
}

function isElementVisible(el) {
    const style = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();

    if (backgroundMode) {
        return style.display !== 'none' && style.visibility !== 'hidden';
    }

    return style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        parseFloat(style.opacity) > 0.1 &&
        rect.width > 0 &&
        rect.height > 0;
}

function isElementClickable(el) {
    const disabled = el.disabled;
    const hasDisabledAttr = el.hasAttribute('disabled');
    if (backgroundMode) return !disabled && !hasDisabledAttr;

    const style = window.getComputedStyle(el);
    return style.pointerEvents !== 'none' && !disabled && !hasDisabledAttr;
}

function isAcceptButton(el) {
    // Only text check mostly, but we do filtering below
    if (!el || !el.textContent) return false;
    const text = el.textContent.toLowerCase().trim();
    if (text.length === 0 || text.length > 30) return false;

    // --- PATTERN MATCHING ---
    const patterns = [
        { pattern: 'accept all', enabled: config.enableAcceptAll, exact: false },
        // User Request: strict match for "AcceptAlt+⏎" for the accept button
        // We use .includes for "acceptalt" because the arrow symbol might vary or be stripped
        { pattern: 'acceptalt', enabled: config.enableAccept, exact: false },
        { pattern: 'run command', enabled: config.enableRunCommand, exact: false },
        { pattern: 'run', enabled: config.enableRun, exact: true },
        { pattern: 'apply', enabled: config.enableApply, exact: true },
        { pattern: 'execute', enabled: config.enableExecute, exact: true },
        { pattern: 'resume', enabled: config.enableResume, exact: true },
        { pattern: 'retry', enabled: config.enableTryAgain, exact: true },
        { pattern: 'try again', enabled: config.enableTryAgain, exact: false }
    ];

    const matched = patterns.some(p => {
        if (!p.enabled) return false;
        if (p.exact) return text === p.pattern;
        return text.includes(p.pattern);
    });
    if (!matched) return false;

    // Check exclusions
    const excluded = ['skip', 'reject', 'cancel', 'discard', 'deny', 'close', 'other'];
    if (excluded.some(p => text.includes(p))) return false;

    // Check visibility
    return isElementVisible(el) && isElementClickable(el);
}

// --- Deep DOM Traversal ---

// --- Targeted DOM Access (No Deep Recursion) ---

// --- Precise Antigravity Selectors ---

function getAntigravityDoc() {
    const frame = document.getElementById('antigravity.agentPanel');
    if (frame) {
        try {
            return frame.contentDocument || frame.contentWindow.document;
        } catch (e) { return null; }
    }
    return document;
}

function findAcceptButtons() {
    const buttons = [];
    const root = getAntigravityDoc();
    if (!root) return [];

    // 1. Precise "Accept" / "Run" Button
    // Verified Selector: Button with specific class signature found in discovery
    // Class: "hover:bg-ide-button-hover-background cursor-pointer rounded-sm bg-ide-button-background px-1 py-px text-sm text-ide-button-color transition-[background]"
    // Strategy: Look for "bg-ide-button-background" (very specific) OR text content "accept"

    // Primary: CSS Class Match
    const classCandidates = root.querySelectorAll('.bg-ide-button-background');
    classCandidates.forEach(el => {
        if (isAcceptButton(el)) buttons.push(el);
    });

    // Secondary: Deep Text Scan (for fallback)
    // Only if Primary yields nothing
    if (buttons.length === 0) {
        // Broad search for button-like elements
        const candidates = root.querySelectorAll('button, [role="button"], div[class*="button"]');
        candidates.forEach(el => {
            if (isAcceptButton(el)) buttons.push(el);
        });
    }

    return buttons;
}

function getNewChatButton() {
    const doc = getAntigravityDoc();
    if (!doc) return null;

    // Verified Selector: [data-tooltip-id="new-conversation-tooltip"]
    // Found via discovery script
    const newChatBtn = doc.querySelector('[data-tooltip-id="new-conversation-tooltip"]');

    if (newChatBtn && isElementVisible(newChatBtn)) {
        return newChatBtn;
    }

    // Fallback (just in case tooltip ID changes)
    // Look for button with matching aria or title
    return doc.querySelector('button[aria-label*="new" i], button[title*="new" i]');
}

function getVisibleTabs() {
    const doc = getAntigravityDoc();
    if (!doc) return [];

    const tabs = [];
    const seen = new Set();

    // 1. "See all" Boundary
    let seeAllY = 99999;
    const divs = doc.querySelectorAll('div');
    for (const div of divs) {
        if (div.textContent?.trim() === 'See all' && div.className.includes('opacity-30')) {
            const rect = div.getBoundingClientRect();
            if (rect.height > 0) seeAllY = rect.top;
            break;
        }
    }

    // 2. Tab Items
    // Heuristic: Button with timestamp text ("5m", "12h", "now")
    const buttons = doc.querySelectorAll('button');
    for (const btn of buttons) {
        const text = btn.textContent?.trim() || '';
        // Highly Permissive Regex: Just looks for the time pattern anywhere in the string
        if (/\d+[smh]|now/.test(text)) {
            const rect = btn.getBoundingClientRect();
            if (rect.height > 0 && rect.top < seeAllY && !seen.has(btn)) {
                seen.add(btn);
                tabs.push({ element: btn, y: rect.top });
            }
        }
    }

    // Sort top to bottom
    return tabs.sort((a, b) => a.y - b.y).map(t => t.element);
}


function clickButton(el) {
    if (!el) return false;
    try {
        const rect = el.getBoundingClientRect();
        const centerX = rect.width > 0 ? rect.left + rect.width / 2 : 0;
        const centerY = rect.height > 0 ? rect.top + rect.height / 2 : 0;

        // Dispatch Pointer Events (Modern) & Mouse Events (Legacy)
        ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(type => {
            const eventClass = type.startsWith('pointer') ? PointerEvent : MouseEvent;
            el.dispatchEvent(new eventClass(type, {
                bubbles: true, cancelable: true, view: window,
                clientX: centerX, clientY: centerY,
                pointerId: 1, isPrimary: true
            }));
        });

        if (typeof el.click === 'function') el.click();

        if (backgroundMode) {
            if (el.focus) el.focus();
            el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
            el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
        }

        return true;
    } catch (e) {
        return false;
    }
}

// --- Main Click API ---

function click(targetSelector) {
    let count = 0;
    const inputs = Array.isArray(targetSelector) ? targetSelector : [targetSelector];

    for (const target of inputs) {
        let elements = [];

        if (typeof target === 'string') {
            const kw = target.toLowerCase();
            if (['accept', 'run', 'retry', 'apply'].includes(kw)) {
                elements = findAcceptButtons();
            } else if (kw === 'new_chat') {
                const btn = getNewChatButton();
                if (btn) elements = [btn];
            } else {
                try {
                    elements = document.querySelectorAll(target);
                } catch (e) { }
            }
        } else if (target instanceof Element) {
            elements = [target];
        }

        for (const el of elements) {
            if (clickButton(el)) {
                count++;
                state.clickCount++;
                state.lastActionTime = Date.now();
                if (isAcceptButton(el)) {
                    state.sessionHasAccepted = true;
                    state.pendingButtons.delete(getElementUniqueId(el));
                    log('CLICKED:', el.textContent?.substring(0, 20));
                } else {
                    log('CLICKED ELEMENT:', el.tagName);
                }
            }
        }
    }

    return count;
}

// --- Pro / Background Loop Strategy ---

async function executeProSequence(tabIndex) {
    if (!isAntigravity) {
        // Fallback for Cursor or non-antigravity
        return click(['accept', 'run', 'retry']);
    }

    // Sequence: [Accept/Run/Retry, New Chat (+), Tabs[j]]
    // We will do this specifically in the order requested.

    // 1. Accept/Run/Retry
    const c1 = click(['accept', 'run', 'retry']);

    // 2. New Chat Button
    click('new_chat');

    // DELAY 1000ms (Async - Non-Blocking)
    await new Promise(r => setTimeout(r, 1000));

    // 3. Tab Cycle
    // "loop through all tabs" - implied one tab per index, loop externally controlled?
    // "cdp( for let j = 0, j++, j < 3 ... )" logic requested by user.
    // We will iterate through tabs in this execution.
    const tabs = getVisibleTabs();

    // If we have tabs, we cycle through them starting from tabIndex
    if (tabs.length > 0) {
        // The user says "if j=2, let j=-1" which implies a loop of size 3 (0,1,2).
        // Let's iterate j from 0 to 2
        for (let j = 0; j < 3; j++) {
            // If tabIndex is the base, we use (tabIndex + j) wrapping around total tabs?
            // Or maybe tabIndex is not used in the loop, just the loop itself?
            // "let j = -1" implies j is stateful.
            // Let's assume passed tabIndex is the START of the 3-tab lookahead.

            const targetIndex = (tabIndex + j) % tabs.length;
            const tab = tabs[targetIndex];
            // log('ProCycle: Clicking tab ' + targetIndex);
            if (tab) click(tab);
        }
    }

    return c1;
}

return {
    click,
    executeProSequence,
    getVisibleTabs,
    findAcceptButtons,
    state,
    // Standard entry point
    forceClick: (bgMode) => {
        backgroundMode = bgMode;
        // Non-Pro / Standard Logic
        return click(['accept', 'run', 'retry']);
    },
    // New Pro entry point (Now Async)
    forceClickPro: async (bgMode, tabIndex) => {
        backgroundMode = bgMode;
        if (backgroundMode) {
            await executeProSequence(tabIndex || 0);
            return { clicked: true, pro: true };
        } else {
            const c = click(['accept', 'run', 'retry']);
            return { clicked: c > 0 };
        }
    },
    isWindowFocused: () => document.hasFocus()
};
