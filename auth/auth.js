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

  // ── Detect stored auth method and pre-select ──
  const storedMethod = await StealthStorage.get('authMethod');
  const hasBiometric = await StealthWebAuthn.hasCredentials();
  if (storedMethod === 'biometric' && hasBiometric) {
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
        showMsg('No password has been configured. Open the extension popup to set one.', 'err');
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
    if (!StealthWebAuthn.isSupported()) {
      showMsg('Fingerprint authentication is not available in this browser.', 'err');
      return;
    }

    const hasCreds = await StealthWebAuthn.hasCredentials();
    if (!hasCreds) {
      showMsg('No fingerprint registered. Please use password, or re-setup in the popup.', 'err');
      switchMethod('password');
      return;
    }

    const btn = document.getElementById('unlock-bio-btn');
    btn.disabled = true;
    btn.textContent = 'Waiting for fingerprint…';
    showMsg('', '');

    try {
      const result = await StealthWebAuthn.verifyCredential();

      if (result.verified) {
        // Biometric says WHO you are. But the AES key comes from backup password.
        // Retrieve encrypted backup password or prompt.
        const backupSaltArr = await StealthStorage.get('backupSalt');
        if (backupSaltArr) {
          const encryptedBackup = await StealthStorage.get('encryptedBackupPw');
          if (encryptedBackup) {
            // We have an encrypted backup — try to unlock directly via AUTH_SUCCESS
            // Background still has the session key if it was set in this session
            const resp = await sendMsg({ type: 'AUTH_SUCCESS', tabId: targetTabId });
            if (resp?.ok) {
              showMsg('✅ Fingerprint accepted!', 'ok');
              setTimeout(() => window.close(), 900);
              return;
            }
          }
        }
        // No backup or session expired — ask for password to re-derive key
        showMsg('Fingerprint accepted! Session expired — please re-enter your backup password.', 'warn');
        switchMethod('password');
      }
    } catch (err) {
      showMsg(err.message, 'err');
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
