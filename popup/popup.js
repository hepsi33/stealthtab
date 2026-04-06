/**
 * StealthTab Popup Controller — 4-Step Wizard
 *
 * RULES:
 *  - NO inline event handlers anywhere (MV3 CSP)
 *  - All dynamic elements use event delegation with data-* attributes
 *  - addEventListener only, never onclick=""
 */

const DECOY_SITES = [
  { name: 'LinkedIn',  url: 'https://www.linkedin.com',  emoji: '💼' },
  { name: 'YouTube',   url: 'https://www.youtube.com',   emoji: '▶️' },
  { name: 'Google',    url: 'https://www.google.com',    emoji: '🔍' },
  { name: 'GitHub',    url: 'https://github.com',        emoji: '🐙' },
  { name: 'Wikipedia', url: 'https://www.wikipedia.org', emoji: '📖' },
  { name: 'Reddit',    url: 'https://www.reddit.com',    emoji: '👾' },
  { name: 'Custom URL', url: '__custom__',               emoji: '✏️'  },
];

// ── State ──
let allTabs        = [];
let selectedTabIds = new Set();
let decoyMap       = {};   // tabId -> url string
let authMethod     = 'password';

const $ = id => document.getElementById(id);

// ══════════════════════════════════════════════
//  INIT
// ══════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', async () => {
  // Wire all static button listeners up front
  $('select-all-btn').addEventListener('click', onSelectAll);
  $('next-1').addEventListener('click', onNext1);
  $('next-2').addEventListener('click', () => showView(3));
  $('back-2').addEventListener('click', () => showView(1));
  $('back-3').addEventListener('click', () => showView(2));
  $('next-3').addEventListener('click', onNext3);
  $('btn-manage').addEventListener('click', () => { showView(5); renderLockedList(); });
  $('btn-lock-all').addEventListener('click', () => sendMsg({ type: 'LOCK_ALL' }));
  $('btn-lock-all-2').addEventListener('click', () => sendMsg({ type: 'LOCK_ALL' }).then(() => renderLockedList()));
  $('btn-add-more').addEventListener('click', () => { selectedTabIds.clear(); decoyMap = {}; loadTabs(); showView(1); });
  $('card-password').addEventListener('click', () => selectAuth('password'));
  $('card-biometric').addEventListener('click', () => selectAuth('biometric'));
  $('pw-new').addEventListener('input', e => checkStrength(e.target.value));

  // ── CRITICAL: if current active tab is locked → open auth popup immediately ──
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeTab) {
      const state = await sendMsg({ type: 'GET_TAB_STATE', tabId: activeTab.id });
      if (state && state.status === 'locked') {
        // Open auth window and close this popup
        chrome.windows.create({
          url: chrome.runtime.getURL('auth/auth.html?tabId=' + activeTab.id),
          type: 'popup', width: 420, height: 520
        });
        window.close();
        return;
      }
    }
  } catch (e) {
    // Ignore — may happen on extension pages
  }

  // Check if we already have locked tabs → manage view
  const existing  = await StealthStorage.getPrivateTabs();
  const hasSalt   = await StealthStorage.get('masterSalt');
  if (Object.keys(existing).length > 0 && hasSalt) {
    showView(5);
    renderLockedList();
    return;
  }

  loadTabs();
});

// ══════════════════════════════════════════════
//  VIEW 1 — SELECT TABS
// ══════════════════════════════════════════════
async function loadTabs() {
  try {
    allTabs = await chrome.tabs.query({ currentWindow: true });
    allTabs = allTabs.filter(t =>
      t.url &&
      !t.url.startsWith('chrome://') &&
      !t.url.startsWith('chrome-extension://') &&
      !t.url.startsWith('about:') &&
      !t.url.startsWith('edge://')
    );
  } catch (e) {
    allTabs = [];
  }
  renderTabList();
}

function renderTabList() {
  const list = $('tab-list');
  if (!allTabs.length) {
    list.innerHTML = `<div class="empty"><div class="empty-icon">🌐</div><p>No regular tabs found in this window.</p></div>`;
    updateSelCount();
    return;
  }

  list.innerHTML = allTabs.map(tab => {
    const sel      = selectedTabIds.has(tab.id);
    const hostname = safeHostname(tab.url);
    const favicon  = tab.favIconUrl || '';
    return `
      <div class="tab-item${sel ? ' selected' : ''}" data-tabid="${tab.id}">
        <div class="tab-check">
          <svg viewBox="0 0 12 12" fill="none" stroke="white" stroke-width="2.5"
               stroke-linecap="round" stroke-linejoin="round">
            <polyline points="1,6 4,10 11,2"></polyline>
          </svg>
        </div>
        <img class="tab-favicon" src="${escAttr(favicon)}" alt=""
             onerror="this.style.visibility='hidden'">
        <div class="tab-info">
          <div class="tab-name">${escHtml(tab.title || 'Untitled')}</div>
          <div class="tab-url">${escHtml(hostname)}</div>
        </div>
      </div>`;
  }).join('');

  // Event delegation — no inline onclick
  list.querySelectorAll('.tab-item').forEach(el => {
    el.addEventListener('click', () => {
      const id = parseInt(el.dataset.tabid, 10);
      if (selectedTabIds.has(id)) selectedTabIds.delete(id);
      else selectedTabIds.add(id);
      renderTabList();
    });
  });

  updateSelCount();
}

function onSelectAll() {
  if (selectedTabIds.size === allTabs.length) selectedTabIds.clear();
  else allTabs.forEach(t => selectedTabIds.add(t.id));
  renderTabList();
}

function updateSelCount() {
  const n = selectedTabIds.size;
  $('sel-count').textContent = `${n} selected`;
  $('next-1').disabled = n === 0;
}

function onNext1() {
  allTabs.filter(t => selectedTabIds.has(t.id)).forEach(tab => {
    if (!decoyMap[tab.id]) decoyMap[tab.id] = DECOY_SITES[0].url;
  });
  renderDecoyPicker();
  showView(2);
}

// ══════════════════════════════════════════════
//  VIEW 2 — DECOY PICKER
// ══════════════════════════════════════════════
function renderDecoyPicker() {
  const selectedTabs = allTabs.filter(t => selectedTabIds.has(t.id));
  const container    = $('decoy-list');

  container.innerHTML = selectedTabs.map(tab => {
    const currentDecoy = decoyMap[tab.id] || DECOY_SITES[0].url;
    const isCustom     = currentDecoy === '__custom__' || !DECOY_SITES.find(d => d.url === currentDecoy);
    return `
      <div class="decoy-entry" data-entryid="${tab.id}">
        <div class="decoy-entry-label">
          <img src="${escAttr(tab.favIconUrl || '')}" alt=""
               style="width:13px;height:13px;border-radius:3px;vertical-align:middle"
               onerror="this.style.display='none'">
          ${escHtml(tab.title || 'Tab')}
        </div>
        <div class="decoy-chips">
          ${DECOY_SITES.map((d, i) => {
            const isActive = (d.url !== '__custom__' && currentDecoy === d.url) ||
                             (d.url === '__custom__' && isCustom);
            return `<div class="chip${isActive ? ' active' : ''}"
                         data-tabid="${tab.id}" data-url="${escAttr(d.url)}" data-idx="${i}">
                      ${d.emoji} ${d.name}
                    </div>`;
          }).join('')}
        </div>
        <input type="url" class="custom-url${isCustom ? ' show' : ''}"
               id="custom-${tab.id}"
               placeholder="https://example.com"
               value="${isCustom && currentDecoy !== '__custom__' ? escAttr(currentDecoy) : ''}">
      </div>`;
  }).join('');

  // Chip click — event delegation
  container.querySelectorAll('.chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const tabId = parseInt(chip.dataset.tabid, 10);
      const url   = chip.dataset.url;
      const idx   = parseInt(chip.dataset.idx, 10);
      const entry = chip.closest('.decoy-entry');
      const input = entry.querySelector('.custom-url');

      if (url === '__custom__') {
        decoyMap[tabId] = '__custom__';
        input.classList.add('show');
        input.focus();
      } else {
        decoyMap[tabId] = url;
        input.classList.remove('show');
      }
      entry.querySelectorAll('.chip').forEach((c, i) => c.classList.toggle('active', i === idx));
    });
  });

  // Custom URL input
  container.querySelectorAll('.custom-url').forEach(input => {
    const tabId = parseInt(input.id.replace('custom-', ''), 10);
    input.addEventListener('input', () => { decoyMap[tabId] = input.value.trim(); });
  });
}

// ══════════════════════════════════════════════
//  VIEW 3 — AUTH SETUP
// ══════════════════════════════════════════════
function selectAuth(method) {
  authMethod = method;
  $('card-password').classList.toggle('selected', method === 'password');
  $('card-biometric').classList.toggle('selected', method === 'biometric');
  $('setup-password').style.display = method === 'password' ? 'block' : 'none';
  $('setup-biometric').style.display = method === 'biometric' ? 'block' : 'none';
}

function checkStrength(pw) {
  const bar  = $('pw-strength');
  const hint = $('pw-hint');
  let score = 0;
  if (pw.length >= 8)           score++;
  if (pw.length >= 12)          score++;
  if (/[A-Z]/.test(pw))         score++;
  if (/[0-9]/.test(pw))         score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;
  const cfg = [
    { w: '15%',  bg: '#ef4444', lbl: 'Too short'     },
    { w: '35%',  bg: '#f97316', lbl: 'Weak'          },
    { w: '60%',  bg: '#eab308', lbl: 'Fair'          },
    { w: '80%',  bg: '#22c55e', lbl: 'Strong'        },
    { w: '100%', bg: '#10b981', lbl: 'Very strong ✓' },
  ];
  const c          = cfg[Math.min(score, 4)];
  bar.style.width      = c.w;
  bar.style.background = c.bg;
  hint.textContent     = c.lbl;
  hint.style.color     = c.bg;
}

async function onNext3() {
  const msgEl = $('auth-msg');
  showMsg(msgEl, '', '');

  let password = '';
  if (authMethod === 'password') {
    password        = $('pw-new').value;
    const confirm   = $('pw-confirm').value;
    if (password.length < 8) {
      showMsg(msgEl, 'Password must be at least 8 characters.', 'err'); return;
    }
    if (password !== confirm) {
      showMsg(msgEl, 'Passwords do not match.', 'err'); return;
    }
  } else {
    // Biometric: require backup password
    password = $('pw-backup').value;
    if (password.length < 8) {
      showMsg(msgEl, 'Backup password must be at least 8 characters.', 'err'); return;
    }
  }

  const btn = $('next-3');
  btn.textContent = '⏳ Encrypting…';
  btn.disabled    = true;

  try {
    // 1. Derive AES key from password
    const salt = generateSalt();
    const key  = await deriveKey(password, salt);

    // 2. Store: salt + verify token
    const verifyToken = await encrypt('STEALTH_OK', key);
    await StealthStorage.set('masterSalt',   Array.from(salt));
    await StealthStorage.set('verifyToken',  verifyToken);
    await StealthStorage.set('authMethod',   authMethod);

    // 3. Register biometric if chosen
    if (authMethod === 'biometric') {
      try {
        if (!StealthWebAuthn.isSupported()) throw new Error('WebAuthn unavailable');
        await StealthWebAuthn.registerCredential('stealthtab-user');
      } catch (bioErr) {
        showMsg(msgEl, 'Biometric setup failed — using password only. (' + bioErr.message + ')', 'warn');
        await StealthStorage.set('authMethod', 'password');
      }
    }

    // 4. Export key to raw bytes — CryptoKey is NOT serializable by chrome.runtime.sendMessage
    const keyBytes = await exportKeyBytes(key);
    await sendMsg({ type: 'SET_SESSION_KEY', keyBytes });

    // 5. Lock each selected tab
    const tabs = allTabs.filter(t => selectedTabIds.has(t.id));
    let failures = 0;
    for (const tab of tabs) {
      let decoy = decoyMap[tab.id];
      if (!decoy || decoy === '__custom__') {
        decoy = $(`custom-${tab.id}`)?.value?.trim() || '';
      }
      if (!decoy || !decoy.startsWith('http')) {
        decoy = DECOY_SITES[0].url;
      }
      const resp = await sendMsg({
        type: 'MARK_TAB_AS_PRIVATE',
        tabId: tab.id,
        url: tab.url,
        decoyUrl: decoy
      });
      if (resp?.error) failures++;
    }

    if (failures > 0) {
      showMsg(msgEl, `${failures} tab(s) could not be locked. They may have been closed.`, 'warn');
    }

    renderSummary(tabs);
    showView(4);
  } catch (err) {
    showMsg(msgEl, 'Error: ' + err.message, 'err');
  } finally {
    btn.textContent = '🔒 Lock Selected Tabs';
    btn.disabled    = false;
  }
}

// ══════════════════════════════════════════════
//  VIEW 4 — SUMMARY
// ══════════════════════════════════════════════
function renderSummary(tabs) {
  $('summary-list').innerHTML = tabs.map(tab => {
    let decoy = decoyMap[tab.id];
    if (!decoy || decoy === '__custom__') {
      decoy = $(`custom-${tab.id}`)?.value || DECOY_SITES[0].url;
    }
    let displayName;
    try {
      displayName = DECOY_SITES.find(d => d.url === decoy)?.name || new URL(decoy).hostname;
    } catch {
      displayName = decoy;
    }
    return `
      <div class="summary-item">
        <img src="${escAttr(tab.favIconUrl || '')}" alt=""
             style="width:14px;height:14px;border-radius:3px"
             onerror="this.style.display='none'">
        <span class="summary-name">${escHtml(tab.title || 'Tab')}</span>
        <span class="summary-arrow">→</span>
        <span class="summary-decoy">${escHtml(displayName)}</span>
        <span>🔒</span>
      </div>`;
  }).join('');
}

// ══════════════════════════════════════════════
//  VIEW 5 — MANAGE
// ══════════════════════════════════════════════
async function renderLockedList() {
  const tabs    = await StealthStorage.getPrivateTabs();
  const list    = $('locked-list');
  const entries = Object.entries(tabs);

  if (!entries.length) {
    list.innerHTML = `<div class="empty"><div class="empty-icon">🔓</div><p>No private tabs yet.<br>Click "+ Hide more" to get started.</p></div>`;
    return;
  }

  list.innerHTML = entries.map(([id, data]) => `
    <div class="locked-item">
      <span style="font-size:15px">${data.status === 'locked' ? '🔒' : '🔓'}</span>
      <span class="locked-name">${escHtml(data.title || 'Tab ' + id)}</span>
      <span class="status-pill ${data.status}">${data.status}</span>
      ${data.status === 'locked'
        ? `<button class="unlock-mini-btn" data-tabid="${id}">Unlock</button>`
        : `<button class="lock-mini-btn"   data-tabid="${id}">Lock</button>`}
    </div>`).join('');

  // Event delegation for unlock buttons
  list.querySelectorAll('.unlock-mini-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const tabId = parseInt(btn.dataset.tabid, 10);
      try {
        await chrome.tabs.update(tabId, { active: true });
      } catch {
        // Tab may not exist — still open auth
      }
      chrome.windows.create({
        url: chrome.runtime.getURL('auth/auth.html?tabId=' + tabId),
        type: 'popup', width: 420, height: 520
      });
    });
  });

  // Event delegation for lock buttons (re-lock an unlocked tab)
  list.querySelectorAll('.lock-mini-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const tabId = parseInt(btn.dataset.tabid, 10);
      await sendMsg({ type: 'RELOCK_TAB', tabId });
      renderLockedList();
    });
  });
}

// ══════════════════════════════════════════════
//  NAV
// ══════════════════════════════════════════════
function showView(n) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.step-dot').forEach((d, i) => {
    d.classList.remove('active', 'done');
    if (i + 1 < n)        d.classList.add('done');
    else if (i + 1 === n) d.classList.add('active');
  });
  $(`view-${n}`)?.classList.add('active');
  const labels = ['', 'Step 1 of 4', 'Step 2 of 4', 'Step 3 of 4', 'Done!', 'Manage'];
  $('header-step').textContent = labels[n] || '';
}

// ══════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════
function showMsg(el, text, type) {
  el.textContent      = text;
  el.className        = 'msg' + (type ? ` ${type}` : '');
  el.style.display    = text ? 'block' : 'none';
}

function sendMsg(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, resp => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(resp);
      }
    });
  });
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function escAttr(s) { return escHtml(String(s)); }
function safeHostname(url) {
  try { return new URL(url).hostname; } catch { return String(url).slice(0, 40); }
}
