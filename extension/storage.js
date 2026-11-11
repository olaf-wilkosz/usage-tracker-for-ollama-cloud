/**
 * Read from chrome.storage.local. Everything in there was written by this extension, so the
 * values are typed loosely here instead of declaring every stored shape twice.
 * @param {string|string[]|null} keys
 * @returns {Promise<Record<string, any>>}
 */
export function readLocal(keys) {
  return chrome.storage.local.get(keys);
}
