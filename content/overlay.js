/**
 * StealthTab Content Script — Overlay v2
 *
 * PART 5 — Failsafe DOM Protection:
 *  ✅ Replaces page content with lock screen when tab is locked
 *  ✅ MutationObserver re-injects if overlay removed by DevTools
 *  ✅ Reports user activity to SW for inactivity timer reset
 *  ✅ Listens for SHOW/HIDE overlay messages from SW
 *
 * This runs at document_end on all https:// pages.
 */

(async () => {
  // Prevent double-injection (e.g. if script is loaded twice)
  if (window.__stealthTabInjected) return;
  window.__stealthTabInjected = true;

  const OVERLAY_ID = '__st_overlay';
  let _guardObserver = null;
  let _activityThrottle = false;

  // ── Check tab state from service worker ──────────────────────────────
  let tabState = null;
  try {
    tabState = await chrome.runtime.sendMessage({ type: 'GET_TAB_STATE' });
  } catch (e) {
    // Extension context gone (SW was killed and not yet restarted) — skip
    return;
  }

  if (tabState?.status === 'locked') {
    console.log('[StealthTab Content] Tab is locked — showing overlay');
    showOverlay();
  }

  // ── Listen for explicit SW commands ──────────────────────────────────
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'SHOW_OVERLAY') {
      console.log('[StealthTab Content] SHOW_OVERLAY received');
      showOverlay();
    }
    if (msg?.type === 'HIDE_OVERLAY') {
      console.log('[StealthTab Content] HIDE_OVERLAY received');
      removeOverlay();
    }
  });

  // ── Activity reporting (throttled to 1 per 5s) ───────────────────────
  function reportActivity() {
    if (_activityThrottle) return;
    if (!chrome.runtime?.id) return; // Context invalidated — ignore
    _activityThrottle = true;
    chrome.runtime.sendMessage({ type: 'RESET_TAB_TIMER' }).catch(() => {});
    setTimeout(() => { _activityThrottle = false; }, 5000);
  }
  ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart']
    .forEach(ev => window.addEventListener(ev, reportActivity, { passive: true }));

  // ── Overlay management ───────────────────────────────────────────────

  function showOverlay() {
    // SECURITY: If we are on the decoy site, hide the overlay (Stealth Mode)
    // Only show the overlay if we are NOT on the decoy site.
    if (tabState?.decoyUrl) {
      try {
        const decoyOrigin = new URL(tabState.decoyUrl).origin;
        if (window.location.origin === decoyOrigin) {
          console.log('[StealthTab Content] On decoy site — suppressing overlay');
          removeOverlay();
          return;
        }
      } catch (e) { /* ignore invalid URL */ }
    }

    if (document.getElementById(OVERLAY_ID)) return;  // already shown

    // Block all scrolling/interaction on the underlying page
    document.documentElement.style.overflow = 'hidden';

    const el = document.createElement('div');
    el.id = OVERLAY_ID;

    // Inline styles — these must win against any page CSS
    el.style.cssText = `
      position: fixed !important;
      top: 0 !important; left: 0 !important;
      width: 100vw !important; height: 100vh !important;
      z-index: 2147483647 !important;
      background: #07070f !important;
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif !important;
      pointer-events: all !important;
    `;

    el.innerHTML = `
      <div style="
        text-align: center;
        padding: 40px 32px;
        background: rgba(255,255,255,0.04);
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: 24px;
        box-shadow: 0 0 80px rgba(99,102,241,0.15), 0 30px 60px rgba(0,0,0,0.6);
        max-width: 340px;
        width: 90%;
        backdrop-filter: blur(16px);
      ">
        <div style="font-size:56px;margin-bottom:16px;animation:st-pulse 3s ease-in-out infinite;">🛡</div>
        <h1 style="
          font-size:22px;font-weight:800;letter-spacing:-0.5px;
          background:linear-gradient(90deg,#fff,#a5b4fc);
          -webkit-background-clip:text;-webkit-text-fill-color:transparent;
          background-clip:text;margin:0 0 8px;
        ">Tab Protected</h1>
        <p style="color:#6060a0;font-size:13px;line-height:1.7;margin:0 0 24px;">
          This tab is hidden by <strong style="color:#818cf8;">StealthTab</strong>.<br>
          Click the <strong>🔒</strong> toolbar icon to authenticate.
        </p>
        <div style="
          display:inline-flex;align-items:center;gap:8px;
          background:rgba(99,102,241,0.1);border:1px solid rgba(99,102,241,0.25);
          border-radius:10px;padding:10px 16px;font-size:11px;color:#818cf8;
        ">
          🔒 Auto-locks after 30 minutes of inactivity
        </div>
      </div>
      <style>
        @keyframes st-pulse {
          0%,100%{transform:scale(1);filter:drop-shadow(0 0 18px rgba(99,102,241,0.4))}
          50%{transform:scale(1.08);filter:drop-shadow(0 0 32px rgba(139,92,246,0.7))}
        }
      </style>`;

    // Attach to <html> — survives body replacement attacks
    document.documentElement.appendChild(el);
    console.log('[StealthTab Content] ✅ Overlay injected');

    // ── MutationObserver guard: re-inject if tampered ──
    if (_guardObserver) _guardObserver.disconnect();
    _guardObserver = new MutationObserver(() => {
      if (document.getElementById(OVERLAY_ID)) return;  // still there
      console.warn('[StealthTab Content] ⚠️ Overlay removed — re-injecting');
      showOverlay();
    });
    _guardObserver.observe(document.documentElement, {
      childList: true,
      subtree:   true
    });
  }

  function removeOverlay() {
    if (_guardObserver) {
      _guardObserver.disconnect();
      _guardObserver = null;
    }
    const el = document.getElementById(OVERLAY_ID);
    if (el) {
      el.remove();
      console.log('[StealthTab Content] ✅ Overlay removed');
    }
    document.documentElement.style.overflow = '';
  }
})();
