/**
 * StealthTab — auth.js
 * Biometric identity verification + password-based AES key derivation.
 *
 * SECURITY MODEL:
 *  - Password path: derive AES key from password → verify token → send key + unlock
 *  - Biometric path: verify identity via WebAuthn → then derive AES key from backup password
 *    (biometric proves who you are, but the AES key still comes from PBKDF2 + backup password)
 *
 * IMPORTANT: No inline onclick — all listeners use addEventListener.
 */

(async () => {
  const params      = new URLSearchParams(window.location.search);
  const targetTabId = params.get('tabId') ? parseInt(params.get('tabId'), 10) : null;
  const msgEl       = document.getElementById('msg');

  if (!targetTabId || isNaN(targetTabId)) {
    showMsg('Invalid or missing tab ID. Please close and retry.', 'err');
    return;
  }

  // ── 0. Migration Check ──
  await StealthStorage.runMigration();

  // Phase 1, 3 & 4: Detect enrollment
  const store = await chrome.storage.local.get(['biometric_enabled', 'biometric_credential_id', 'authMethod']);
  const isEnabled    = store.biometric_enabled;
  const hasCred      = !!store.biometric_credential_id; // 🔐 Double-check enrollment
  const storedMethod = store.authMethod;

  // Logic to hide/disable biometric button if not enrolled
  if (!isEnabled || !hasCred) {
    document.getElementById('btn-toggle-bio').style.display = 'none';
    switchMethod('password');
  } else if (storedMethod === 'biometric') {
    switchMethod('biometric');
  } else {
    switchMethod('password');
  }

  // ── Method toggle (listeners — no inline onclick) ──
  document.getElementById('btn-toggle-pw').addEventListener('click', () => switchMethod('password'));
  document.getElementById('btn-toggle-bio').addEventListener('click', () => switchMethod('biometric'));
  document.getElementById('btn-use-password-instead').addEventListener('click', () => switchMethod('password'));

  function switchMethod(m) {
    document.getElementById('panel-password').classList.toggle('active', m === 'password');
    document.getElementById('panel-biometric').classList.toggle('active', m === 'biometric');
    document.getElementById('btn-toggle-pw').classList.toggle('active', m === 'password');
    document.getElementById('btn-toggle-bio').classList.toggle('active', m === 'biometric');
    if (m === 'password') setTimeout(() => document.getElementById('pw-input').focus(), 50);
  }

  // ── Password unlock ──
  document.getElementById('unlock-pw-btn').addEventListener('click', doPasswordUnlock);
  document.getElementById('pw-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') doPasswordUnlock();
  });

  async function doPasswordUnlock() {
    const pw = document.getElementById('pw-input').value;
    if (!pw) { showMsg('Please enter your password.', 'err'); return; }

    const btn = document.getElementById('unlock-pw-btn');
    btn.disabled = true;
    btn.textContent = 'Verifying…';
    showMsg('', '');

    try {
      const saltArr     = await StealthStorage.get('masterSalt');
      const verifyToken = await StealthStorage.get('verifyToken');

      if (!saltArr) {
        // 🔐 Resilient Reset: Handle missing storage after local.clear()
        showMsg('Encryption keys missing. Your storage may have been reset. Please close this tab and re-setup in the popup.', 'err');
        return;
      }

      const salt = new Uint8Array(saltArr);
      const key  = await deriveKey(pw, salt);

      // Verify correct password by decrypting the known token
      if (verifyToken) {
        let plaintext;
        try {
          plaintext = await decrypt(verifyToken, key);
        } catch {
          plaintext = null;
        }
        if (plaintext !== 'STEALTH_OK') {
          showMsg('Incorrect password. Please try again.', 'err');
          document.getElementById('pw-input').value = '';
          document.getElementById('pw-input').focus();
          return;
        }
      }

      // Key is valid — export bytes (CryptoKey not serializable) then unlock
      const keyBytes = await exportKeyBytes(key);
      const resp = await sendMsg({ type: 'SET_KEY_AND_UNLOCK', keyBytes, tabId: targetTabId });
      if (resp?.ok) {
        showMsg('✅ Unlocked successfully!', 'ok');
        setTimeout(() => window.close(), 900);
      } else {
        showMsg('Unlock failed — the tab may have been closed.', 'err');
      }
    } catch (err) {
      showMsg('Error: ' + err.message, 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Unlock →';
    }
  }

  // ── Biometric unlock ──
  document.getElementById('unlock-bio-btn').addEventListener('click', doBiometricUnlock);

  async function doBiometricUnlock() {
    // 🔐 Critical Improvement #5: Authentication MUST only run in click handler (User Gesture)
    const btn = document.getElementById('unlock-bio-btn');
    btn.disabled = true;
    btn.textContent = 'Waiting for fingerprint…';
    showMsg('', '');

    try {
      // 🔐 WebAuthn Engine v4.0 handles fresh challenge & ID existence check internally
      const result = await StealthWebAuthn.verifyCredential();

      if (result.verified) {
        const masterSaltArr = await StealthStorage.get('masterSalt');
        
        // 🔐 Architectural Correction: Retrieve session-cached password to derive key
        const sessionStore = await chrome.storage.session.get('backupPassword');
        const backupPw = sessionStore.backupPassword;

        if (masterSaltArr && backupPw) {
          const salt = new Uint8Array(masterSaltArr);
          const key  = await deriveKey(backupPw, salt);
          const keyBytes = await exportKeyBytes(key);

          const resp = await sendMsg({ 
            type: 'SET_KEY_AND_UNLOCK', 
            keyBytes, 
            tabId: targetTabId 
          });

          if (resp?.ok) {
            showMsg('✅ Fingerprint accepted!', 'ok');
            setTimeout(() => window.close(), 900);
            return;
          }
        }
        
        // Fallback: If session key/password is missing (browser restart), ask for it once.
        showMsg('Fingerprint accepted! Please enter your password below to finalize unlocking.', 'warn');
        switchMethod('password');
      }
    } catch (err) {
      // ⭐ Optimized Error reporting (Using err.name for reliability)
      console.error('[StealthTab Auth] Biometric error:', err);
      
      if (err.name === 'NotAllowedError') {
        showMsg('Authentication cancelled or hardware unavailable.', 'warn');
      } else if (err.name === 'SecurityError') {
        showMsg('Security block: Please ensure you are on a trusted origin.', 'err');
      } else if (err.name === 'AbortError') {
        showMsg('Operation aborted.', 'warn');
      } else {
        showMsg(err.message || 'Verification failed.', 'err');
        setTimeout(() => switchMethod('password'), 2500);
      }
    } finally {
      btn.disabled = false;
      btn.textContent = 'Use Fingerprint →';
    }
  }

  // ── Helpers ──
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

  function showMsg(text, type) {
    msgEl.textContent = text;
    msgEl.className   = 'msg' + (type ? ` ${type}` : '');
    msgEl.style.display = text ? 'block' : 'none';
  }
})();
