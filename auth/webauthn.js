/**
 * StealthTab WebAuthn Wrapper
 * Handles biometric credential registration and verification.
 * NOTE: WEBAUTHN_KEYS (not STORAGE_KEYS) to avoid collision with storage.js
 */

const WEBAUTHN_KEYS = {
  REGISTRY: 'webauthnRegistry'
};

class StealthWebAuthn {
  static isSupported() {
    return typeof window !== 'undefined'
      && !!window.PublicKeyCredential
      && !!navigator.credentials;
  }

  /**
   * Register a new biometric credential.
   * Stores credId so verifyCredential can send allowCredentials.
   */
  static async registerCredential(username) {
    if (!this.isSupported()) {
      throw new Error('WebAuthn is not supported in this browser.');
    }

    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const userId    = crypto.getRandomValues(new Uint8Array(16));

    // NOTE: Do NOT set rp.id inside a chrome-extension:// page —
    // the browser will use the extension origin automatically.
    const creationOptions = {
      publicKey: {
        challenge,
        rp: { name: 'StealthTab' },
        user: {
          id: userId,
          name: username || 'stealthtab-user',
          displayName: 'StealthTab User'
        },
        pubKeyCredParams: [
          { alg: -7,   type: 'public-key' }, // ES256
          { alg: -257, type: 'public-key' }  // RS256
        ],
        timeout: 60000,
        attestation: 'none',   // 'direct' causes issues on some platforms
        authenticatorSelection: {
          userVerification: 'required',
          residentKey: 'preferred'           // 'required' may not be supported everywhere
        }
      }
    };

    let credential;
    try {
      credential = await navigator.credentials.create(creationOptions);
    } catch (e) {
      throw new Error('Biometric registration failed: ' + e.message);
    }

    // Store the credential ID (base64url) for later allowCredentials lookup
    const credId = credential.id;
    await this._storeCredential(credId, username || 'stealthtab-user');
    return { credId, registered: true };
  }

  static async _storeCredential(credId, username) {
    const registry = await this._getRegistry();
    // Avoid duplicates
    if (!registry.find(r => r.credId === credId)) {
      registry.push({ credId, username, created: Date.now() });
    }
    await chrome.storage.local.set({ [WEBAUTHN_KEYS.REGISTRY]: registry });
  }

  static async _getRegistry() {
    const r = await chrome.storage.local.get(WEBAUTHN_KEYS.REGISTRY);
    return r[WEBAUTHN_KEYS.REGISTRY] || [];
  }

  /**
   * Verify an existing credential. Returns the matched registry entry.
   */
  static async verifyCredential() {
    if (!this.isSupported()) {
      throw new Error('WebAuthn is not supported.');
    }

    const registry = await this._getRegistry();
    if (!registry.length) {
      throw new Error('No biometric credentials registered. Please set up fingerprint first.');
    }

    const challenge = crypto.getRandomValues(new Uint8Array(32));

    // Build allowCredentials from stored credId (base64url strings)
    const allowCredentials = registry.map(r => ({
      id: StealthWebAuthn._base64urlToBuffer(r.credId),
      type: 'public-key',
      transports: ['internal']
    }));

    // NOTE: Do NOT set rpId inside chrome-extension:// pages
    const assertionOptions = {
      publicKey: {
        challenge,
        timeout: 60000,
        userVerification: 'required',
        allowCredentials
      }
    };

    let assertion;
    try {
      assertion = await navigator.credentials.get(assertionOptions);
    } catch (e) {
      if (e.name === 'NotAllowedError') {
        throw new Error('Biometric authentication was cancelled or timed out.');
      }
      throw new Error('Biometric verification failed: ' + e.message);
    }

    const matched = registry.find(r => r.credId === assertion.id);
    if (!matched) throw new Error('Credential not found in registry.');

    return { verified: true, credId: assertion.id, username: matched.username };
  }

  static async hasCredentials() {
    const r = await this._getRegistry();
    return r.length > 0;
  }

  static async deleteCredentials() {
    await chrome.storage.local.remove(WEBAUTHN_KEYS.REGISTRY);
  }

  // ── Base64url <-> ArrayBuffer helpers ──
  static _base64urlToBuffer(base64url) {
    const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(base64.length + (4 - base64.length % 4) % 4, '=');
    const binary = atob(padded);
    const bytes  = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }

  static _bufferToBase64url(buffer) {
    const bytes  = new Uint8Array(buffer);
    let binary   = '';
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  }
}

if (typeof module !== 'undefined') module.exports = StealthWebAuthn;
