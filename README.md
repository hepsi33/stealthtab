# 🛡 StealthTab — Private Tab Cloaking Extension

> Hide any browser tab behind a convincing decoy website. Secured with AES-256-GCM encryption and seamless biometric authentication.

## ✨ Features

- **True Stealth Mode** — Locked tabs redirect to real decoy sites (LinkedIn, YouTube, etc.) that are fully visible and interactive. No blocking overlays on decoy pages!
- **AES-256-GCM Encryption** — Real URLs encrypted with PBKDF2-derived keys (310,000 iterations).
- **Persistent Sessions** — Log in once per browser session. Uses `chrome.storage.session` to keep you authenticated even if the extension's background script restarts.
- **Biometric Auth** — Secure WebAuthn fingerprint authentication with a 4-character backup password fallback.
- **Simplified Security** — No more complex recovery codes. Secure setup in seconds with a 4-character minimum password requirement.
- **Auto-Lock** — Tabs automatically re-lock after 30 minutes of inactivity.
- **Failsafe Overlay Guard** — A hidden content script monitors the page; if an unauthorized attempt to navigate back to the real URL occurs, a lock screen is instantly injected.
- **Audit-Hardened** — Codebase has been line-by-line audited for Manifest V3 stability and security best practices.

## 🏗 Architecture

```
stealthtab/
├── manifest.json              # MV3 manifest
├── background/
│   └── service-worker.js      # Tab state, encryption, session persistence, timers
├── popup/
│   ├── popup.html             # Simplified 3-step lock wizard UI
│   └── popup.js               # Wizard controller (vetted validation, focus-aware biometric setup)
├── auth/
│   ├── auth.html              # Authentication popup (password + biometric)
│   ├── auth.js                # Auth logic (session-aware)
│   ├── crypto.js              # AES-GCM + PBKDF2 + key export/import helpers
│   └── webauthn.js            # WebAuthn credential registration + verification
├── content/
│   ├── overlay.js             # Failsafe lock script (decoy-aware, self-terminating)
│   └── overlay.css            # Lock screen styles
├── utils/
│   └── storage.js             # Whitelisted chrome.storage.local wrappers
└── assets/
    └── icons/                 # Extension icons (16, 48, 128px)
```

## 🔐 Security Model

| Layer | Implementation |
|-------|---------------|
| Key derivation | PBKDF2, SHA-256, 310,000 iterations, 256-bit salt |
| Encryption | AES-256-GCM, 128-bit auth tag, unique 96-bit IV per encryption |
| Password verification | `verifyToken` = `encrypt('STEALTH_OK', key)` |
| Session persistence | `chrome.storage.session` for AES key; survives SW hibernation, cleared on browser exit |
| Stealth Logic | Overlay suppressed on decoy origins; only triggers on unauthorized content access |
| Min Password | 4 characters (Master & Backup) |
| Sender validation | All messages validated: `sender.id === chrome.runtime.id` |

## 🚀 Installation (Chrome / Edge / Brave)

1. Clone this repo
2. Open `chrome://extensions`
3. Enable **Developer Mode** (top-right toggle)
4. Click **Load unpacked** → select the `stealthtab/` folder
5. Click the **🧩 puzzle piece** in the toolbar → pin **StealthTab**

## 🎯 Usage

1. Click the **StealthTab** toolbar icon
2. Select tab(s) to hide and choose your decoy websites
3. Set a master password (min 4 chars) or fingerprint + backup password
4. Click **🔒 Lock Selected Tabs**
5. **To Unlock**: Click the **🔒** icon in the toolbar → use Fingerprint or Password.
6. **Note**: You only need to enter your password once per browser session. After that, your fingerprint will work instantly!

---

Built with ❤️ using Manifest V3, Web Crypto API, and WebAuthn.
