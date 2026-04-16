/**
 * StealthTab Popup Controller — 4-Step Wizard
 *
 * SECURITY RULES:
 *  ✅ NO inline event handlers (MV3 CSP)
 *  ✅ All dynamic elements use event delegation with data-* attributes
 *  ✅ addEventListener only — never onclick=""
 *  ✅ keyBytes included in MARK_TAB_AS_PRIVATE (self-contained, SW-death-safe)
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

const $ = id => document.getElementById(id);

// ══════════════════════════════════════════════
//  INIT
// ══════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', async () => {
  console.log('[StealthTab Popup] DOMContentLoaded');

  // Wire static button listeners
  bindBtn('select-all-btn', onSelectAll);
  bindBtn('next-1',         onNext1);
  bindBtn('next-2',         () => showView(3));
  bindBtn('back-2',         () => showView(1));
  bindBtn('back-3',         () => showView(2));
  bindBtn('next-3',         onNext3);
  bindBtn('btn-manage',     () => { showView(5); renderLockedList(); });
  bindBtn('btn-lock-all',   () => sendMsg({ type: 'LOCK_ALL' }));
  bindBtn('btn-lock-all-2', () => sendMsg({ type: 'LOCK_ALL' }).then(() => renderLockedList()));
  bindBtn('btn-add-more',   () => { selectedTabIds.clear(); decoyMap = {}; loadTabs(); showView(1); });
  bindBtn('btn-forgot-pw', onForgotPassword);
  bindBtn('back-6',      () => showView(5));
  bindBtn('verify-recovery', verifyRecoveryCode);
  bindBtn('back-7',      () => showView(6));
  bindBtn('submit-reset',  resetPassword);
  bindBtn('card-password',  () => selectAuth('password'));
  bindBtn('card-biometric', () => selectAuth('biometric'));

  const pwInput = $('pw-new');
  if (pwInput) pwInput.addEventListener('input', e => checkStrength(e.target.value));

  // ── If current active tab is locked → go straight to auth popup ──
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeTab) {
      const state = await sendMsg({ type: 'GET_TAB_STATE', tabId: activeTab.id });
      console.log('[StealthTab Popup] Active tab state:', state);
      if (state && state.status === 'locked') {
        console.log('[StealthTab Popup] Active tab is locked — opening auth window');
        await chrome.windows.create({
          url:    chrome.runtime.getURL('auth/auth.html?tabId=' + activeTab.id),
          type:   'popup',
          width:  420,
          height: 520
        });
        window.close();
        return;
      }
    }
  } catch (e) {
    console.warn('[StealthTab Popup] Could not check active tab state:', e.message);
  }

  // ── If we already have private tabs set up → show manage view ──
  try {
    const existing = await StealthStorage.getPrivateTabs();
    const hasSalt  = await StealthStorage.get('masterSalt');
    if (Object.keys(existing).length > 0 && hasSalt) {
      console.log('[StealthTab Popup] Existing private tabs found → manage view');
      showView(5);
      renderLockedList();
      return;
    }
  } catch (e) {
    console.warn('[StealthTab Popup] Storage check failed:', e.message);
  }

  loadTabs();
  showView(1);
});

function bindBtn(id, handler) {
  const el = $(id);
  if (el) el.addEventListener('click', handler);
}

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
    console.log('[StealthTab Popup] Loaded', allTabs.length, 'tabs');
  } catch (e) {
    console.error('[StealthTab Popup] loadTabs error:', e);
    allTabs = [];
  }
  renderTabList();
}

function renderTabList() {
  const list = $('tab-list');
  if (!list) return;

  if (!allTabs.length) {
    list.innerHTML = `<div class="empty"><div class="empty-icon">🌐</div><p>No regular tabs found.</p></div>`;
    updateSelCount();
    return;
  }

  list.innerHTML = allTabs.map(tab => {
    const sel      = selectedTabIds.has(tab.id);
    const hostname = safeHostname(tab.url);
    return `
      <div class="tab-item${sel ? ' selected' : ''}" data-tabid="${tab.id}">
        <div class="tab-check">
          <svg viewBox="0 0 12 12" fill="none" stroke="white" stroke-width="2.5"
               stroke-linecap="round" stroke-linejoin="round">
            <polyline points="1,6 4,10 11,2"></polyline>
          </svg>
        </div>
        <img class="tab-favicon" src="${escAttr(tab.favIconUrl || '')}" alt=""
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
  const el = $('sel-count');
  if (el) el.textContent = `${n} selected`;
  const btn = $('next-1');
  if (btn) btn.disabled = n === 0;
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
  if (!container) return;

  container.innerHTML = selectedTabs.map(tab => {
    const currentDecoy = decoyMap[tab.id] || DECOY_SITES[0].url;
    const isCustom     = !DECOY_SITES.slice(0, -1).find(d => d.url === currentDecoy);
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
        decoyMap[tabId] = input.value.trim() || '__custom__';
        input.classList.add('show');
        input.focus();
      } else {
        decoyMap[tabId] = url;
        input.classList.remove('show');
      }
      entry.querySelectorAll('.chip').forEach((c, i) => c.classList.toggle('active', i === idx));
    });
  });

  // Custom URL live binding
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
  const pwSetup  = $('setup-password');
  const bioSetup = $('setup-biometric');
  if (pwSetup)  pwSetup.style.display  = method === 'password'  ? 'block' : 'none';
  if (bioSetup) bioSetup.style.display = method === 'biometric' ? 'block' : 'none';
}

function checkStrength(pw) {
  const bar  = $('pw-strength');
  const hint = $('pw-hint');
  if (!bar || !hint) return;

  let score = 0;
  if (pw.length >= 8)            score++;
  if (pw.length >= 12)           score++;
  if (/[A-Z]/.test(pw))          score++;
  if (/[0-9]/.test(pw))          score++;
  if (/[^A-Za-z0-9]/.test(pw))  score++;

  const cfg = [
    { w: '15%',  bg: '#ef4444', lbl: 'Too short'      },
    { w: '35%',  bg: '#f97316', lbl: 'Weak'           },
    { w: '60%',  bg: '#eab308', lbl: 'Fair'           },
    { w: '80%',  bg: '#22c55e', lbl: 'Strong'         },
    { w: '100%', bg: '#10b981', lbl: 'Very strong ✓'  }
  ];
  const c = cfg[Math.min(score, 4)];
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
    password        = ($('pw-new')?.value     || '').trim();
    const confirm   = ($('pw-confirm')?.value || '').trim();
    if (password.length < 8) {
      showMsg(msgEl, 'Password must be at least 8 characters.', 'err'); return;
    }
    if (password !== confirm) {
      showMsg(msgEl, 'Passwords do not match.', 'err'); return;
    }
  } else {
    password = ($('pw-backup')?.value || '').trim();
    if (password.length < 8) {
      showMsg(msgEl, 'Backup password must be at least 8 characters.', 'err'); return;
    }
  }

  const recoveryInput = $('recovery-code');
  const recoveryCode = recoveryInput ? recoveryInput.value.trim().toUpperCase() : '';
  
  if (!recoveryCode || recoveryCode.length !== 4 || !/^[A-Z]{4}$/.test(recoveryCode)) {
    showMsg(msgEl, 'Recovery code must be exactly 4 letters (A-Z).', 'err'); return;
  }

  const btn = $('next-3');
  if (btn) { btn.textContent = '⏳ Encrypting…'; btn.disabled = true; }

  try {
    const salt = generateSalt();
    const key  = await deriveKey(password, salt);

    const verifyToken = await encrypt('STEALTH_OK', key);
    await StealthStorage.set('masterSalt',  Array.from(salt));
    await StealthStorage.set('verifyToken', verifyToken);
    await StealthStorage.set('authMethod',  authMethod);

    const recoveryHash = await sha256Hash(recoveryCode);
    await StealthStorage.setRecoveryCodeHash(recoveryHash);
    console.log('[StealthTab Popup] Recovery code hash stored (not the code itself)');

    // 3. Register biometric if chosen
    if (authMethod === 'biometric') {
      try {
        if (!StealthWebAuthn.isSupported()) throw new Error('WebAuthn not available on this device');
        await StealthWebAuthn.registerCredential('stealthtab-user');
        console.log('[StealthTab Popup] ✅ Biometric registered');
      } catch (bioErr) {
        console.warn('[StealthTab Popup] Biometric setup failed:', bioErr.message);
        showMsg(msgEl, `Biometric unavailable — falling back to password. (${bioErr.message})`, 'warn');
        await StealthStorage.set('authMethod', 'password');
      }
    }

    // 4. Export key to raw bytes —
    //    CryptoKey objects CANNOT be sent via chrome.runtime.sendMessage
    //    (structured clone does not support them).
    //    We include keyBytes in every MARK_TAB_AS_PRIVATE call so each
    //    lock is self-contained even if the SW was restarted between calls.
    const keyBytes = await exportKeyBytes(key);
    console.log('[StealthTab Popup] ✅ Key exported to bytes (' + keyBytes.length + ' bytes)');

    // 5. Also set session key in SW for context-menu locking
    await sendMsg({ type: 'SET_SESSION_KEY', keyBytes });

    // 6. Lock each selected tab
    const tabs     = allTabs.filter(t => selectedTabIds.has(t.id));
    let   failures = 0;
    let   locked   = 0;

    for (const tab of tabs) {
      // Resolve decoy URL
      let decoy = decoyMap[tab.id];
      if (!decoy || decoy === '__custom__') {
        decoy = $(`custom-${tab.id}`)?.value?.trim() || '';
      }
      if (!decoy || !decoy.startsWith('http')) {
        decoy = DECOY_SITES[0].url;
      }

      console.log(`[StealthTab Popup] Locking tab ${tab.id} → decoy: ${decoy}`);

      // CRITICAL: keyBytes included — each lock message is self-contained
      const resp = await sendMsg({
        type:     'MARK_TAB_AS_PRIVATE',
        tabId:    tab.id,
        url:      tab.url,
        decoyUrl: decoy,
        keyBytes: keyBytes        // ← self-contained, no SET_SESSION_KEY dependency
      });

      if (resp?.ok) {
        locked++;
        console.log(`[StealthTab Popup] ✅ Tab ${tab.id} locked`);
      } else {
        failures++;
        console.error(`[StealthTab Popup] ❌ Failed to lock tab ${tab.id}:`, resp?.error);
      }
    }

    if (failures > 0 && locked === 0) {
      showMsg(msgEl, `All ${failures} tab(s) failed to lock. Check the console for details.`, 'err');
      return;
    }
    if (failures > 0) {
      showMsg(msgEl, `${locked} tab(s) locked. ${failures} could not be locked (may have closed).`, 'warn');
    }

    renderSummary(tabs);
    showView(4);

  } catch (err) {
    console.error('[StealthTab Popup] ❌ onNext3 error:', err);
    showMsg(msgEl, 'Error: ' + err.message, 'err');
  } finally {
    if (btn) { btn.textContent = '🔒 Lock Selected Tabs'; btn.disabled = false; }
  }
}

// ══════════════════════════════════════════════
//  VIEW 4 — SUMMARY
// ══════════════════════════════════════════════
function renderSummary(tabs) {
  const el = $('summary-list');
  if (!el) return;
  el.innerHTML = tabs.map(tab => {
    let decoy = decoyMap[tab.id];
    if (!decoy || decoy === '__custom__') {
      decoy = $(`custom-${tab.id}`)?.value || DECOY_SITES[0].url;
    }
    let displayName;
    try {
      displayName = DECOY_SITES.find(d => d.url === decoy)?.name || new URL(decoy).hostname;
    } catch { displayName = decoy; }

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
  if (!list) return;

  const entries = Object.entries(tabs);
  if (!entries.length) {
    list.innerHTML = `<div class="empty"><div class="empty-icon">🔓</div><p>No private tabs yet.</p></div>`;
    return;
  }

  list.innerHTML = entries.map(([id, data]) => `
    <div class="locked-item">
      <span style="font-size:15px">${data.status === 'locked' ? '🔒' : '🔓'}</span>
      <span class="locked-name">${escHtml(data.title || 'Tab ' + id)}</span>
      <span class="status-pill ${data.status}">${data.status}</span>
      ${data.status === 'locked'
        ? `<button class="unlock-mini-btn" data-tabid="${id}">Unlock</button>`
        : `<button class="lock-mini-btn"   data-tabid="${id}">Re-Lock</button>`}
    </div>`).join('');

  list.querySelectorAll('.unlock-mini-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const tabId = parseInt(btn.dataset.tabid, 10);
      try { await chrome.tabs.update(tabId, { active: true }); } catch {}
      await chrome.windows.create({
        url:    chrome.runtime.getURL('auth/auth.html?tabId=' + tabId),
        type:   'popup',
        width:  420,
        height: 520
      });
    });
  });

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
    if (i + 1 < n)       d.classList.add('done');
    else if (i + 1 === n) d.classList.add('active');
  });
  $(`view-${n}`)?.classList.add('active');
  const labels = ['', 'Step 1 of 4', 'Step 2 of 4', 'Step 3 of 4', 'Done!', 'Manage', 'Recover', 'Reset'];
  const stepEl = $('header-step');
  if (stepEl) stepEl.textContent = labels[n] || '';
}

// ══════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════
function showMsg(el, text, type) {
  if (!el) return;
  el.textContent   = text;
  el.className     = 'msg' + (type ? ` ${type}` : '');
  el.style.display = text ? 'block' : 'none';
}

function sendMsg(msg) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(msg, resp => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(resp);
        }
      });
    } catch (e) {
      reject(e);
    }
  });
}

function escHtml(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function escAttr(s)     { return escHtml(String(s)); }
function safeHostname(url) {
  try { return new URL(url).hostname; } catch { return String(url).slice(0, 40); }
}

// ══════════════════════════════════════════════
//  FORGOT PASSWORD — RECOVERY
// ══════════════════════════════════════════════
async function onForgotPassword() {
  const hasRecovery = await StealthStorage.hasRecoveryCode();
  if (!hasRecovery) {
    showMsg($('recovery-msg'), 'No recovery code set. Re-install the extension to reset.', 'err');
    return;
  }

  const isLocked = await StealthStorage.isRecoveryLocked();
  if (isLocked) {
    const secs = await StealthStorage.getRecoveryLockRemainingSeconds();
    showMsg($('recovery-msg'), `Too many attempts. Try again in ${Math.ceil(secs / 60)} minute(s).`, 'err');
    return;
  }

  showView(6);
  $('recovery-input')?.focus();
}

async function verifyRecoveryCode() {
  const msgEl = $('recovery-msg');
  const codeInput = $('recovery-input');
  const code = codeInput?.value.trim().toUpperCase() || '';

  if (!code || code.length !== 4 || !/^[A-Z]{4}$/.test(code)) {
    showMsg(msgEl, 'Recovery code must be exactly 4 letters.', 'err');
    return;
  }

  const isLocked = await StealthStorage.isRecoveryLocked();
  if (isLocked) {
    const secs = await StealthStorage.getRecoveryLockRemainingSeconds();
    showMsg(msgEl, `Too many attempts. Try again in ${Math.ceil(secs / 60)} minute(s).`, 'err');
    return;
  }

  const storedHash = await StealthStorage.getRecoveryCodeHash();
  const inputHash = await sha256Hash(code);

  if (inputHash === storedHash) {
    await StealthStorage.resetRecoveryAttempts();
    showMsg(msgEl, '', '');
    showView(7);
    $('pw-reset-new')?.focus();
  } else {
    await StealthStorage.incrementRecoveryAttempts();
    const attempts = await StealthStorage.getRecoveryAttempts();

    if (attempts >= 5) {
      const lockUntil = Date.now() + (5 * 60 * 1000);
      await StealthStorage.setRecoveryLockUntil(lockUntil);
      showMsg(msgEl, 'Too many attempts. Locked for 5 minutes.', 'err');
    } else {
      showMsg(msgEl, `Incorrect recovery code. ${5 - attempts} attempt(s) remaining.`, 'err');
      codeInput.value = '';
      codeInput?.focus();
    }
  }
}

async function resetPassword() {
  const msgEl = $('reset-msg');
  showMsg(msgEl, '', '');

  const newPw = ($('pw-reset-new')?.value || '').trim();
  const confirm = ($('pw-reset-confirm')?.value || '').trim();

  if (newPw.length < 8) {
    showMsg(msgEl, 'Password must be at least 8 characters.', 'err');
    return;
  }
  if (newPw !== confirm) {
    showMsg(msgEl, 'Passwords do not match.', 'err');
    return;
  }

  const btn = $('submit-reset');
  if (btn) { btn.textContent = '⏳ Resetting…'; btn.disabled = true; }

  try {
    const salt = generateSalt();
    const key = await deriveKey(newPw, salt);

    const verifyToken = await encrypt('STEALTH_OK', key);
    await StealthStorage.set('masterSalt', Array.from(salt));
    await StealthStorage.set('verifyToken', verifyToken);

    const keyBytes = await exportKeyBytes(key);
    await sendMsg({ type: 'SET_SESSION_KEY', keyBytes });

    showMsg(msgEl, 'Password reset successfully!', 'ok');
    setTimeout(() => {
      selectedTabIds.clear();
      decoyMap = {};
      loadTabs();
      showView(1);
    }, 1500);
  } catch (err) {
    showMsg(msgEl, 'Error: ' + err.message, 'err');
  } finally {
    if (btn) { btn.textContent = 'Reset Password'; btn.disabled = false; }
  }
}
