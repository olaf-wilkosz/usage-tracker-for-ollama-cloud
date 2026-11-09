/**
 * Shared settings persistence logic, used by the background worker, the in-popup settings
 * panel (popup.js) and the standalone options page (options.js) so the entry points can't
 * drift apart. This module is the single source of truth for defaults and migrations.
 */

export const DEFAULT_SETTINGS = {
  refreshIntervalMinutes: 5,
  notifyWarning: 80,
  notifyCritical: 95,
  notifyEnabled: true,
  showPeakBanner: true
};

/**
 * Merge stored settings over the defaults, carrying over the v1.0 thresholds
 * (session -> warning, weekly -> critical) when the new keys aren't stored yet.
 * @param {Object|undefined} stored
 * @returns {typeof DEFAULT_SETTINGS}
 */
export function migrateSettings(stored) {
  const raw = stored || {};
  const migrated = { ...DEFAULT_SETTINGS, ...raw };

  if (raw.notifyWarning === undefined && typeof raw.notifyThresholdSession === 'number') {
    migrated.notifyWarning = raw.notifyThresholdSession;
  }
  if (raw.notifyCritical === undefined && typeof raw.notifyThresholdWeekly === 'number') {
    migrated.notifyCritical = raw.notifyThresholdWeekly;
  }
  delete migrated.notifyThresholdSession;
  delete migrated.notifyThresholdWeekly;
  return migrated;
}

/**
 * Load settings from background script
 */
export async function loadSettings() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, (response) => {
      if (chrome.runtime.lastError) {
        console.error('[settings] Error loading settings:', chrome.runtime.lastError);
        resolve(DEFAULT_SETTINGS);
      } else {
        resolve(migrateSettings(response?.settings));
      }
    });
  });
}

/**
 * Save settings to background script
 */
export async function saveSettings(settings) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings }, (response) => {
      if (chrome.runtime.lastError) {
        console.error('[settings] Error saving settings:', chrome.runtime.lastError);
        resolve({ success: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(response || { success: false, error: 'No response' });
      }
    });
  });
}

/** What to tell the user after "Send test" (shared by the popup and the options page). */
export function testNotificationMessage(result) {
  return result.success
    ? 'Sent. Nothing showed up? Check Do Not Disturb / Focus Assist, then the notification settings of your operating system for this browser (Windows: Settings > System > Notifications).'
    : `Not sent: ${result.error}.`;
}

/**
 * Ask the background worker to show a sample notification
 * @returns {Promise<{success: boolean, level?: string, error?: string}>}
 */
export async function sendTestNotification() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'TEST_NOTIFICATION' }, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ success: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(response || { success: false, error: 'No response' });
      }
    });
  });
}

/**
 * Clear all local data
 */
export async function clearAllData() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'CLEAR_DATA' }, (response) => {
      if (chrome.runtime.lastError) {
        console.error('[settings] Error clearing data:', chrome.runtime.lastError);
        resolve({ success: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(response || { success: false, error: 'No response' });
      }
    });
  });
}

/**
 * Write text to the clipboard (must run inside a click handler). Falls back to the legacy
 * execCommand path when the async Clipboard API is refused.
 */
async function writeClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // fall through to the legacy path
  }

  const area = document.createElement('textarea');
  area.value = text;
  area.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
  document.body.appendChild(area);
  area.select();
  const copied = document.execCommand('copy');
  area.remove();
  if (!copied) throw new Error('Clipboard access was denied');
}

/**
 * Copy the raw Ollama API responses saved by the last successful read to the clipboard, so
 * an unexpected response can be shared and fixed. They contain usage numbers and model names
 * only - never the API key.
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function copyDiagnostics() {
  try {
    const { ollamaDiagnostics } = await chrome.storage.local.get('ollamaDiagnostics');
    if (!ollamaDiagnostics?.text) {
      return { success: false, error: 'No data yet - connect your API key and refresh first' };
    }
    await writeClipboard(ollamaDiagnostics.text);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

function sendToWorker(message, fallbackError) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ success: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(response || { success: false, error: fallbackError });
      }
    });
  });
}

/**
 * A usable key: one is stored and Ollama has not rejected it ("no_key" also covers a stored
 * key whose sealing key was lost).
 * @param {{hasKey?: boolean, status?: string|null}} [state] - the worker's GET_KEY_STATE answer
 */
export function deriveConnected({ hasKey, status } = {}) {
  return Boolean(hasKey) && status !== 'auth_required' && status !== 'no_key';
}

/** Whether the extension is connected with a working key (the key itself is never readable from the pages). */
export async function isConnected() {
  return deriveConnected(await sendToWorker({ type: 'GET_KEY_STATE' }, 'No response'));
}

/**
 * Whether the extension is pinned to the toolbar: true / false when the browser can tell,
 * null when it cannot (older browsers, missing API).
 */
export async function isPinnedToToolbar() {
  try {
    const settings = await chrome.action?.getUserSettings?.();
    return typeof settings?.isOnToolbar === 'boolean' ? settings.isOnToolbar : null;
  } catch {
    return null;
  }
}

/** Show a message under a button for a few seconds (the page needs a .clear-status element). */
export function showInlineStatus(node, message, isSuccess, hideAfterMs = 3000) {
  node.textContent = message;
  node.className = `clear-status ${isSuccess ? 'success' : 'error'}`;
  node.hidden = false;

  setTimeout(() => {
    node.hidden = true;
  }, hideAfterMs);
}

/**
 * Hand a pasted API key to the background worker, which checks it with Ollama and stores it sealed.
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export function saveApiKey(key) {
  return sendToWorker({ type: 'SAVE_API_KEY', key }, 'No response');
}

/** Forget the stored API key and the data read with it. */
export function removeApiKey() {
  return sendToWorker({ type: 'REMOVE_API_KEY' }, 'No response');
}

/**
 * Validate settings, returning an array of human-readable error messages (empty if valid)
 */
export function validateSettings(settings) {
  const errors = [];

  if (!(settings.refreshIntervalMinutes >= 1)) {
    errors.push('Refresh interval must be at least 1 minute');
  }
  if (!(settings.notifyWarning >= 1 && settings.notifyWarning <= 100)) {
    errors.push('Warning threshold must be between 1 and 100');
  }
  if (!(settings.notifyCritical >= 1 && settings.notifyCritical <= 100)) {
    errors.push('Critical threshold must be between 1 and 100');
  }
  if (errors.length === 0 && settings.notifyWarning > settings.notifyCritical) {
    errors.push('Warning threshold must not exceed critical');
  }

  return errors;
}
