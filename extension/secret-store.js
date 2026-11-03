/**
 * Keeps the Ollama API key sealed at rest.
 *
 * The key is encrypted with AES-GCM; the AES key is generated once as a NON-EXTRACTABLE
 * CryptoKey and lives in the extension's own IndexedDB, so the encrypted blob in
 * chrome.storage.local is useless on its own (a copied storage file, a profile backup, a
 * settings dump) and page/extension code cannot read the AES key back out. Only the
 * background worker ever decrypts it.
 *
 * Honest limit: this is not protection against malware running as you with access to the
 * whole browser profile - nothing an extension can do is. The real safeguards are that the
 * key is only ever sent to ollama.com, never logged, never synced and never shown again.
 */

const DB_NAME = 'usage-tracker-keystore';
const STORE_NAME = 'keys';
const KEY_ID = 'seal-v1';
const SEAL_VERSION = 1;

/** Where the CryptoKey is persisted. Swappable so tests don't need a real IndexedDB. */
let keyStorage = {
  async get() {
    const db = await openDb();
    return request(db.transaction(STORE_NAME).objectStore(STORE_NAME).get(KEY_ID));
  },
  async put(key) {
    const db = await openDb();
    await request(db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).put(key, KEY_ID));
  },
  async delete() {
    const db = await openDb();
    await request(db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).delete(KEY_ID));
  }
};

export function setKeyStorage(storage) {
  keyStorage = storage;
}

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function openDb() {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE_NAME);
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
}

async function sealingKey({ create }) {
  let key = await keyStorage.get();
  if (!key && create) {
    key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    await keyStorage.put(key);
  }
  return key || null;
}

const toBase64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const fromBase64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

/**
 * Encrypt a secret for storage.
 * @param {string} plain
 * @returns {Promise<{v: number, iv: string, ct: string}>}
 */
export async function sealSecret(plain) {
  const key = await sealingKey({ create: true });
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plain));
  return { v: SEAL_VERSION, iv: toBase64(iv), ct: toBase64(ct) };
}

/**
 * Decrypt a sealed secret.
 * @returns {Promise<string|null>} null when there is nothing usable (no blob, or the sealing
 *   key is gone - e.g. the browser cleared the extension's site data - so the key must be re-entered)
 */
export async function openSecret(sealed) {
  if (!sealed || sealed.v !== SEAL_VERSION) return null;
  try {
    const key = await sealingKey({ create: false });
    if (!key) return null;
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(sealed.iv) }, key, fromBase64(sealed.ct));
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

/** Forget the sealing key (used when all local data is cleared). */
export async function destroySealingKey() {
  try {
    await keyStorage.delete();
  } catch {
    // nothing to delete / IndexedDB unavailable
  }
}
