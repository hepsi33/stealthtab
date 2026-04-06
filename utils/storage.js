/**
 * StealthTab Storage Helpers
 * SECURITY: Validates all inputs before storage operations
 */

const STORAGE_KEYS = {
  MASTER_SALT: 'masterSalt',
  AUTH_METHOD: 'authMethod',
  PRIVATE_TABS: 'privateTabs',
  DECOY_SITES: 'decoySites'
};

function isValidTabId(id) {
  return typeof id === 'number' && id > 0 && Number.isInteger(id);
}

function isValidUrl(url) {
  if (typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function sanitizeString(str, maxLen = 500) {
  if (typeof str !== 'string') return '';
  return str.trim().slice(0, maxLen);
}

const StealthStorage = {
  async get(key) {
    if (!STORAGE_KEYS[key]) return undefined;
    const r = await chrome.storage.local.get(key);
    return r[key];
  },
  async set(key, value) {
    if (!STORAGE_KEYS[key]) return;
    if (key === STORAGE_KEYS.PRIVATE_TABS && typeof value !== 'object') return;
    if (key === STORAGE_KEYS.MASTER_SALT && !Array.isArray(value)) return;
    if (key === STORAGE_KEYS.AUTH_METHOD && !['password', 'biometric'].includes(value)) return;
    await chrome.storage.local.set({ [key]: value });
  },
  async getPrivateTabs() {
    const data = await this.get(STORAGE_KEYS.PRIVATE_TABS);
    if (!data || typeof data !== 'object') return {};
    const valid = {};
    for (const [k, v] of Object.entries(data)) {
      const tabId = parseInt(k, 10);
      if (isValidTabId(tabId) && v && typeof v === 'object') {
        valid[tabId] = {
          encryptedUrl: v.encryptedUrl,
          decoyUrl: sanitizeString(v.decoyUrl),
          title: sanitizeString(v.title),
          status: v.status === 'locked' || v.status === 'unlocked' ? v.status : 'locked'
        };
      }
    }
    return valid;
  },
  async updatePrivateTab(tabId, patch) {
    if (!isValidTabId(tabId)) return;
    if (!patch || typeof patch !== 'object') return;
    const tabs = await this.getPrivateTabs();
    tabs[tabId] = { ...tabs[tabId], ...patch };
    await this.set(STORAGE_KEYS.PRIVATE_TABS, tabs);
  },
  async removePrivateTab(tabId) {
    if (!isValidTabId(tabId)) return;
    const tabs = await this.getPrivateTabs();
    delete tabs[tabId];
    await this.set(STORAGE_KEYS.PRIVATE_TABS, tabs);
  },
  async getDecoySites() {
    let d = await this.get(STORAGE_KEYS.DECOY_SITES);
    if (!Array.isArray(d) || d.length === 0) {
      d = [
        { name: 'LinkedIn',  url: 'https://www.linkedin.com' },
        { name: 'YouTube',   url: 'https://www.youtube.com'  },
        { name: 'Google',    url: 'https://www.google.com'   },
        { name: 'GitHub',    url: 'https://github.com'       }
      ];
      await this.set(STORAGE_KEYS.DECOY_SITES, d);
    }
    return d.filter(s => s && s.name && isValidUrl(s.url));
  }
};
