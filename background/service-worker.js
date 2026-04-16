/**
 * StealthTab — Background Service Worker v2.0
 *
 * SECURITY MODEL:
 *  ✅ AES-256-GCM encryption, PBKDF2 310k iterations
 *  ✅ Session key in memory only — never persisted
 *  ✅ CryptoKey bytes included in MARK_TAB_AS_PRIVATE (SW-death-safe)
 *  ✅ webNavigation.onCommitted — intercepts history restore, back button, manual URL
 *  ✅ tabs.onUpdated — redirects locked tabs navigating off-decoy
 *  ✅ tabs.onActivated — enforces redirect + correct icon on tab switch
 *  ✅ Rate limiting on auth attempts
 *  ✅ Sender validation
 *  ✅ Full console logging for debugging
 */

importScripts('../utils/storage.js', '../auth/crypto.js');

// ── Constants ─────────────────────────────────────────────────────────────
const INACTIVITY_MS  = 30 * 60 * 1000;  // 30 minutes
const RATE_LIMIT_MS  = 1500;             // min ms between auth attempts

// ── In-memory state (lost on SW termination — by design) ──────────────────
let sessionKey  = null;   // CryptoKey — NEVER written to disk
let tabTimers   = {};     // tabId → setTimeout handle
const authAttempts = new Map();   // sender.id → last attempt timestamp

// ── Redirect guard (prevents infinite redirect loops) ─────────────────────
const _redirectingTabs = new Set();

console.log('[StealthTab SW] 🚀 Service worker started');

// ══════════════════════════════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════════════════════════════

function _checkRateLimit(sender) {
  const now  = Date.now();
  const id   = sender?.id || 'unknown';
  const last = authAttempts.get(id) || 0;
  if (now - last < RATE_LIMIT_MS) {
    console.warn('[StealthTab SW] ⚠️ Rate limit hit from:', id);
    return false;
  }
  authAttempts.set(id, now);
  if (authAttempts.size > 100) authAttempts.clear();
  return true;
}

function _isValidSender(sender) {
  if (!sender) return false;
  // Extension pages (popup, auth.html) — sender.id is the extension ID
  if (sender.id === chrome.runtime.id) return true;
  // Fallback: check URL for extension pages opened as windows
  if (sender.url && sender.url.startsWith('chrome-extension://' + chrome.runtime.id)) return true;
  return false;
}

function _isValidTabId(tabId) {
  return typeof tabId === 'number' && tabId > 0;
}

/** Returns true if url belongs to the same origin as decoyUrl */
function _urlMatchesDecoy(url, decoyUrl) {
  try {
    const decoyOrigin = new URL(decoyUrl).origin;
    return url.startsWith(decoyOrigin);
  } catch {
    return url === decoyUrl;
  }
}

// ══════════════════════════════════════════════════════════════════════════
//  INSTALL / STARTUP
// ══════════════════════════════════════════════════════════════════════════

chrome.runtime.onInstalled.addListener(async (details) => {
  console.log('[StealthTab SW] 🔧 onInstalled:', details.reason);

  // Create context menu — reuse: remove first to avoid duplicate error
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'stealth-mark',
      title: '🔒 Mark Tab as Private (StealthTab)',
      contexts: ['page', 'action']
    });
  });

  // On fresh install, clear any stale data
  if (details.reason === 'install') {
    await chrome.storage.local.clear();
    console.log('[StealthTab SW] 🗑️ Cleared storage on fresh install');
  }
});

/** On browser start: force-lock all previously-unlocked tabs (session ended) */
chrome.runtime.onStartup.addListener(async () => {
  console.log('[StealthTab SW] 🌅 Browser started — re-locking all private tabs');
  sessionKey = null;   // CryptoKey is gone — force re-auth
  const all = await StealthStorage.getPrivateTabs();
  for (const [idStr, data] of Object.entries(all)) {
    if (data.status === 'unlocked') {
      await StealthStorage.updatePrivateTab(Number(idStr), { status: 'locked' });
      console.log(`[StealthTab SW] 🔒 Re-locked tab ${idStr} on startup`);
    }
  }
});

// ══════════════════════════════════════════════════════════════════════════
//  CORE LOCK / UNLOCK
// ══════════════════════════════════════════════════════════════════════════

/**
 * Lock a tab: encrypt real URL, store, navigate to decoy.
 * @param {number} tabId
 * @param {string} realUrl
 * @param {string} decoyUrl
 * @param {string} title
 * @param {CryptoKey} key  — the session key to use for encryption
 */
async function _lockTabInternal(tabId, realUrl, decoyUrl, title, key) {
  if (!key) throw new Error('No encryption key available');

  console.log(`[StealthTab SW] 🔒 Locking tab ${tabId}: "${realUrl}" → "${decoyUrl}"`);

  const encryptedUrl = await encrypt(realUrl, key);

  await StealthStorage.updatePrivateTab(tabId, {
    encryptedUrl,
    decoyUrl,
    title:  title || 'Private Tab',
    status: 'locked'
  });

  // Navigate to decoy (guard against re-entrant redirect detection)
  _redirectingTabs.add(tabId);
  try {
    await chrome.tabs.update(tabId, { url: decoyUrl });
  } finally {
    setTimeout(() => _redirectingTabs.delete(tabId), 2000);
  }

  await setIcon(tabId, 'locked');
  startTimer(tabId);

  console.log(`[StealthTab SW] ✅ Tab ${tabId} locked successfully`);
}

/**
 * Unlock a tab: decrypt real URL, navigate back.
 * @param {number} tabId
 * @returns {boolean}
 */
async function _unlockTabInternal(tabId) {
  if (!sessionKey) {
    console.warn(`[StealthTab SW] ⚠️ Cannot unlock tab ${tabId} — no session key`);
    return false;
  }

  const all  = await StealthStorage.getPrivateTabs();
  const data = all[tabId];
  if (!data) {
    console.warn(`[StealthTab SW] ⚠️ Tab ${tabId} not found in private tabs`);
    return false;
  }

  let realUrl;
  try {
    realUrl = await decrypt(data.encryptedUrl, sessionKey);
    console.log(`[StealthTab SW] 🔓 Decrypted URL for tab ${tabId}: ${realUrl}`);
  } catch (err) {
    console.error(`[StealthTab SW] ❌ Decryption failed for tab ${tabId}:`, err.message);
    return false;
  }

  await StealthStorage.updatePrivateTab(tabId, { status: 'unlocked' });

  _redirectingTabs.add(tabId);
  try {
    await chrome.tabs.update(tabId, { url: realUrl });
  } finally {
    setTimeout(() => _redirectingTabs.delete(tabId), 2000);
  }

  await setIcon(tabId, 'unlocked');
  startTimer(tabId);

  console.log(`[StealthTab SW] ✅ Tab ${tabId} unlocked, navigating to real URL`);
  return true;
}

/**
 * Re-lock an unlocked private tab (inactivity timeout or manual re-lock).
 */
async function _relockTab(tabId) {
  const all  = await StealthStorage.getPrivateTabs();
  const data = all[tabId];
  if (!data) return;

  console.log(`[StealthTab SW] 🔒 Re-locking tab ${tabId}`);

  await StealthStorage.updatePrivateTab(tabId, { status: 'locked' });

  _redirectingTabs.add(tabId);
  try {
    await chrome.tabs.update(tabId, { url: data.decoyUrl }).catch(() => {});
  } finally {
    setTimeout(() => _redirectingTabs.delete(tabId), 2000);
  }

  await setIcon(tabId, 'locked');
  clearTimer(tabId);

  // Notify content script
  chrome.tabs.sendMessage(tabId, { type: 'SHOW_OVERLAY' }).catch(() => {});
}

async function lockAll() {
  const all = await StealthStorage.getPrivateTabs();
  const tasks = Object.entries(all)
    .filter(([, d]) => d.status === 'unlocked')
    .map(([id]) => _relockTab(Number(id)));
  await Promise.all(tasks);
  console.log('[StealthTab SW] 🔒 All tabs locked');
}

// ══════════════════════════════════════════════════════════════════════════
//  REDIRECT ENFORCEMENT
//  These listeners are the PRIMARY security wall.
//  They intercept ANY navigation on locked tabs and force back to decoy.
// ══════════════════════════════════════════════════════════════════════════

/**
 * PART 1 + 4 + 7:
 * webNavigation.onCommitted catches: typed URLs, history restore, back/forward,
 * Ctrl+Shift+T session restore — BEFORE the page has a chance to load.
 */
chrome.webNavigation.onCommitted.addListener(async ({ tabId, url, frameId }) => {
  // Only handle top-level frames (frameId 0 = main frame)
  if (frameId !== 0) return;

  // Skip chrome:// and extension:// pages
  if (!url || url.startsWith('chrome') || url.startsWith('about:')) return;

  // Skip if we triggered this redirect ourselves
  if (_redirectingTabs.has(tabId)) return;

  const all  = await StealthStorage.getPrivateTabs();
  const data = all[tabId];
  if (!data || data.status !== 'locked') return;

  // If navigating within the decoy's domain → allow it (e.g. clicking within LinkedIn)
  if (_urlMatchesDecoy(url, data.decoyUrl)) {
    console.log(`[StealthTab SW] ✅ Navigation within decoy domain on tab ${tabId} — allowed`);
    return;
  }

  // Locked tab trying to navigate somewhere other than decoy → BLOCK + redirect
  console.log(`[StealthTab SW] 🚨 BLOCKED navigation on locked tab ${tabId}: ${url}  →  ${data.decoyUrl}`);

  _redirectingTabs.add(tabId);
  chrome.tabs.update(tabId, { url: data.decoyUrl }).catch(() => {});
  setTimeout(() => _redirectingTabs.delete(tabId), 2000);
});

/**
 * PART 1 + 5:
 * tabs.onUpdated — catches page load completion for locked tabs.
 * Re-injects overlay and enforces decoy if URL drifted.
 */
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;

  const all  = await StealthStorage.getPrivateTabs();
  const data = all[tabId];

  if (!data) return;

  if (data.status === 'locked') {
    console.log(`[StealthTab SW] 🔒 Tab ${tabId} loaded (locked). URL: ${tab.url}`);
    await setIcon(tabId, 'locked');

    // If page URL doesn't match decoy → redirect (safety net)
    if (tab.url && !_urlMatchesDecoy(tab.url, data.decoyUrl) && !_redirectingTabs.has(tabId)) {
      console.log(`[StealthTab SW] 🚨 Tab ${tabId} URL drifted off decoy — redirecting`);
      _redirectingTabs.add(tabId);
      chrome.tabs.update(tabId, { url: data.decoyUrl }).catch(() => {});
      setTimeout(() => _redirectingTabs.delete(tabId), 2000);
      return;
    }

    // Re-inject overlay after decoy page loads
    setTimeout(() => {
      chrome.tabs.sendMessage(tabId, { type: 'SHOW_OVERLAY' }).catch(() => {});
    }, 500);

  } else if (data.status === 'unlocked') {
    await setIcon(tabId, 'unlocked');
  }
});

/**
 * PART 1 + 3:
 * tabs.onActivated — update icon + enforce decoy when user switches to a locked tab.
 */
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  console.log(`[StealthTab SW] 👁️ Tab ${tabId} activated`);

  const all  = await StealthStorage.getPrivateTabs();
  const data = all[tabId];

  if (!data) {
    await setIcon(tabId, 'default');
    return;
  }

  await setIcon(tabId, data.status);

  // If locked and tab's URL has somehow drifted → redirect
  if (data.status === 'locked' && !_redirectingTabs.has(tabId)) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab && tab.url && !_urlMatchesDecoy(tab.url, data.decoyUrl)) {
      console.log(`[StealthTab SW] 🚨 Locked tab ${tabId} not at decoy on activation — redirecting`);
      _redirectingTabs.add(tabId);
      chrome.tabs.update(tabId, { url: data.decoyUrl }).catch(() => {});
      setTimeout(() => _redirectingTabs.delete(tabId), 2000);
    }
  }
});

/** Clean up when tab is closed */
chrome.tabs.onRemoved.addListener(async (tabId) => {
  clearTimer(tabId);
  _redirectingTabs.delete(tabId);
  // Remove from private tabs storage
  await StealthStorage.removePrivateTab(tabId).catch(() => {});
  console.log(`[StealthTab SW] 🗑️ Tab ${tabId} closed, cleaned up`);
});

// ══════════════════════════════════════════════════════════════════════════
//  CONTEXT MENU
// ══════════════════════════════════════════════════════════════════════════

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'stealth-mark') return;

  if (!sessionKey) {
    console.warn('[StealthTab SW] Context menu: no session key, opening popup');
    chrome.action.openPopup().catch(() => {});
    return;
  }

  const decoys = await StealthStorage.getDecoySites();
  await _lockTabInternal(tab.id, tab.url, decoys[0].url, tab.title, sessionKey);
});

// ══════════════════════════════════════════════════════════════════════════
//  TOOLBAR ICONS  (OffscreenCanvas — drawn dynamically)
// ══════════════════════════════════════════════════════════════════════════

function _drawIcon(type) {
  const S = 32;
  const cv  = new OffscreenCanvas(S, S);
  const ctx = cv.getContext('2d');

  // Background pill
  const g = ctx.createRadialGradient(S/2, S/2, 2, S/2, S/2, S/2);
  if (type === 'locked') {
    g.addColorStop(0, '#818cf8'); g.addColorStop(1, '#4f46e5');
  } else if (type === 'unlocked') {
    g.addColorStop(0, '#34d399'); g.addColorStop(1, '#059669');
  } else {
    g.addColorStop(0, '#64748b'); g.addColorStop(1, '#334155');
  }
  ctx.fillStyle = g;
  _roundRect(ctx, 0, 0, S, S, 8); ctx.fill();

  // White shield
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.beginPath();
  ctx.moveTo(16,5); ctx.lineTo(26,9); ctx.lineTo(26,16);
  ctx.quadraticCurveTo(26,24,16,28);
  ctx.quadraticCurveTo(6,24,6,16); ctx.lineTo(6,9);
  ctx.closePath(); ctx.fill();

  // Lock symbol inside shield
  const lockColor = type === 'locked' ? '#4f46e5' : type === 'unlocked' ? '#059669' : '#334155';
  ctx.fillStyle = lockColor;
  ctx.strokeStyle = lockColor;

  if (type === 'locked') {
    // Closed shackle
    ctx.beginPath(); ctx.arc(16,14,4,Math.PI,2*Math.PI);
    ctx.lineWidth = 2.5; ctx.stroke();
    _roundRect(ctx,11,14,10,8,2); ctx.fill();
    ctx.fillStyle='white';
    ctx.beginPath(); ctx.arc(16,17.5,1.8,0,2*Math.PI); ctx.fill();
    ctx.fillRect(15.1,18.5,1.8,2.5);
  } else if (type === 'unlocked') {
    // Open shackle
    ctx.beginPath(); ctx.arc(20,12,4,Math.PI,2*Math.PI);
    ctx.lineWidth = 2.5; ctx.stroke();
    _roundRect(ctx,11,15,10,8,2); ctx.fill();
    ctx.fillStyle='white';
    ctx.beginPath(); ctx.arc(16,18.5,1.8,0,2*Math.PI); ctx.fill();
    ctx.fillRect(15.1,19.5,1.8,2.5);
  } else {
    // Default: "ST" text
    ctx.font='bold 9px system-ui'; ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillText('ST',16,17);
  }
  return ctx.getImageData(0, 0, S, S);
}

function _roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x+r,y); ctx.lineTo(x+w-r,y);
  ctx.quadraticCurveTo(x+w,y,x+w,y+r); ctx.lineTo(x+w,y+h-r);
  ctx.quadraticCurveTo(x+w,y+h,x+w-r,y+h); ctx.lineTo(x+r,y+h);
  ctx.quadraticCurveTo(x,y+h,x,y+h-r); ctx.lineTo(x,y+r);
  ctx.quadraticCurveTo(x,y,x+r,y); ctx.closePath();
}

const _iconCache = {};
function _getIconData(type) {
  if (!_iconCache[type]) _iconCache[type] = _drawIcon(type);
  return _iconCache[type];
}

async function setIcon(tabId, type) {
  try {
    const imageData = _getIconData(type);
    await chrome.action.setIcon({ imageData: { 32: imageData }, tabId });
  } catch (e) {
    // Fallback: use badge text only if setIcon fails
    console.warn('[StealthTab SW] setIcon failed, using badge fallback:', e.message);
  }

  // Set badge text always (visible even if icon drawing fails)
  try {
    if (type === 'locked') {
      chrome.action.setBadgeText({ text: '🔒', tabId });
      chrome.action.setBadgeBackgroundColor({ color: '#4f46e5', tabId });
      chrome.action.setTitle({ title: 'StealthTab — Tab Locked 🔒 (click to unlock)', tabId });
    } else if (type === 'unlocked') {
      chrome.action.setBadgeText({ text: '🔓', tabId });
      chrome.action.setBadgeBackgroundColor({ color: '#059669', tabId });
      chrome.action.setTitle({ title: 'StealthTab — Tab Unlocked 🔓 (click to manage)', tabId });
    } else {
      chrome.action.setBadgeText({ text: '', tabId });
      chrome.action.setTitle({ title: 'StealthTab — Click to protect this tab', tabId });
    }
  } catch (e) { /* ignore */ }
}

// ══════════════════════════════════════════════════════════════════════════
//  INACTIVITY TIMERS
// ══════════════════════════════════════════════════════════════════════════

function startTimer(tabId) {
  clearTimer(tabId);
  tabTimers[tabId] = setTimeout(async () => {
    console.log(`[StealthTab SW] ⏰ Inactivity timeout for tab ${tabId} — re-locking`);
    await _relockTab(tabId);
  }, INACTIVITY_MS);
}

function clearTimer(tabId) {
  if (tabTimers[tabId]) {
    clearTimeout(tabTimers[tabId]);
    delete tabTimers[tabId];
  }
}

// ══════════════════════════════════════════════════════════════════════════
//  MESSAGE HANDLER
// ══════════════════════════════════════════════════════════════════════════

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Validate sender
  if (!_isValidSender(sender)) {
    console.warn('[StealthTab SW] ❌ Rejected message from invalid sender:', sender);
    sendResponse({ error: 'Invalid sender' });
    return true;
  }

  // Rate limit auth operations
  if (msg.type === 'SET_KEY_AND_UNLOCK' || msg.type === 'SET_SESSION_KEY') {
    if (!_checkRateLimit(sender)) {
      sendResponse({ error: 'Rate limited — please wait a moment' });
      return true;
    }
  }

  handleMessage(msg, sender)
    .then(sendResponse)
    .catch(err => {
      console.error('[StealthTab SW] ❌ Message handler error:', err);
      sendResponse({ error: err.message });
    });

  return true;  // Keep message channel open for async response
});

async function handleMessage(msg, sender) {
  if (!msg || !msg.type) return { error: 'Invalid message — missing type' };

  console.log(`[StealthTab SW] 📨 Message received: ${msg.type}`);

  switch (msg.type) {

    // ── SET_SESSION_KEY ──────────────────────────────────────────────────
    // Popup sets the key after password derivation (for context-menu locking)
    case 'SET_SESSION_KEY': {
      if (!Array.isArray(msg.keyBytes) || msg.keyBytes.length !== 32) {
        return { error: 'Invalid keyBytes — expected 32-byte array' };
      }
      sessionKey = await importKeyBytes(msg.keyBytes);
      console.log('[StealthTab SW] 🔑 Session key set');
      return { ok: true };
    }

    // ── MARK_TAB_AS_PRIVATE ───────────────────────────────────────────────
    // CRITICAL: keyBytes included directly — no dependency on prior SET_SESSION_KEY.
    // This makes each lock operation self-contained even if SW was killed/restarted.
    case 'MARK_TAB_AS_PRIVATE': {
      if (!_isValidTabId(msg.tabId))                              return { error: 'Invalid tabId' };
      if (!msg.url    || typeof msg.url    !== 'string')          return { error: 'Invalid url' };
      if (!msg.decoyUrl || typeof msg.decoyUrl !== 'string')      return { error: 'Invalid decoyUrl' };
      if (!Array.isArray(msg.keyBytes) || msg.keyBytes.length !== 32)
                                                                  return { error: 'Invalid keyBytes' };

      // Import key from bytes — CryptoKey is NOT serializable via postMessage
      const key  = await importKeyBytes(msg.keyBytes);
      sessionKey = key;  // Cache for subsequent operations in this SW lifetime

      const tab = await chrome.tabs.get(msg.tabId).catch(() => null);
      if (!tab) return { error: `Tab ${msg.tabId} not found — may have been closed` };

      await _lockTabInternal(msg.tabId, msg.url, msg.decoyUrl, tab.title || 'Private Tab', key);
      return { ok: true };
    }

    // ── SET_KEY_AND_UNLOCK ───────────────────────────────────────────────
    // auth.html sends this after password/biometric verification
    case 'SET_KEY_AND_UNLOCK': {
      if (!_isValidTabId(msg.tabId))                                  return { error: 'Invalid tabId' };
      if (!Array.isArray(msg.keyBytes) || msg.keyBytes.length !== 32) return { error: 'Invalid keyBytes' };

      sessionKey = await importKeyBytes(msg.keyBytes);
      console.log(`[StealthTab SW] 🔑 Key received, unlocking tab ${msg.tabId}`);

      const ok = await _unlockTabInternal(msg.tabId);
      return { ok };
    }

    // ── AUTH_SUCCESS (biometric path — uses existing session key) ────────
    case 'AUTH_SUCCESS': {
      const tabId = msg.tabId || sender.tab?.id;
      if (!_isValidTabId(tabId)) return { error: 'No valid tabId' };
      const ok = await _unlockTabInternal(tabId);
      console.log(`[StealthTab SW] 🔑 AUTH_SUCCESS for tab ${tabId}: ${ok}`);
      return { ok };
    }

    // ── LOCK_ALL ─────────────────────────────────────────────────────────
    case 'LOCK_ALL': {
      await lockAll();
      return { ok: true };
    }

    // ── RELOCK_TAB ───────────────────────────────────────────────────────
    case 'RELOCK_TAB': {
      if (!_isValidTabId(msg.tabId)) return { error: 'Invalid tabId' };
      await _relockTab(msg.tabId);
      return { ok: true };
    }

    // ── GET_TAB_STATE ────────────────────────────────────────────────────
    case 'GET_TAB_STATE': {
      const tabId = msg.tabId != null ? msg.tabId : sender.tab?.id;
      if (!_isValidTabId(tabId)) return null;
      const all = await StealthStorage.getPrivateTabs();
      const state = all[tabId] || null;
      console.log(`[StealthTab SW] ℹ️ GET_TAB_STATE tab ${tabId}:`, state?.status || 'not private');
      return state;
    }

    // ── RESET_TAB_TIMER ──────────────────────────────────────────────────
    case 'RESET_TAB_TIMER': {
      const tabId = sender.tab?.id;
      if (_isValidTabId(tabId)) startTimer(tabId);
      return { ok: true };
    }

    // ── GET_ALL_PRIVATE_TABS ─────────────────────────────────────────────
    case 'GET_ALL_PRIVATE_TABS': {
      const all = await StealthStorage.getPrivateTabs();
      return { tabs: all };
    }

    default:
      console.warn('[StealthTab SW] ❓ Unknown message type:', msg.type);
      return { error: 'Unknown message type: ' + msg.type };
  }
}
