# 🛡️ StealthTab — Advanced Private Tab Cloaking

> **StealthTab** is a security-hardened browser extension that instantly cloaks sensitive tabs behind harmless decoy origins. Built with an "Intentional Security" philosophy, it combines AES-256-GCM encryption with browser-native WebAuthn biometrics to provide a professional-grade privacy solution.

---

## 📺 Demo

https://github.com/user-attachments/assets/955bf3c6-2a8b-4a71-af1b-7b265fa5b31b


*Protect your workflow with a single click.*

---

## ✨ Features
- **Semantic Cloaking**: Instantly redirects sensitive tabs to interactive decoys (LinkedIn, YouTube, Google, etc.).
- **Biometric Integration**: Seamless fingerprint authentication via WebAuthn, hardware-blind and resilient.
- **Volatile Session Management**: Encryption keys are stored in transient memory (`service-worker` RAM and `chrome.storage.session`), surviving restarts but wiped on browser exit.
- **Advanced Crypto**: AES-256-GCM encryption with PBKDF2 key derivation (310,000 iterations).
- **Stealth State Machine**: A robust setup wizard that ensures identity verification and enrollment integrity.

## 🏗️ Technical Architecture
For a deep dive into how StealthTab manages sessions and navigations, see our **[Architecture & Master Guide](DOCUMENTATION.md)**.

### The Security Vault
We've documented every high-stakes architectural choice in our **[Security Decisions Log](SECURITY_DECISIONS.md)**.
- **Why PBKDF2?** Native browser support + OWASP compliance.
- **Why Session Storage?** Prevents secrets from ever touching the disk.
- **Why Hybrid Biometrics?** Combines fingerprint identity with cryptographic password strength.

## 🚀 Installation (Developer Mode)
1. Clone this repository: `git clone https://github.com/hepsi33/stealthtab.git`
2. Open `chrome://extensions` and enable **Developer Mode**.
3. Click **Load unpacked** and select the project folder.
4. Pin **StealthTab** to your toolbar.

## 🎯 Quick Start
1. Select the tabs you want to protect.
2. Choose your decoy websites for each tab.
3. Secure with a Password or Fingerprint + Backup Password.
4. Click **Lock Selected Tabs**. 
5. **Unlock**: Use your identity to reveal the real content instantly.

---

## 🔒 Storage Contract
| Storage Type | Purpose | Persistence |
| :--- | :--- | :--- |
| `chrome.storage.local` | Encrypted metadata & salts | Permanent |
| `chrome.storage.session` | Active AES key & backup password | Volatile |
| `Service Worker RAM` | CryptoKey objects | Transient |

---

Built with Manifest V3 and Web Crypto API. 🔒
