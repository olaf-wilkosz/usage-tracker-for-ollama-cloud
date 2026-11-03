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
 * Copy the sanitised page snapshot saved by the last refresh (see parse-usage.js
 * buildDiagnostics) to the clipboard, so an unrecognised layout can be shared and fixed.
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function copyDiagnostics() {
  try {
    const { ollamaDiagnostics } = await chrome.storage.local.get('ollamaDiagnostics');
    if (!ollamaDiagnostics?.html) {
      return { success: false, error: 'No snapshot yet - refresh first' };
    }
    await writeClipboard(ollamaDiagnostics.html);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
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
