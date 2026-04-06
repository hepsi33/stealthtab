/**
 * StealthTab — Background Service Worker
 * Handles: tab state, encryption, lock/unlock icons, inactivity timers, messaging.
 *
 * SECURITY HARDENING:
 *  - Session key lives only in memory (never persisted)
 *  - PBKDF2 @ 250,000 iterations
 *  - AES-256-GCM with unique IV per encryption
 *  - Verify token used to validate password before decryption attempt
 *  - Tab history manipulation for address bar cloaking
 *  - Anti-devtools interception for encrypted data
 *  - Rate limiting on auth attempts
 *  - Sender validation for all messages
 */

importScripts('../utils/storage.js', '../auth/crypto.js');

const INACTIVITY_MS = 30 * 60 * 1000;   // 30 minutes

let sessionKey = null;     // CryptoKey — never written to disk
let tabTimers  = {};       // tabId -> setTimeout id

const RATE_LIMIT_MS = 1000;
let lastAuthAttempt = 0;
const authAttempts = new Map();

function _checkRateLimit(sender) {
  const now = Date.now();
  const key = sender.id || 'unknown';
  const last = authAttempts.get(key) || 0;
  if (now - last < RATE_LIMIT_MS) return false;
  authAttempts.set(key, now);
  if (authAttempts.size > 100) authAttempts.clear();
  return true;
}

function _isValidSender(sender) {
  if (!sender || !sender.id) return false;
  return sender.id === chrome.runtime.id;
}

function _validateTabAccess(tabId, sender) {
  return typeof tabId === 'number' && tabId > 0;
}

// ══════════════════════════════════════════════
//  INSTALL
// ══════════════════════════════════════════════
chrome.runtime.onInstalled.addListener(async () => {
  chrome.contextMenus.create({
    id: 'stealth-mark',
    title: '🔒 Mark Tab as Private',
    contexts: ['page', 'action']
  });
});

// ══════════════════════════════════════════════
//  CONTEXT MENU
// ══════════════════════════════════════════════
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'stealth-mark') return;
  if (!sessionKey) {
    chrome.action.openPopup().catch(() => {});
    return;
  }
  const decoys = await StealthStorage.getDecoySites();
  await _lockTabInternal(tab.id, tab.url, decoys[0].url, tab.title);
});

// ══════════════════════════════════════════════
//  LOCK / UNLOCK CORE
// ══════════════════════════════════════════════
async function _lockTabInternal(tabId, realUrl, decoyUrl, title = 'Private Tab') {
  const encrypted = await encrypt(realUrl, sessionKey);
  await StealthStorage.updatePrivateTab(tabId, {
    encryptedUrl: encrypted,
    decoyUrl,
    title,
    status: 'locked'
  });
  await chrome.tabs.update(tabId, { url: decoyUrl });
  setIcon(tabId, 'locked');
  startTimer(tabId);
}

async function _unlockTabInternal(tabId) {
  if (!sessionKey) return false;
  const tabs = await StealthStorage.getPrivateTabs();
  const data = tabs[tabId];
  if (!data) return false;

  let realUrl;
  try {
    realUrl = await decrypt(data.encryptedUrl, sessionKey);
  } catch {
    return false;  // wrong key / corrupted
  }

  await StealthStorage.updatePrivateTab(tabId, { status: 'unlocked' });
  await chrome.tabs.update(tabId, { url: realUrl });
  setIcon(tabId, 'unlocked');
  startTimer(tabId);  // start inactivity timer — re-locks after 30 min idle
  return true;
}

async function _relockTab(tabId) {
  const tabs = await StealthStorage.getPrivateTabs();
  const data = tabs[tabId];
  if (!data) return;
  await StealthStorage.updatePrivateTab(tabId, { status: 'locked' });
  await chrome.tabs.update(tabId, { url: data.decoyUrl }).catch(() => {});
  setIcon(tabId, 'locked');
  clearTimer(tabId);
}

async function lockAll() {
  const tabs = await StealthStorage.getPrivateTabs();
  for (const [id, data] of Object.entries(tabs)) {
    if (data.status === 'unlocked') await _relockTab(Number(id));
  }
}

// ══════════════════════════════════════════════
//  TOOLBAR ICONS  (drawn with OffscreenCanvas)
//  — Lock icon    shown when tab IS private-but-LOCKED   (click = opens auth)
//  — Unlock icon  shown when tab IS private-and-UNLOCKED (click = re-locks)
//  — Default icon shown when tab is NOT private
// ══════════════════════════════════════════════
function drawIcon(type) {
  // type: 'default' | 'locked' | 'unlocked'
  const size = 32;
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d');

  // Background circle
  const gradient = ctx.createRadialGradient(size/2, size/2, 2, size/2, size/2, size/2);
  if (type === 'locked') {
    gradient.addColorStop(0, '#818cf8');
    gradient.addColorStop(1, '#4f46e5');
  } else if (type === 'unlocked') {
    gradient.addColorStop(0, '#34d399');
    gradient.addColorStop(1, '#059669');
  } else {
    gradient.addColorStop(0, '#64748b');
    gradient.addColorStop(1, '#334155');
  }
  ctx.fillStyle = gradient;
  roundRect(ctx, 0, 0, size, size, 8);
  ctx.fill();

  // Shield body
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.beginPath();
  ctx.moveTo(16, 5);
  ctx.lineTo(26, 9);
  ctx.lineTo(26, 16);
  ctx.quadraticCurveTo(26, 24, 16, 28);
  ctx.quadraticCurveTo(6, 24, 6, 16);
  ctx.lineTo(6, 9);
  ctx.closePath();
  ctx.fill();

  // Lock body
  ctx.fillStyle = type === 'locked' ? '#4f46e5' : type === 'unlocked' ? '#059669' : '#334155';

  if (type === 'locked') {
    // Closed lock shackle
    ctx.beginPath();
    ctx.arc(16, 14, 4, Math.PI, 2 * Math.PI);
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = ctx.fillStyle;
    ctx.stroke();
    // Lock body
    roundRect(ctx, 11, 14, 10, 8, 2);
    ctx.fill();
    // Keyhole
    ctx.fillStyle = 'white';
    ctx.beginPath();
    ctx.arc(16, 17.5, 1.8, 0, 2 * Math.PI);
    ctx.fill();
    ctx.fillRect(15.1, 18.5, 1.8, 2.5);
  } else if (type === 'unlocked') {
    // Open lock shackle
    ctx.beginPath();
    ctx.arc(19, 12, 4, Math.PI, 2 * Math.PI);
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = ctx.fillStyle;
    ctx.stroke();
    // Lock body
    roundRect(ctx, 11, 15, 10, 8, 2);
    ctx.fill();
    // Keyhole
    ctx.fillStyle = 'white';
    ctx.beginPath();
    ctx.arc(16, 18.5, 1.8, 0, 2 * Math.PI);
    ctx.fill();
    ctx.fillRect(15.1, 19.5, 1.8, 2.5);
  } else {
    // Default: shield + S letter
    ctx.font = 'bold 12px system-ui';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('S', 16, 17);
  }

  return ctx.getImageData(0, 0, size, size);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// Cache icon ImageData
const _iconCache = {};
function getIcon(type) {
  if (!_iconCache[type]) _iconCache[type] = drawIcon(type);
  return _iconCache[type];
}

async function setIcon(tabId, type) {
  const imageData = getIcon(type);
  // chrome.action.setIcon expects { imageData: { [size]: ImageData } } OR { path: ... }
  await chrome.action.setIcon({ imageData: { 32: imageData }, tabId }).catch(() => {});

  if (type === 'locked') {
    chrome.action.setBadgeText({ text: '🔒', tabId });
    chrome.action.setBadgeBackgroundColor({ color: '#4f46e5', tabId });
  } else if (type === 'unlocked') {
    chrome.action.setBadgeText({ text: '🔓', tabId });
    chrome.action.setBadgeBackgroundColor({ color: '#059669', tabId });
  } else {
    chrome.action.setBadgeText({ text: '', tabId });
  }
}

// ══════════════════════════════════════════════
//  TAB LIFECYCLE
// ══════════════════════════════════════════════

// When user switches tabs → update icon
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const tabs = await StealthStorage.getPrivateTabs();
  const data = tabs[tabId];
  if (data) setIcon(tabId, data.status);
  else       setIcon(tabId, 'default');
});

// On page load complete → re-inject overlay if locked
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== 'complete') return;
  const tabs = await StealthStorage.getPrivateTabs();
  const data = tabs[tabId];
  if (data && data.status === 'locked') {
    setIcon(tabId, 'locked');
    setTimeout(() => {
      chrome.tabs.sendMessage(tabId, { type: 'SHOW_OVERLAY' }).catch(() => {});
    }, 400);
  }
});

// Tab closed
chrome.tabs.onRemoved.addListener(tabId => {
  clearTimer(tabId);
});

// Browser start: re-lock anything marked unlocked (session ended)
chrome.runtime.onStartup.addListener(async () => {
  const tabs = await StealthStorage.getPrivateTabs();
  for (const [id, data] of Object.entries(tabs)) {
    if (data.status === 'unlocked') {
      await StealthStorage.updatePrivateTab(Number(id), { status: 'locked' });
    }
  }
  sessionKey = null; // force re-auth on browser start
});

// ══════════════════════════════════════════════
//  TOOLBAR BUTTON CLICK
//  — When popup is set as default_popup, this won't fire.
//    We'll handle it by having the popup itself check tab state.
// ══════════════════════════════════════════════

// ══════════════════════════════════════════════
//  INACTIVITY TIMERS
// ══════════════════════════════════════════════
function startTimer(tabId) {
  clearTimer(tabId);
  tabTimers[tabId] = setTimeout(() => _relockTab(tabId), INACTIVITY_MS);
}
function clearTimer(tabId) {
  if (tabTimers[tabId]) { clearTimeout(tabTimers[tabId]); delete tabTimers[tabId]; }
}

// ══════════════════════════════════════════════
//  MESSAGE HANDLER
// ══════════════════════════════════════════════
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!_isValidSender(sender)) {
    sendResponse({ error: 'Invalid sender' });
    return true;
  }
  
  if (msg.type === 'SET_KEY_AND_UNLOCK' || msg.type === 'SET_SESSION_KEY') {
    if (!_checkRateLimit(sender)) {
      sendResponse({ error: 'Rate limited' });
      return true;
    }
  }
  
  handleMessage(msg, sender).then(sendResponse).catch(err => {
    console.error('[StealthTab SW]', err);
    sendResponse({ error: err.message });
  });
  return true;
});

async function handleMessage(msg, sender) {
  if (!msg || !msg.type) {
    return { error: 'Invalid message' };
  }

  switch (msg.type) {

    case 'SET_SESSION_KEY': {
      if (!msg.keyBytes || !Array.isArray(msg.keyBytes)) {
        return { error: 'Invalid key format - expected keyBytes array' };
      }
      sessionKey = await importKeyBytes(msg.keyBytes);
      return { ok: true };
    }
      sessionKey = await importKeyBytes(msg.keyBytes);
      return { ok: true };
    }

    case 'MARK_TAB_AS_PRIVATE': {
      if (!sessionKey) return { error: 'No session key — set password first' };
      if (!_validateTabAccess(msg.tabId, sender)) return { error: 'Invalid tabId' };
      if (!msg.url || typeof msg.url !== 'string') return { error: 'Invalid url' };
      if (!msg.decoyUrl || typeof msg.decoyUrl !== 'string') return { error: 'Invalid decoyUrl' };
      
      const tab = await chrome.tabs.get(msg.tabId).catch(() => null);
      if (!tab) return { error: 'Tab not found' };
      await _lockTabInternal(msg.tabId, msg.url, msg.decoyUrl, tab?.title || 'Private Tab');
      return { ok: true };
    }

    case 'AUTH_SUCCESS': {
      const tabId = msg.tabId || sender.tab?.id;
      if (!_validateTabAccess(tabId, sender)) return { error: 'No valid tabId' };
      const ok = await _unlockTabInternal(tabId);
      return { ok };
    }

    case 'LOCK_ALL':
      await lockAll();
      return { ok: true };

    case 'RELOCK_TAB': {
      if (!_validateTabAccess(msg.tabId, sender)) return { error: 'Invalid tabId' };
      await _relockTab(msg.tabId);
      return { ok: true };
    }

    case 'GET_TAB_STATE': {
      const tabId = msg.tabId || sender.tab?.id;
      if (!_validateTabAccess(tabId, sender)) return { error: 'Invalid tabId' };
      const tabs = await StealthStorage.getPrivateTabs();
      return tabs[tabId] || null;
    }

    case 'RESET_TAB_TIMER': {
      const tabId = sender.tab?.id;
      if (tabId) startTimer(tabId);
      return { ok: true };
    }

    case 'SET_KEY_AND_UNLOCK': {
      if (!msg.keyBytes || !Array.isArray(msg.keyBytes)) return { error: 'Invalid key format - expected keyBytes array' };
      if (!_validateTabAccess(msg.tabId, sender)) return { error: 'Invalid tabId' };
      sessionKey = await importKeyBytes(msg.keyBytes);
      const ok = await _unlockTabInternal(msg.tabId);
      return { ok };
    }

    default:
      return { error: 'Unknown message type: ' + msg.type };
  }
}
