// ============================================
// ANTIGRAVITY_BACKGROUND.JS - Antigravity background polling
// ============================================
// CSP COMPLIANT - No innerHTML
// ============================================

(function (exports) {
    'use strict';

    const core = window.__autoAcceptCore;
    const logic = window.__autoAcceptLogic;

    const STATE_KEY = 'auto-accept-conversations';
    const OVERLAY_ID = '__autoAcceptBgOverlay';
    const STYLE_ID = '__autoAcceptBgStyles';
    const MAX_SLOTS = 3;

    let slotStartTimes = [0, 0, 0];
    let targetPanel = null;
    let resizeObserver = null;
    let conversationNames = null; // null = not yet captured
    let overlayDisabled = false;  // Prevents respawn after hide

    // ========================================
    // STATE
    // ========================================
    function getSharedState() {
        try {
            const raw = localStorage.getItem(STATE_KEY);
            return raw ? JSON.parse(raw) : null;
        } catch (e) {
            return null;
        }
    }

    function initializeState(names) {
        conversationNames = names;
        // preserve existing state if possible to keep start times?
        // for now we reset, but we add startTime
        const state = names.map((name, i) => ({
            id: i,
            completed: false,
            name: name,
            startTime: Date.now(),
            lastUpdated: Date.now()
        }));
        localStorage.setItem(STATE_KEY, JSON.stringify(state));
        return state;
    }

    function updateSharedState(slotIndex, updates) {
        const state = getSharedState();
        if (state && state[slotIndex]) {
            // Once completed, stay completed
            if (state[slotIndex].completed) {
                // If it's already completed, don't update completed status or duration again
                // effectively locking it
                delete updates.completed;
            } else if (updates.completed) {
                // Transitioning to completed
                updates.completedAt = Date.now();
                const start = state[slotIndex].startTime || slotStartTimes[slotIndex] || Date.now();
                updates.finalDuration = Date.now() - start;
            }

            Object.assign(state[slotIndex], { ...updates, lastUpdated: Date.now() });
            localStorage.setItem(STATE_KEY, JSON.stringify(state));
        }
    }

    function formatDuration(ms) {
        if (ms <= 0) return '0S';
        const s = Math.floor(ms / 1000);
        const m = Math.floor(s / 60);
        return m > 0 ? `${m}M ${s % 60}S` : `${s}S`;
    }

    // ========================================
    // STYLES - Dotted progress bar
    // ========================================
    const STYLES = `
        #${OVERLAY_ID} {
            position: fixed;
            background: rgba(0, 0, 0, 0.95);
            z-index: 2147483647;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            color: #fff;
            display: flex;
            flex-direction: column;
            justify-content: center;
            align-items: center;
            pointer-events: none;
            opacity: 0;
            transition: opacity 0.2s;
        }
        #${OVERLAY_ID}.visible { opacity: 1; }
        .aab-container { width: 90%; max-width: 480px; }
        .aab-slot { margin-bottom: 32px; }
        .aab-slot:last-child { margin-bottom: 0; }
        .aab-header {
            display: flex;
            align-items: center;
            margin-bottom: 8px;
            gap: 12px;
        }
        .aab-name {
            font-size: 14px;
            font-weight: 500;
            color: #fff;
            flex: 1;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .aab-status {
            font-size: 11px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        .aab-time {
            font-family: 'SF Mono', Monaco, monospace;
            font-size: 11px;
            color: rgba(255,255,255,0.5);
            margin-left: 10px;
        }
        .aab-progress-track {
            height: 6px;
            width: 100%;
            background: rgba(255,255,255,0.1);
            border-radius: 3px;
            overflow: hidden;
        }
        .aab-progress-fill {
            height: 100%;
            border-radius: 3px;
            transition: width 0.5s ease, background-color 0.5s ease;
        }

        /* States */
        /* Initiating (Blue) */
        .aab-slot.initiating .aab-progress-fill { width: 33%; background: #3b82f6; }
        .aab-slot.initiating .aab-status { color: #3b82f6; }

        /* Processing (Purple) */
        .aab-slot.processing .aab-progress-fill { width: 66%; background: #a855f7; }
        .aab-slot.processing .aab-status { color: #a855f7; }

        /* Done (Green) */
        .aab-slot.done .aab-progress-fill { width: 100%; background: #22c55e; }
        .aab-slot.done .aab-status { color: #22c55e; }
    `;

    // ========================================
    // PANEL ATTACHMENT
    // ========================================
    function findAIPanel() {
        let panel = document.getElementById('antigravity.agentPanel');
        if (panel && panel.getBoundingClientRect().width > 50) return panel;
        try {
            panel = document.querySelector('#antigravity\\.agentPanel');
            if (panel && panel.getBoundingClientRect().width > 50) return panel;
        } catch (e) { }
        return null;
    }

    function syncPosition() {
        const overlay = document.getElementById(OVERLAY_ID);
        if (!overlay || !targetPanel) return;
        const r = targetPanel.getBoundingClientRect();
        overlay.style.top = r.top + 'px';
        overlay.style.left = r.left + 'px';
        overlay.style.width = r.width + 'px';
        overlay.style.height = r.height + 'px';
    }

    // ========================================
    // OVERLAY DOM (CSP-safe)
    // ========================================
    function createProgressBar() {
        const track = document.createElement('div');
        track.className = 'aab-progress-track';

        const fill = document.createElement('div');
        fill.className = 'aab-progress-fill';

        track.appendChild(fill);
        return track;
    }

    function createSlot(slot, index) {
        const div = document.createElement('div');

        let elapsed = 0;
        if (slot.completed && slot.finalDuration) {
            elapsed = slot.finalDuration;
        } else {
            const start = slot.startTime || slotStartTimes[index];
            elapsed = start > 0 ? Date.now() - start : 0;
        }

        // Determine state
        let stateClass = 'processing';
        let statusText = 'IN PROGRESS';

        if (slot.completed) {
            stateClass = 'done';
            statusText = 'COMPLETED';
        } else if (elapsed < 3000) { // < 3 seconds considered initiating
            stateClass = 'initiating';
            statusText = 'INITIATING';
        }

        div.className = 'aab-slot ' + stateClass;

        const header = document.createElement('div');
        header.className = 'aab-header';

        const name = document.createElement('span');
        name.className = 'aab-name';
        name.textContent = slot.name || `Conversation ${index + 1}`;

        const status = document.createElement('span');
        status.className = 'aab-status';
        status.textContent = statusText;

        const time = document.createElement('span');
        time.className = 'aab-time';

        time.textContent = formatDuration(elapsed);

        header.appendChild(name);
        header.appendChild(status);
        header.appendChild(time);

        const bar = createProgressBar();

        div.appendChild(header);
        div.appendChild(bar);

        return div;
    }

    function renderOverlay() {
        // Don't render if disabled (after hide)
        if (overlayDisabled) return null;

        let overlay = document.getElementById(OVERLAY_ID);
        if (!overlay) {
            if (!document.getElementById(STYLE_ID)) {
                const style = document.createElement('style');
                style.id = STYLE_ID;
                style.textContent = STYLES;
                document.head.appendChild(style);
            }

            targetPanel = findAIPanel();

            overlay = document.createElement('div');
            overlay.id = OVERLAY_ID;

            const container = document.createElement('div');
            container.className = 'aab-container';
            container.id = OVERLAY_ID + '-c';

            overlay.appendChild(container);
            document.body.appendChild(overlay);

            if (targetPanel) {
                syncPosition();
                resizeObserver = new ResizeObserver(syncPosition);
                resizeObserver.observe(targetPanel);
                window.addEventListener('resize', syncPosition);
            }

            void overlay.offsetWidth;
            overlay.classList.add('visible');
        }
        return overlay;
    }

    function updateUI() {
        if (overlayDisabled) return;

        renderOverlay();
        const container = document.getElementById(OVERLAY_ID + '-c');
        if (!container) return;

        // Clear container
        while (container.firstChild) container.removeChild(container.firstChild);

        // Only show progress bars if names are captured
        if (conversationNames !== null) {
            const state = getSharedState();
            if (state) {
                state.forEach((slot, i) => container.appendChild(createSlot(slot, i)));
            }
        }
        // Otherwise container stays empty (black overlay)

        syncPosition();
    }

    // ========================================
    // HELPERS
    // ========================================
    function getVisibleTabs(doc) {
        if (!doc) return [];
        const tabs = [], seen = new Set();
        let seeAllY = 99999;

        doc.querySelectorAll('div').forEach(div => {
            if (div.textContent?.trim() === 'See all' && div.className.includes('opacity-30')) {
                seeAllY = div.getBoundingClientRect().top;
            }
        });

        doc.querySelectorAll('button').forEach(btn => {
            const text = btn.textContent?.trim() || '';
            const classes = btn.className || '';
            // Conversation tabs have 'grow' class - distinguishes from other buttons
            if (/\d+[smh]|now/.test(text) && classes.includes('grow')) {
                const r = btn.getBoundingClientRect();
                if (r.height > 0 && r.top < seeAllY && !seen.has(btn)) {
                    seen.add(btn);
                    tabs.push({ el: btn, text: text, y: r.top });
                }
            }
        });

        return tabs.sort((a, b) => a.y - b.y);
    }

    function isOnConversationScreen(doc) {
        // We're on conversation screen if we can see conversation tabs
        const tabs = getVisibleTabs(doc);
        return tabs.length >= 1;
    }

    function extractConversationNames(doc) {
        const tabs = getVisibleTabs(doc);
        const names = [];

        for (let i = 0; i < MAX_SLOTS && i < tabs.length; i++) {
            // Remove timestamp pattern from anywhere in text
            // Handles: "Debugging Tab Cycling Clicks22s", "My Chat5m", "Testnow"
            const fullText = tabs[i].text;
            const name = fullText.replace(/\d+[smh]|\bnow\b/gi, '').trim();
            names.push(name || `Conversation ${i + 1}`);
        }

        // Pad with defaults if less than MAX_SLOTS
        while (names.length < MAX_SLOTS) {
            names.push(`Conversation ${names.length + 1}`);
        }

        return names;
    }

    async function clickTab(doc, tabIndex) {
        const tabs = getVisibleTabs(doc);
        if (tabs.length === 0) return false;
        const tab = tabs[tabIndex % tabs.length].el;
        tab.scrollIntoView({ block: 'center' });
        core.simulateClick(tab, 'Tab');
        return true;
    }

    function clickNewConversation(doc) {
        if (!doc) return false;
        const newChatLink = doc.querySelector('a[data-tooltip-id="new-conversation-tooltip"]');
        if (newChatLink) {
            core.simulateClick(newChatLink, 'NewChat');
            core.log('Clicked + (new conversation)');
            return true;
        }
        return false;
    }

    // ========================================
    // MAIN POLL
    // ========================================
    // ========================================
    // MAIN POLL
    // ========================================
    exports.antigravityBackgroundPoll = async function (ide, tabIndex = 0, isPro = false) {
        // Reset disabled flag when poll is called
        overlayDisabled = false;

        // Initialize tracked slot if needed (first run or reset)
        if (typeof window.__autoAcceptCurrentSlot === 'undefined') {
            window.__autoAcceptCurrentSlot = tabIndex % MAX_SLOTS;
        }

        const currentSlot = window.__autoAcceptCurrentSlot;
        core.log(`=== AG BG Poll [Slot ${currentSlot}] (raw tabIndex=${tabIndex}) ===`);

        // Always render overlay immediately
        updateUI();

        const doc = core.getDocument(ide); // Note: this finds buttons in current DOM

        // Setup start time if missing (backward compatibility / live update)
        if (slotStartTimes[currentSlot] === 0) slotStartTimes[currentSlot] = Date.now();

        // Check where we are
        const onConvScreen = isOnConversationScreen(doc);

        // If on conversation screen and names not captured, capture them
        if (onConvScreen && conversationNames === null) {
            const names = extractConversationNames(doc);
            initializeState(names);
            core.log('Captured conversation names: ' + names.join(', '));
            updateUI();

            // Click into first tab to start
            window.__autoAcceptCurrentSlot = 0;
            await clickTab(doc, 0);
            await new Promise(r => setTimeout(r, 2000));
            return { clicked: true, tabIndex: 0 };
        }

        // --- ACTION PHASE ---
        // Only perform actions if current slot is NOT completed (or we just arrived there and need to check)
        // Since we skip clicking completed slots, we should be on an incomplete one.
        // But double check state just in case.
        const state = getSharedState();
        const isCompleted = state && state[currentSlot] && state[currentSlot].completed;

        let didAction = false;

        if (!isCompleted) {
            // Step 1: Click Accept buttons
            const acceptButtons = core.findAcceptButtons(doc, true);
            for (const btn of acceptButtons) {
                if (core.simulateClick(btn, 'Accept')) didAction = true;
            }

            // Step 1b: Click Retry buttons (Pro only)
            if (isPro) {
                const retryButtons = doc.querySelectorAll('button');
                for (const btn of retryButtons) {
                    const text = btn.textContent?.toLowerCase() || '';
                    if (text.includes('retry') && btn.getBoundingClientRect().height > 0) {
                        if (core.simulateClick(btn, 'Retry')) didAction = true;
                    }
                }
            }

            // Wait for actions to take effect
            if (didAction) await new Promise(r => setTimeout(r, 1500));
        }

        // --- CHECK COMPLETION ---
        // Always check completion for current view
        const checkState = logic ? logic.detectConversationState(doc) : { completed: false };
        if (conversationNames !== null) {
            updateSharedState(currentSlot, { completed: checkState.completed });
        }

        // --- NAVIGATION PHASE ---
        // Logic: Find next INCOMPLETE slot.
        // If all completed, just stay? or cycle? 
        // We'll cycle incomplete ones.

        const freshState = getSharedState() || [];
        let nextSlot = currentSlot;
        let foundNext = false;

        // Look for next incomplete slot
        for (let i = 1; i <= MAX_SLOTS; i++) {
            const candidate = (currentSlot + i) % MAX_SLOTS;
            const slotState = freshState[candidate];
            if (!slotState || !slotState.completed) {
                nextSlot = candidate;
                foundNext = true;
                break;
            }
        }

        // If all are completed, foundNext is false. We'll just stay on current or cycle round robin?
        // User asked to "remove from polling cycles". 
        // If all are completed, we might as well just cycle slowly or stop.
        // Let's default to cycling if all completed to allow user manual reset monitoring.
        if (!foundNext) {
            nextSlot = (currentSlot + 1) % MAX_SLOTS;
        }

        core.log(`  Current: ${currentSlot} | Completed: ${checkState.completed} | Next Active: ${nextSlot}`);

        // Step 2: Click + (new conversation) - ONLY if we need new names? 
        // Actually, existing logic for '+' was unconditional. 
        // Ideally we only click + if we think we ran out of slots or user wants new ones.
        // For now, let's KEEP original behavior:
        // "Step 2: Click + (new conversation)" 
        // BUT, original logic triggered it every cycle.
        // If we strictly follow "remove completed from polling", we should only rotate/click '+'
        // if we are actively working. 
        // If we are just skipping, we don't need '+'.

        // Wait, the original code did: 
        // clickNewConversation(doc) -> capture names -> click next tab.
        // We should preserve the "New Conversation" check logic, usually it's to populate slots.

        // To be safe: Only Click + if we haven't captured names yet? 
        // Original code: "Step 2: Click + ... if names null ... capture".
        // It was unconditional. 
        // Let's keep it unconditional for now to avoid breaking "New Slot Discovery"
        // provided it doesn't disrupt the flow.

        // Actually, if we skip completed slots, we might skip the one that triggers '+'. 
        // 'clickNewConversation' was just checking if the button exists.

        clickNewConversation(doc);
        await new Promise(r => setTimeout(r, 1000));

        // Re-fetch doc
        const freshDoc = core.getDocument(ide);

        // Capture names if needed (e.g. after + click)
        if (conversationNames === null && isOnConversationScreen(freshDoc)) {
            const names = extractConversationNames(freshDoc);
            initializeState(names);
        }

        // Navigate to next target
        if (nextSlot !== currentSlot || foundNext) {
            window.__autoAcceptCurrentSlot = nextSlot;
            await clickTab(freshDoc, nextSlot);
        }

        await new Promise(r => setTimeout(r, 1000));
        updateUI();

        return { clicked: didAction, tabIndex: nextSlot };
    };

    exports.hideBackgroundOverlay = function () {
        overlayDisabled = true; // Prevent respawn

        // Immediate and definitive removal (no transition)
        const overlays = document.querySelectorAll('#' + OVERLAY_ID);
        overlays.forEach(el => el.remove());

        const style = document.getElementById(STYLE_ID);
        if (style) style.remove();

        if (resizeObserver) {
            resizeObserver.disconnect();
            resizeObserver = null;
        }
        window.removeEventListener('resize', syncPosition);

        targetPanel = null;
        slotStartTimes = [0, 0, 0];
        conversationNames = null;
        window.__autoAcceptCurrentSlot = undefined; // Reset tracked active slot
        localStorage.removeItem(STATE_KEY);
    };

})(window.__autoAcceptPolling = window.__autoAcceptPolling || {});
