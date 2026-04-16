# 🔒 Security Decisions: StealthTab Architectural Log

This document records the high-stakes security decisions made during the development of StealthTab. It serves as an audit trail for developers and a technical justification for interviewers.

---

### 1. Choice of PBKDF2 with 310,000 Iterations
*   **Decision**: Use PBKDF2 instead of Scrypt or Argon2. Use 310,000 iterations.
*   **Rationale**: 
    1. **Native Support**: PBKDF2 is natively supported by `crypto.subtle` in all modern browsers, requiring no external libraries.
    2. **OWASP Compliance**: 310,000 iterations is the current OWASP recommendation for SHA-256 PBKDF2 (as of 2023). 
    3. **Performance**: Provides a strong balance between "cracking resistance" and setup speed (~1-2 seconds on modern CPUs).

### 2. Decision: "Memory-Only" Session Keys
*   **Decision**: Master AES keys are NEVER written to disk (`chrome.storage.local`). They are stored only in Service Worker memory and `chrome.storage.session`.
*   **Rationale**:
    1. **Data-at-Rest Protection**: If the device is stolen or the filesystem is dumped, the private URLs remain encrypted and mathematically unbreakable without the in-memory key.
    2. **Forced Closure**: Closing the browser naturally wipes the `session` storage, ensuring that private tabs are "Hard Locked" between browser restarts.

### 3. Decision: Biometric Hybrid Identity Flow
*   **Decision**: Fingerprint is used for Identity Verification, not direct encryption.
*   **Rationale**: 
    1. **Browser Limitation**: `WebAuthn` in extensions doesn't return a consistent bit-string that can be used directly as an AES key without significant platform-specific complexity.
    2. **Reliability**: By proving identity first and then using a volatile "Backup Password" to derive the key, we get the speed of biometrics with the cryptographic strength of PBKDF2.

### 4. Decision: AES-256-GCM (Galois/Counter Mode)
*   **Decision**: Standardize on GCM for all encryption.
*   **Rationale**: 
    1. **Integrity + Authenticity**: GCM provides both encryption and an authentication tag. If even a single bit of the encrypted URL is tampered with, decryption will fail instead of returning garbage.
    2. **Performance**: GCM is hardware-accelerated on most modern processors.

### 5. Decision: Content Script Isolation
*   **Decision**: Content scripts (which run on decoy pages) have ZERO access to encryption keys.
*   **Rationale**:
    1. **Avoid XSS Leaks**: If a decoy website (e.g., LinkedIn) has a vulnerability, an attacker cannot steal the encryption keys because they are isolated in the Extension Service Worker.
