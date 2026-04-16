/**
 * StealthTab Storage Helpers
 * SECURITY: Validates all inputs before storage operations.
 */

const STORAGE_KEYS = {
  MASTER_SALT:       'masterSalt',
  AUTH_METHOD:      'authMethod',
  VERIFY_TOKEN:      'verifyToken',
  PRIVATE_TABS:     'privateTabs',
  DECOY_SITES:       'decoySites',
  BIOMETRIC_CREDENTIAL_ID: 'biometric_credential_id',
  BIOMETRIC_ENABLED:       'biometric_enabled',
  BIOMETRIC_REGISTERED_AT:  'biometric_registered_at',
  BIOMETRIC_SCHEMA_VERSION: 'biometric_schema_version',
  SCHEMA_VERSION:           'schema_version'
};

// Reverse lookup for raw key strings
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
  // ---------- Generic get / set ----------
  async get(key) {
    const realKey = _VALID_KEYS.has(key) ? key : STORAGE_KEYS[key];
    if (!realKey) return undefined;
    const r = await chrome.storage.local.get(realKey);
    return r[realKey];
  },

  async set(key, value) {
    const realKey = _VALID_KEYS.has(key) ? key : STORAGE_KEYS[key];
    if (!realKey) return;
    await chrome.storage.local.set({ [realKey]: value });
  },

  // ---------- Private tabs ----------
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
    const r = await chrome.storage.local.get(STORAGE_KEYS.PRIVATE_TABS);
    const tabs = r[STORAGE_KEYS.PRIVATE_TABS] || {};
    delete tabs[tabId];
    await chrome.storage.local.set({ [STORAGE_KEYS.PRIVATE_TABS]: tabs });
  },

  // ---------- Decoy sites ----------
  async getDecoySites() {
    const r = await chrome.storage.local.get(STORAGE_KEYS.DECOY_SITES);
    let d = r[STORAGE_KEYS.DECOY_SITES];
    if (!Array.isArray(d) || d.length === 0) {
      d = [
        { name: 'LinkedIn',  url: 'https://www.linkedin.com' },
        { name: 'YouTube',   url: 'https://www.youtube.com' },
        { name: 'Google',    url: 'https://www.google.com' },
        { name: 'GitHub',    url: 'https://github.com' },
        { name: 'Wikipedia', url: 'https://www.wikipedia.org' }
      ];
      await chrome.storage.local.set({ [STORAGE_KEYS.DECOY_SITES]: d });
    }
    return d.filter(s => s && s.name && isValidUrl(s.url));
  },
  // ---------- Migration ----------
  async runMigration() {
    const CURRENT_VERSION = 2;
    const r = await chrome.storage.local.get(STORAGE_KEYS.SCHEMA_VERSION);
    const saved = r[STORAGE_KEYS.SCHEMA_VERSION] || 1;

    if (saved < CURRENT_VERSION) {
      console.log(`[StealthStorage] 🛠️ Migrating storage v${saved} → v${CURRENT_VERSION}`);
      
      // Cleanup legacy keys from previous versions
      const legacy = ['RECOVERY_CODE_HASH', 'RECOVERY_ATTEMPTS', 'RECOVERY_LOCK_UNTIL', 'backupSalt'];
      await chrome.storage.local.remove(legacy);
      
      await chrome.storage.local.set({ [STORAGE_KEYS.SCHEMA_VERSION]: CURRENT_VERSION });
      console.log('[StealthStorage] ✅ Migration complete');
    }
  }
};


// No export needed — used via global variable in scripts/importScripts
