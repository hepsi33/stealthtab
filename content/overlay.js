/**
 * StealthTab Overlay — Content Script
 * Renders a full-screen lock screen on locked tabs.
 * Security hardened: MutationObserver guard, activity throttling.
 */

(async () => {
  // Prevent double-injection
  if (window.__stealthTabActive) return;
  window.__stealthTabActive = true;

  let tabState = null;

  try {
    tabState = await chrome.runtime.sendMessage({ type: 'GET_TAB_STATE' });
  } catch {
    return; // Extension context gone (e.g. after reload)
  }

  if (tabState?.status === 'locked') showOverlay();

  // Listen for explicit messages from the service worker
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'SHOW_OVERLAY') showOverlay();
    if (msg.type === 'HIDE_OVERLAY') removeOverlay();
  });

  // ── Activity reporting (throttled) ──
  let throttle = false;
  function reportActivity() {
    if (throttle) return;
    throttle = true;
    chrome.runtime.sendMessage({ type: 'RESET_TAB_TIMER' }).catch(() => {});
    setTimeout(() => { throttle = false; }, 5000);
  }
  ['mousemove', 'mousedown', 'keydown', 'scroll', 'wheel', 'touchstart']
    .forEach(ev => window.addEventListener(ev, reportActivity, { passive: true }));

  // Media activity check
  setInterval(() => {
    document.querySelectorAll('video, audio').forEach(el => {
      if (!el.paused) reportActivity();
    });
  }, 10000);

  // ── Overlay functions ──
  let overlayEl   = null;
  let guardObs    = null;

  function showOverlay() {
    if (document.getElementById('__st_overlay')) return;

    overlayEl = document.createElement('div');
    overlayEl.id = '__st_overlay';

    overlayEl.innerHTML = `
      <div id="__st_card">
        <div id="__st_orb">🛡</div>
        <div id="__st_title">Tab Protected</div>
        <div id="__st_desc">
          This tab is hidden by <b>StealthTab</b>.<br>
          Click the <span id="__st_badge">🔒</span> toolbar icon to authenticate.
        </div>
        <div id="__st_rule"></div>
        <div id="__st_hint">Auto-locks after 30 minutes of inactivity.</div>
      </div>`;

    // Attach to <html>, not <body> — survives body replacement attacks
    document.documentElement.appendChild(overlayEl);

    // ── MutationObserver guard: re-inject if removed ──
    guardObs = new MutationObserver(() => {
      if (!document.getElementById('__st_overlay') && overlayEl) {
        document.documentElement.appendChild(overlayEl);
      }
    });
    guardObs.observe(document.documentElement, { childList: true });
  }

  function removeOverlay() {
    if (guardObs) { guardObs.disconnect(); guardObs = null; }
    const el = document.getElementById('__st_overlay');
    if (el) el.remove();
    overlayEl = null;
  }
})();
