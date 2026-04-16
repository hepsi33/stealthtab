/**
 * StealthTab Storage Helpers
 * SECURITY: Validates all inputs before storage operations.
 *
 * Note: get/set accept raw string keys (e.g. 'masterSalt', 'verifyToken')
 * as well as the constant-name lookup (e.g. 'MASTER_SALT').
 * getPrivateTabs/updatePrivateTab/removePrivateTab use PRIVATE_TABS key directly.
 */

const STORAGE_KEYS = {
  MASTER_SALT:       'masterSalt',
  AUTH_METHOD:      'authMethod',
  VERIFY_TOKEN:      'verifyToken',
  PRIVATE_TABS:     'privateTabs',
  DECOY_SITES:       'decoySites',
  RECOVERY_CODE_HASH: 'recovery_code_hash',
  RECOVERY_ATTEMPTS:   'recovery_attempts',
  RECOVERY_LOCK_UNTIL: 'recovery_lock_until'
};

// Build a reverse lookup: 'masterSalt' → 'masterSalt' (for raw-string calls)
const _VALID_KEYS = new Set(Object.values(STORAGE_KEYS));

function isValidTabId(id) {
  return typeof id === 'number' && id > 0 && Number.isInteger(id);
}

function isValidUrl(url) {
  if (typeof url !== 'string') return false;
  try {
    const p = new URL(url);
    return p.protocol === 'http:' || p.protocol === 'https:';
  } catch { return false; }
}

function sanitizeString(str, maxLen = 500) {
  if (typeof str !== 'string') return '';
  return str.trim().slice(0, maxLen);
}

const StealthStorage = {

  /**
   * Get a value from storage.
   * @param {string} key  Raw key string (e.g. 'masterSalt') or constant name ('MASTER_SALT')
   */
  async get(key) {
    // Accept both 'masterSalt' (raw) and 'MASTER_SALT' (constant name)
    const realKey = _VALID_KEYS.has(key) ? key : STORAGE_KEYS[key];
    if (!realKey) return undefined;
    const r = await chrome.storage.local.get(realKey);
    return r[realKey];
  },

  /**
   * Set a value in storage.
   * @param {string} key  Raw key string or constant name
   */
  async set(key, value) {
    const realKey = _VALID_KEYS.has(key) ? key : STORAGE_KEYS[key];
    if (!realKey) return;
    await chrome.storage.local.set({ [realKey]: value });
  },

  async getPrivateTabs() {
    const r = await chrome.storage.local.get(STORAGE_KEYS.PRIVATE_TABS);
    const data = r[STORAGE_KEYS.PRIVATE_TABS];
    if (!data || typeof data !== 'object') return {};
    const valid = {};
    for (const [k, v] of Object.entries(data)) {
      const tabId = parseInt(k, 10);
      if (isValidTabId(tabId) && v && typeof v === 'object') {
        valid[tabId] = {
          encryptedUrl: v.encryptedUrl,
          decoyUrl:     sanitizeString(v.decoyUrl),
          title:        sanitizeString(v.title),
          status:       (v.status === 'locked' || v.status === 'unlocked') ? v.status : 'locked'
        };
      }
    }
    return valid;
  },

  async updatePrivateTab(tabId, patch) {
    if (!isValidTabId(tabId) || !patch || typeof patch !== 'object') return;
    const tabs = await this.getPrivateTabs();
    tabs[tabId] = { ...(tabs[tabId] || {}), ...patch };
    await chrome.storage.local.set({ [STORAGE_KEYS.PRIVATE_TABS]: tabs });
  },

  async removePrivateTab(tabId) {
    if (!isValidTabId(tabId)) return;
    const r    = await chrome.storage.local.get(STORAGE_KEYS.PRIVATE_TABS);
    const tabs = r[STORAGE_KEYS.PRIVATE_TABS] || {};
    delete tabs[tabId];
    await chrome.storage.local.set({ [STORAGE_KEYS.PRIVATE_TABS]: tabs });
  },

  async getDecoySites() {
    const r = await chrome.storage.local.get(STORAGE_KEYS.DECOY_SITES);
    let d = r[STORAGE_KEYS.DECOY_SITES];
    if (!Array.isArray(d) || d.length === 0) {
      d = [
        { name: 'LinkedIn',  url: 'https://www.linkedin.com'  },
        { name: 'YouTube',   url: 'https://www.youtube.com'   },
        { name: 'Google',    url: 'https://www.google.com'    },
        { name: 'GitHub',    url: 'https://github.com'        },
        { name: 'Wikipedia', url: 'https://www.wikipedia.org' }
      ];
      await chrome.storage.local.set({ [STORAGE_KEYS.DECOY_SITES]: d });
    }
    return d.filter(s => s && s.name && isValidUrl(s.url));
  },

  async setRecoveryCodeHash(hash) {
    if (!hash || typeof hash !== 'string') return;
    await chrome.storage.local.set({ [STORAGE_KEYS.RECOVERY_CODE_HASH]: hash });
  },

  async getRecoveryCodeHash() {
    const r = await chrome.storage.local.get(STORAGE_KEYS.RECOVERY_CODE_HASH);
    return r[STORAGE_KEYS.RECOVERY_CODE_HASH];
  },

  async hasRecoveryCode() {
    const hash = await this.getRecoveryCodeHash();
    return !!(hash && hash.length > 0);
  },

  async getRecoveryAttempts() {
    const r = await chrome.storage.local.get(STORAGE_KEYS.RECOVERY_ATTEMPTS);
    return r[STORAGE_KEYS.RECOVERY_ATTEMPTS] || 0;
  },

  async incrementRecoveryAttempts() {
    const current = await this.getRecoveryAttempts();
    await chrome.storage.local.set({ [STORAGE_KEYS.RECOVERY_ATTEMPTS]: current + 1 });
  },

  async resetRecoveryAttempts() {
    await chrome.storage.local.set({ [STORAGE_KEYS.RECOVERY_ATTEMPTS]: 0 });
  },

  async setRecoveryLockUntil(timestamp) {
    await chrome.storage.local.set({ [STORAGE_KEYS.RECOVERY_LOCK_UNTIL]: timestamp });
  },

  async getRecoveryLockUntil() {
    const r = await chrome.storage.local.get(STORAGE_KEYS.RECOVERY_LOCK_UNTIL);
    return r[STORAGE_KEYS.RECOVERY_LOCK_UNTIL] || 0;
  },

  async isRecoveryLocked() {
    const lockUntil = await this.getRecoveryLockUntil();
    return lockUntil > Date.now();
  },

  async getRecoveryLockRemainingSeconds() {
    const lockUntil = await this.getRecoveryLockUntil();
    const remaining = lockUntil - Date.now();
    return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
  }
};
