# 🛡 StealthTab — Private Tab Cloaking Extension

> Hide any browser tab behind a convincing decoy website. Secured with AES-256-GCM encryption and optional biometric authentication.

## ✨ Features

- **Tab Cloaking** — Mark any tab as private; it shows a decoy site (LinkedIn, YouTube, Google, etc.) to anyone viewing your screen
- **AES-256-GCM Encryption** — Real URLs encrypted with PBKDF2-derived keys (310,000 iterations)
- **Biometric Auth** — WebAuthn fingerprint authentication (where hardware supports it)
- **Password Fallback** — Master password with strength indicator and verify token
- **Toolbar Icon** — Switches between 🔒 (locked) and 🔓 (unlocked) state per-tab
- **Auto-Lock** — Tabs re-lock after 30 minutes of inactivity
- **Overlay Guard** — Lock screen injected into page, re-injects itself if removed (MutationObserver)
- **Session Security** — Session key lives only in memory; wiped on browser restart

## 🏗 Architecture

```
stealthtab/
├── manifest.json              # MV3 manifest
├── background/
│   └── service-worker.js      # Tab state, encryption, icon drawing, timers
├── popup/
│   ├── popup.html             # 4-step lock wizard UI
│   └── popup.js               # Wizard controller (event delegation, no inline handlers)
├── auth/
│   ├── auth.html              # Authentication popup (password + biometric)
│   ├── auth.js                # Auth logic
│   ├── crypto.js              # AES-GCM + PBKDF2 + key export/import helpers
│   └── webauthn.js            # WebAuthn credential registration + verification
├── content/
│   ├── overlay.js             # Lock screen content script with MutationObserver guard
│   └── overlay.css            # Lock screen styles (!important for override)
├── utils/
│   └── storage.js             # chrome.storage.local wrappers
└── assets/
    └── icons/                 # Extension icons (16, 48, 128px)
```

## 🔐 Security Model

| Layer | Implementation |
|-------|---------------|
| Key derivation | PBKDF2, SHA-256, 310,000 iterations, 256-bit salt |
| Encryption | AES-256-GCM, 128-bit auth tag, unique 96-bit IV per encryption |
| Password verification | `verifyToken` = `encrypt('STEALTH_OK', key)` — wrong password → decrypt fails |
| Key transfer | `CryptoKey` exported to raw bytes (Array) for `chrome.runtime.sendMessage`; never stored |
| Session persistence | Session key only in service worker memory; cleared on browser start |
| Overlay protection | MutationObserver re-injects lock screen if removed; attached to `<html>` not `<body>` |
| Auth rate limiting | 1-second cooldown per sender for `SET_KEY_AND_UNLOCK` |
| Sender validation | All messages validated: `sender.id === chrome.runtime.id` |

## 🚀 Installation (Chrome / Edge / Brave)

1. Clone this repo
2. Open `chrome://extensions`
3. Enable **Developer Mode** (top-right toggle)
4. Click **Load unpacked** → select the `stealthtab/` folder
5. Click the **🧩 puzzle piece** in the toolbar → pin **StealthTab**

## 🎯 Usage

1. Click the **StealthTab** toolbar icon
2. Select tab(s) to hide
3. Choose a decoy website per tab
4. Set a master password (or fingerprint + backup password)
5. Click **🔒 Lock Selected Tabs**
6. To unlock: click the **🔒** icon in the toolbar → enter password or use fingerprint

## 📋 Permissions

| Permission | Reason |
|------------|--------|
| `tabs` | Read tab URL/title for cloaking |
| `storage` | Store encrypted tab data locally |
| `scripting` | Inject lock overlay into pages |
| `contextMenus` | Right-click "Mark Tab as Private" |
| `activeTab` | Access current tab on popup open |
| `webNavigation` | Detect navigation to re-apply overlay |

## 🌐 Browser Compatibility

| Browser | Status |
|---------|--------|
| Chrome 116+ | ✅ Full support |
| Edge 116+ | ✅ Full support |
| Brave | ✅ Full support |
| Firefox | ⚠️ MV3 partial (no `chrome.action.setIcon` with ImageData) |

---

Built with ❤️ using Manifest V3, Web Crypto API, and WebAuthn.
