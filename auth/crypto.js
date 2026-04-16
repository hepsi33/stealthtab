/**
 * StealthTab — crypto.js
 * AES-256-GCM + PBKDF2 (310,000 iterations)
 *
 * IMPORTANT: CryptoKey objects CANNOT be sent through chrome.runtime.sendMessage
 * (structured clone does not support them). Use exportKeyBytes() / importKeyBytes()
 * to convert to/from plain arrays for cross-context transfer.
 */

const PBKDF2_ITERATIONS = 310000;

/**
 * Derive an AES-256-GCM key from a password + salt.
 * extractable: TRUE so we can export raw bytes for cross-context transfer.
 */
async function deriveKey(password, salt) {
  const enc          = new TextEncoder();
  const passwordData = enc.encode(String(password));
  if (passwordData.length === 0) throw new Error('Password cannot be empty');

  const baseKey = await crypto.subtle.importKey(
    'raw', passwordData, 'PBKDF2', false, ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    true,                  // ← extractable so we can export bytes for messaging
    ['encrypt', 'decrypt']
  );
}

/**
 * Export a CryptoKey to a plain number[] for chrome.runtime.sendMessage.
 */
async function exportKeyBytes(key) {
  const raw = await crypto.subtle.exportKey('raw', key);
  return Array.from(new Uint8Array(raw));
}

/**
 * Import a number[] (received via chrome.runtime.sendMessage) back to a CryptoKey.
 */
async function importKeyBytes(bytes) {
  return crypto.subtle.importKey(
    'raw',
    new Uint8Array(bytes),
    { name: 'AES-GCM', length: 256 },
    false,                 // non-extractable once in the service worker
    ['encrypt', 'decrypt']
  );
}

async function encrypt(plaintext, key) {
  if (!key)                                     throw new Error('Key is required');
  if (plaintext == null)                        throw new Error('Plaintext is required');

  const iv         = crypto.getRandomValues(new Uint8Array(12));
  const enc        = new TextEncoder();
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, tagLength: 128 },
    key,
    enc.encode(String(plaintext))
  );
  return {
    ct: Array.from(new Uint8Array(ciphertext)),
    iv: Array.from(iv)
  };
}

async function decrypt(data, key) {
  if (!key)                          throw new Error('Key is required');
  if (!data || !data.ct || !data.iv) throw new Error('Invalid encrypted data format');

  const plainBuf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(data.iv), tagLength: 128 },
    key,
    new Uint8Array(data.ct)
  );
  return new TextDecoder().decode(plainBuf);
}

function generateSalt() {
  return crypto.getRandomValues(new Uint8Array(32));  // 256-bit salt
}

/**
 * Hash a string using SHA-256.
 * Returns hex string representation.
 */
async function sha256Hash(plaintext) {
  const enc = new TextEncoder();
  const data = enc.encode(String(plaintext));
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Verify an input against a stored SHA-256 hash.
 * Returns true if match.
 */
async function verifyHash(plaintext, storedHash) {
  const inputHash = await sha256Hash(plaintext);
  return inputHash === storedHash;
}
