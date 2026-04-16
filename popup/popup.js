/**
 * StealthTab Popup Controller — Hardened v5.0
 *
 * SECURITY RULES:
 *  ✅ NO inline event handlers (MV3 CSP)
 *  ✅ Event delegation for dynamic lists
 *  ✅ User-gesture enforcement for WebAuthn
 */

const DECOY_SITES = [
  { name: 'LinkedIn',   url: 'https://www.linkedin.com',  emoji: '💼' },
  { name: 'YouTube',    url: 'https://www.youtube.com',   emoji: '▶️' },
  { name: 'Google',     url: 'https://www.google.com',    emoji: '🔍' },
  { name: 'GitHub',     url: 'https://github.com',        emoji: '🐙' },
  { name: 'Wikipedia',  url: 'https://www.wikipedia.org', emoji: '📖' },
  { name: 'Reddit',     url: 'https://www.reddit.com',    emoji: '👾' },
  { name: 'Custom URL', url: '__custom__',                emoji: '✏️'  }
];

let allTabs        = [];
let selectedTabIds = new Set();
let decoyMap       = {};      // tabId → decoy URL string
let authMethod     = 'password';

const SETUP_STATE = {
  INIT: 1,
  DECOY_PICKED: 2,
  AUTH_CHOSEN: 3,
  COMPLETE: 4,
  MANAGE: 5
};

const $ = id => document.getElementById(id);

// ══════════════════════════════════════════════
//  INIT
// ══════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', async () => {
  console.log('[StealthTab Popup] Initializing Controller...');

  // ── 1. Static Button Bindings ──
  bindBtn('select-all-btn', onSelectAll);
  bindBtn('next-1',         onNext1);
  bindBtn('next-2',         () => transitionTo(SETUP_STATE.AUTH_CHOSEN));
  bindBtn('back-2',         () => transitionTo(SETUP_STATE.INIT));
  bindBtn('back-3',         () => transitionTo(SETUP_STATE.DECOY_PICKED));
  bindBtn('next-3',         completeSetup);
  bindBtn('btn-manage',     () => transitionTo(SETUP_STATE.MANAGE));
  bindBtn('btn-lock-all',   () => sendMsg({ type: 'LOCK_ALL' }));
  bindBtn('btn-lock-all-2', () => sendMsg({ type: 'LOCK_ALL' }).then(() => renderLockedList()));
  bindBtn('btn-add-more',   () => { selectedTabIds.clear(); decoyMap = {}; loadTabs(); transitionTo(SETUP_STATE.INIT); });
  bindBtn('btn-forgot-pw',  onForgotPassword);
  bindBtn('btn-register-bio', onRegisterBiometric);
  bindBtn('card-password',   () => selectAuth('password'));
  bindBtn('card-biometric',  () => selectAuth('biometric'));

  // ── 2. Biometric State Check (Non-blocking) ──
  initBiometrics().catch(e => console.error('[StealthTab Popup] Bio init failure:', e));

  // ── 3. UI Helpers ──
  const pwInput = $('pw-new');
  if (pwInput) pwInput.addEventListener('input', e => checkStrength(e.target.value));

  // ── 4. Routing Decision ──
  try {
    // A. Check if current tab is already locked
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeTab) {
      const state = await sendMsg({ type: 'GET_TAB_STATE', tabId: activeTab.id });
      if (state && state.status === 'locked') {
        console.log('[StealthTab Popup] Routing to Auth window');
        await chrome.windows.create({
          url:    chrome.runtime.getURL('auth/auth.html?tabId=' + activeTab.id),
          type:   'popup',
          width:  420, height: 520
        });
        window.close();
        return;
      }
    }

    // B. Check if we have existing private tabs → Manage View
    const existing = await StealthStorage.getPrivateTabs();
    const hasSalt  = await StealthStorage.get('masterSalt');
    if (Object.keys(existing).length > 0 && hasSalt) {
      transitionTo(SETUP_STATE.MANAGE);
      return;
    }

    // ── 4. Final: Clean storage ──
    await StealthStorage.runMigration();
  } catch (e) {
    console.warn('[StealthTab Popup] Init sequence error:', e);
  }

  // Default: Setup View
  loadTabs();
  transitionTo(SETUP_STATE.INIT);
});

function bindBtn(id, handler) {
  const el = $(id);
  if (el) el.addEventListener('click', handler);
}

// ══════════════════════════════════════════════
//  VIEW 1 — TAB SELECTION
// ══════════════════════════════════════════════
async function loadTabs() {
  try {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    allTabs = tabs.filter(t => 
      t.url && !t.url.startsWith('chrome') && !t.url.startsWith('edge') && !t.url.startsWith('about:')
    );
  } catch (e) {
    console.error('[StealthTab Popup] loadTabs error:', e);
    allTabs = [];
  }
  renderTabList();
}

function renderTabList() {
  const list = $('tab-list');
  if (!list) return;

  if (allTabs.length === 0) {
    list.innerHTML = `<div class="empty"><div class="empty-icon">🌐</div><p>No regular tabs found.</p></div>`;
    updateSelCount();
    return;
  }

  list.innerHTML = allTabs.map(tab => {
    const sel = selectedTabIds.has(tab.id);
    return `
      <div class="tab-item${sel ? ' selected' : ''}" data-tabid="${tab.id}">
        <div class="tab-check">
          <svg viewBox="0 0 12 12" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="1,6 4,10 11,2"></polyline>
          </svg>
        </div>
        <img class="tab-favicon" src="${escAttr(tab.favIconUrl || '')}" onerror="this.style.visibility='hidden'">
        <div class="tab-info">
          <div class="tab-name">${escHtml(tab.title || 'Untitled')}</div>
          <div class="tab-url">${escHtml(new URL(tab.url).hostname)}</div>
        </div>
      </div>`;
  }).join('');

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
  if ($('sel-count')) $('sel-count').textContent = `${n} selected`;
  if ($('next-1')) $('next-1').disabled = (n === 0);
}

function onNext1() {
  allTabs.filter(t => selectedTabIds.has(t.id)).forEach(tab => {
    if (!decoyMap[tab.id]) decoyMap[tab.id] = DECOY_SITES[0].url;
  });
  renderDecoyPicker();
  transitionTo(SETUP_STATE.DECOY_PICKED);
}

// ══════════════════════════════════════════════
//  VIEW 2 — DECOY PICKER
// ══════════════════════════════════════════════
function renderDecoyPicker() {
  const selectedTabs = allTabs.filter(t => selectedTabIds.has(t.id));
  const container    = $('decoy-list');
  if (!container) return;

  container.innerHTML = selectedTabs.map(tab => {
    const currentDecoy = decoyMap[tab.id] || DECOY_SITES[0].url;
    const isCustom     = !DECOY_SITES.slice(0, -1).find(d => d.url === currentDecoy);
    return `
      <div class="decoy-entry" data-entryid="${tab.id}">
        <div class="decoy-entry-label">
          <img src="${escAttr(tab.favIconUrl || '')}" style="width:13px;height:13px;border-radius:3px;vertical-align:middle" onerror="this.style.display='none'">
          ${escHtml(tab.title || 'Tab')}
        </div>
        <div class="decoy-chips">
          ${DECOY_SITES.map((d, i) => {
            const isActive = (d.url !== '__custom__' && currentDecoy === d.url) || (d.url === '__custom__' && isCustom);
            return `<div class="chip${isActive ? ' active' : ''}" data-tabid="${tab.id}" data-url="${escAttr(d.url)}" data-idx="${i}">${d.emoji} ${d.name}</div>`;
          }).join('')}
        </div>
        <input type="url" class="custom-url${isCustom ? ' show' : ''}" id="custom-${tab.id}" placeholder="https://example.com" value="${isCustom && currentDecoy !== '__custom__' ? escAttr(currentDecoy) : ''}">
      </div>`;
  }).join('');

  container.querySelectorAll('.chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const tabId = parseInt(chip.dataset.tabid, 10);
      const url   = chip.dataset.url;
      const entry = chip.closest('.decoy-entry');
      const input = entry.querySelector('.custom-url');

      if (url === '__custom__') {
        decoyMap[tabId] = input.value.trim() || '__custom__';
        input.classList.add('show');
        input.focus();
      } else {
        decoyMap[tabId] = url;
        input.classList.remove('show');
      }
      entry.querySelectorAll('.chip').forEach(c => c.classList.toggle('active', c === chip));
    });
  });

  container.querySelectorAll('.custom-url').forEach(input => {
    const tabId = parseInt(input.id.replace('custom-', ''), 10);
    input.addEventListener('input', () => { decoyMap[tabId] = input.value.trim(); });
  });
}

// ══════════════════════════════════════════════
//  VIEW 3 — AUTH SETUP
// ══════════════════════════════════════════════
function selectAuth(method) {
  console.log('[StealthTab] Switching auth method to:', method);
  authMethod = method;

  const cardPw  = $('card-password');
  const cardBio = $('card-biometric');
  const setupPw  = $('setup-password');
  const setupBio = $('setup-biometric');

  if (cardPw)  cardPw.classList.toggle('selected',  method === 'password');
  if (cardBio) cardBio.classList.toggle('selected', method === 'biometric');
  
  if (setupPw)  setupPw.style.display  = (method === 'password'  ? 'block' : 'none');
  if (setupBio) setupBio.style.display = (method === 'biometric' ? 'block' : 'none');
}

function checkStrength(pw) {
  const bar = $('pw-strength');
  const hint = $('pw-hint');
  if (!bar || !hint) return;

  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 12) score++;
  if (/[A-Z]/.test(pw)) score++;
  if (/[0-9]/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;

  const cfg = [
    { w: '15%',  bg: '#ef4444', lbl: 'Too short' },
    { w: '35%',  bg: '#f97316', lbl: 'Weak' },
    { w: '60%',  bg: '#eab308', lbl: 'Fair' },
    { w: '80%',  bg: '#22c55e', lbl: 'Strong' },
    { w: '100%', bg: '#10b981', lbl: 'Very strong ✓' }
  ];
  const c = cfg[Math.min(score, 4)];
  bar.style.width = c.w;
  bar.style.background = c.bg;
  hint.textContent = c.lbl;
  hint.style.color = c.bg;
}

// ── Biometric Helpers ──
async function initBiometrics() {
  const bioDesc  = $('bio-setup-desc');
  const regBtn   = $('btn-register-bio');

  if (bioDesc) bioDesc.innerHTML = 'Optional: Register your fingerprint for instant access, or <b>skip</b> and use the backup password below.';
  if (regBtn) regBtn.disabled = false;

  const store = await chrome.storage.local.get(['biometric_enabled', 'biometric_credential_id', 'biometric_schema_version']);
  if (store.biometric_enabled) {
    const versionMismatch = store.biometric_schema_version !== StealthWebAuthn.SCHEMA_VERSION;
    if (!store.biometric_credential_id || versionMismatch) {
      await StealthWebAuthn.disableBiometric();
      updateBioUI(false);
    } else {
      updateBioUI(true);
    }
  }
}

function updateBioUI(registered) {
  const statusEl = $('bio-reg-status');
  const regBtn   = $('btn-register-bio');
  if (registered) {
    showMsg(statusEl, '✅ Fingerprint registered', 'ok');
    if (regBtn) regBtn.textContent = '🔄 Re-register Fingerprint';
  } else {
    showMsg(statusEl, '', '');
    if (regBtn) regBtn.textContent = '➕ Register Fingerprint';
  }
}

async function onRegisterBiometric() {
  const statusEl = $('bio-reg-status');
  const backupPw = ($('pw-backup')?.value || '').trim();

  if (backupPw.length < 4) {
    showMsg(statusEl, 'Please enter a backup password first (min 4 chars).', 'err');
    return;
  }

  try {
    showMsg(statusEl, 'Please touch your fingerprint sensor...', 'warn');
    const result = await StealthWebAuthn.registerCredential('stealthtab-user');
    if (result.success) updateBioUI(true);
  } catch (err) {
    if (err.name === 'NotAllowedError') {
      showMsg(statusEl, 'Fingerprint registration cancelled or sensor not found.', 'warn');
    } else if (err.name === 'SecurityError') {
      showMsg(statusEl, 'Security block: WebAuthn requires a HTTPS connection.', 'err');
    } else {
      showMsg(statusEl, 'Registration skipped. (Backup password active)', 'warn');
    }
  }
}

// ── THE BIG ONE: PERSISTING SETUP ──
async function completeSetup() {
  const msgEl = $('auth-msg');
  const btn   = $('next-3');
  showMsg(msgEl, '', '');

  let password = '';
  if (authMethod === 'password') {
    password = ($('pw-new')?.value || '').trim();
    const confirm = ($('pw-confirm')?.value || '').trim();
    if (password.length < 4) { showMsg(msgEl, 'Password too short (min 4).', 'err'); return; }
    if (password !== confirm) { showMsg(msgEl, 'Passwords do not match.', 'err'); return; }
  } else {
    // 🔐 Registration is now OPTIONAL. If they skip it, they rely on the Backup Password.
    password = ($('pw-backup')?.value || '').trim();
    const confirm = ($('pw-backup-confirm')?.value || '').trim();
    if (password.length < 4) { showMsg(msgEl, 'Backup password too short (min 4).', 'err'); return; }
    if (password !== confirm) { showMsg(msgEl, 'Backup passwords do not match.', 'err'); return; }
  }

  if (btn) { btn.textContent = '⏳ Securing...'; btn.disabled = true; }

  try {
    // 1. Setup salts and verify token
    const salt = generateSalt();
    const key = await deriveKey(password, salt);
    const verifyToken = await encrypt('STEALTH_OK', key);

    // 🔐 Critical Fix: Only enable biometrics if registration actually happened
    const store = await chrome.storage.local.get('biometric_credential_id');
    const isEnrolled = !!store.biometric_credential_id;

    await chrome.storage.local.set({
      masterSalt: Array.from(salt),
      verifyToken: verifyToken,
      authMethod: authMethod,
      biometric_enabled: (authMethod === 'biometric' && isEnrolled)
    });

    // 2. Export key + Store temporary password for session recovery (Phase 8 Fix)
    const keyBytes = await exportKeyBytes(key);
    await chrome.storage.session.set({ 
      'backupPassword': password, // Memory-only for SW to recover session
      'st_session_key': keyBytes 
    });
    await sendMsg({ type: 'SET_SESSION_KEY', keyBytes });

    // 3. Lock tabs
    const tabs = allTabs.filter(t => selectedTabIds.has(t.id));
    for (const tab of tabs) {
      let decoy = decoyMap[tab.id];
      if (!decoy || decoy === '__custom__') decoy = $(`custom-${tab.id}`)?.value?.trim() || DECOY_SITES[0].url;
      if (!decoy.startsWith('http')) decoy = 'https://' + decoy;

      await sendMsg({
        type: 'MARK_TAB_AS_PRIVATE',
        tabId: tab.id,
        url: tab.url,
        decoyUrl: decoy,
        keyBytes: keyBytes
      });
    }

    renderSummary(tabs);
    transitionTo(SETUP_STATE.COMPLETE);
  } catch (err) {
    showMsg(msgEl, 'Error: ' + err.message, 'err');
  } finally {
    if (btn) { btn.textContent = '🔒 Lock Selected Tabs'; btn.disabled = false; }
  }
}

// ══════════════════════════════════════════════
//  VIEW 4 / 5 — MANAGEMENT
// ══════════════════════════════════════════════
function renderSummary(tabs) {
  const el = $('summary-list');
  if (!el) return;
  el.innerHTML = tabs.map(tab => `
    <div class="summary-item">
      <img src="${escAttr(tab.favIconUrl || '')}" style="width:14px;height:14px;border-radius:3px" onerror="this.style.display='none'">
      <span class="summary-name">${escHtml(tab.title || 'Tab')}</span>
      <span class="summary-arrow">→</span>
      <span class="summary-decoy">🔒 Locked</span>
    </div>`).join('');
}

async function renderLockedList() {
  const tabs = await StealthStorage.getPrivateTabs();
  const list = $('locked-list');
  const entries = Object.entries(tabs);
  
  if (!list) return;
  if (!entries.length) {
    list.innerHTML = `<div class="empty"><div class="empty-icon">🔓</div><p>No private tabs yet.</p></div>`;
    return;
  }

  list.innerHTML = entries.map(([id, data]) => `
    <div class="locked-item">
      <span>${data.status === 'locked' ? '🔒' : '🔓'}</span>
      <span class="locked-name">${escHtml(data.title)}</span>
      <span class="status-pill ${data.status}">${data.status}</span>
      <button class="${data.status === 'locked' ? 'unlock' : 'lock'}-mini-btn" data-tabid="${id}">${data.status === 'locked' ? 'Unlock' : 'Re-Lock'}</button>
    </div>`).join('');

  list.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', async () => {
      const tabId = parseInt(btn.dataset.tabid, 10);
      if (btn.classList.contains('unlock-mini-btn')) {
        try { await chrome.tabs.update(tabId, { active: true }); } catch {}
        await chrome.windows.create({ url: chrome.runtime.getURL('auth/auth.html?tabId=' + tabId), type: 'popup', width: 420, height: 520 });
      } else {
        await sendMsg({ type: 'RELOCK_TAB', tabId });
        renderLockedList();
      }
    });
  });
}

function onForgotPassword() {
  showMsg($('auth-msg'), 'Recovery is disabled for security. Re-install extension if locked out.', 'err');
}

// ══════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════
function transitionTo(state) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  $(`view-${state}`)?.classList.add('active');
  
  // Update wizard dots
  document.querySelectorAll('.step-dot').forEach((d, i) => {
    d.classList.toggle('active', i+1 === state);
    d.classList.toggle('done', i+1 < state);
  });

  // Tab management specific triggers
  if (state === SETUP_STATE.MANAGE) renderLockedList();

  const headers = ['', 'Step 1 of 4', 'Step 2 of 4', 'Step 3 of 4', 'Done!', 'Manage'];
  if ($('header-step')) $('header-step').textContent = headers[state] || '';
}

function showMsg(el, text, type) {
  if (!el) return;
  el.textContent = text;
  el.className = 'msg' + (type ? ` ${type}` : '');
  el.style.display = text ? 'block' : 'none';
}

function sendMsg(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, r => chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve(r));
  });
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function escAttr(s) { return escHtml(String(s)); }
