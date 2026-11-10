/**
 * Options page logic for Usage Tracker for Ollama Cloud.
 * Handles settings persistence and communication with background script.
 */

import {
  DEFAULT_SETTINGS, migrateSettings, loadSettings, saveSettings, clearAllData, validateSettings, copyDiagnostics,
  sendTestNotification, isConnected, isPinnedToToolbar, showInlineStatus, testNotificationMessage, describeBuild, saveApiKey, removeApiKey
} from './settings.js';

// DOM elements
const elements = {
  connectedPill: document.getElementById('connectedPill'),
  connectIntro: document.getElementById('connectIntro'),
  connectSteps: document.getElementById('connectSteps'),
  apiKeyLabel: document.getElementById('apiKeyLabel'),
  apiKeyInput: document.getElementById('apiKeyInput'),
  saveKeyBtn: document.getElementById('saveKeyBtn'),
  removeKeyBtn: document.getElementById('removeKeyBtn'),
  keyStatus: document.getElementById('keyStatus'),
  version: document.getElementById('version'),
  pageTitle: document.getElementById('pageTitle'),
  pageSubtitle: document.getElementById('pageSubtitle'),
  doneNotice: document.getElementById('doneNotice'),
  pinTip: document.getElementById('pinTip'),
  refreshInterval: document.getElementById('refreshInterval'),
  notifyWarning: document.getElementById('notifyWarning'),
  notifyCritical: document.getElementById('notifyCritical'),
  lowCreditsUsd: document.getElementById('lowCreditsUsd'),
  buildInfo: document.getElementById('buildInfo'),
  notifyEnabled: document.getElementById('notifyEnabled'),
  showPeakBanner: document.getElementById('showPeakBanner'),
  testNotifyBtn: document.getElementById('testNotifyBtn'),
  testNotifyStatus: document.getElementById('testNotifyStatus'),
  diagnosticsBtn: document.getElementById('diagnosticsBtn'),
  diagnosticsStatus: document.getElementById('diagnosticsStatus'),
  clearDataBtn: document.getElementById('clearDataBtn'),
  clearStatus: document.getElementById('clearStatus'),
  saveBtn: document.getElementById('saveBtn')
};

/**
 * Populate form with settings
 */
function populateForm(settings) {
  elements.refreshInterval.value = String(settings.refreshIntervalMinutes);
  elements.notifyWarning.value = String(settings.notifyWarning);
  elements.notifyCritical.value = String(settings.notifyCritical);
  elements.lowCreditsUsd.value = String(settings.lowCreditsUsd);
  elements.notifyEnabled.checked = settings.notifyEnabled;
  elements.showPeakBanner.checked = settings.showPeakBanner;
}

/**
 * Collect settings from form
 */
function collectSettings() {
  return {
    refreshIntervalMinutes: parseInt(elements.refreshInterval.value, 10),
    notifyWarning: parseInt(elements.notifyWarning.value, 10),
    notifyCritical: parseInt(elements.notifyCritical.value, 10),
    lowCreditsUsd: parseFloat(elements.lowCreditsUsd.value),
    notifyEnabled: elements.notifyEnabled.checked,
    showPeakBanner: elements.showPeakBanner.checked
  };
}

/**
 * Show save status on button
 */
function showSaveStatus(message, isSuccess) {
  const originalText = elements.saveBtn.textContent;
  elements.saveBtn.textContent = message;
  elements.saveBtn.style.background = isSuccess ? '#388e3c' : '#d32f2f';

  setTimeout(() => {
    elements.saveBtn.textContent = originalText;
    elements.saveBtn.style.background = '';
  }, 2000);
}

/**
 * Switch the account section between first-time setup and "connected" (replace / remove).
 */
async function syncKeyState() {
  const connected = await isConnected();
  elements.connectedPill.hidden = !connected;
  elements.connectIntro.hidden = connected;
  elements.connectSteps.hidden = connected;
  elements.removeKeyBtn.hidden = !connected;
  elements.apiKeyLabel.textContent = connected ? 'Replace API key' : 'API key';
  elements.apiKeyInput.placeholder = connected ? 'Paste a new key to replace the current one' : 'Paste your Ollama API key';
  elements.saveKeyBtn.textContent = connected ? 'Replace' : 'Connect';

  // Not connected yet: a welcome page with the connect step only; the settings appear once it works
  document.body.classList.toggle('setup-only', !connected);
  elements.pageTitle.textContent = connected ? 'Options' : 'Welcome';
  elements.pageSubtitle.textContent = connected ? 'Configure Usage Tracker for Ollama Cloud' : 'Connect your Ollama account to start tracking your usage';
}

/** After a successful connect: say what happens next, and hint at pinning if the extension is not pinned. */
async function showDoneNotice() {
  elements.pinTip.hidden = (await isPinnedToToolbar()) !== false;
  elements.doneNotice.hidden = false;
  elements.doneNotice.scrollIntoView({ block: 'nearest' });
}

/**
 * Initialize options page
 */
async function init() {
  elements.version.textContent = chrome.runtime.getManifest().version;
  elements.buildInfo.textContent = await describeBuild();
  await syncKeyState();

  elements.saveKeyBtn.addEventListener('click', async () => {
    elements.saveKeyBtn.disabled = true;
    elements.saveKeyBtn.textContent = 'Checking...';
    const result = await saveApiKey(elements.apiKeyInput.value);
    elements.saveKeyBtn.disabled = false;

    if (result.success) {
      elements.apiKeyInput.value = ''; // the key is never shown again
      elements.keyStatus.hidden = true;
      await syncKeyState();
      await showDoneNotice();
    } else {
      showInlineStatus(elements.keyStatus, result.error, false, 8000);
      await syncKeyState();
    }
  });
  elements.apiKeyInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') elements.saveKeyBtn.click();
  });

  elements.removeKeyBtn.addEventListener('click', async () => {
    if (!confirm('Remove the API key from this browser? Tracking stops until you connect again. (The key itself stays valid at ollama.com until you revoke it there.)')) {
      return;
    }
    const result = await removeApiKey();
    showInlineStatus(elements.keyStatus, result.success ? 'Key removed.' : `Failed: ${result.error}`, result.success);
    await syncKeyState();
  });

  // Load and populate settings
  const settings = await loadSettings();
  populateForm(settings);

  // Save button handler
  elements.saveBtn.addEventListener('click', async () => {
    const settings = collectSettings();
    const errors = validateSettings(settings);

    if (errors.length > 0) {
      showSaveStatus(errors[0], false);
      return;
    }

    elements.saveBtn.disabled = true;
    const result = await saveSettings(settings);
    elements.saveBtn.disabled = false;

    if (result.success) {
      showSaveStatus('Saved!', true);
    } else {
      showSaveStatus(`Failed: ${result.error}`, false);
    }
  });

  // Test notification handler
  elements.testNotifyBtn.addEventListener('click', async () => {
    const result = await sendTestNotification();
    showInlineStatus(elements.testNotifyStatus, testNotificationMessage(result), result.success, 10000);
  });

  // Copy diagnostics handler
  elements.diagnosticsBtn.addEventListener('click', async () => {
    const result = await copyDiagnostics();
    showInlineStatus(
      elements.diagnosticsStatus,
      result.success
        ? 'Copied. It may include account details – review before sharing.'
        : `Failed: ${result.error}`,
      result.success,
      6000
    );
  });

  // Clear data button handler
  elements.clearDataBtn.addEventListener('click', async () => {
    if (!confirm('This will clear all locally stored usage data. Continue?')) {
      return;
    }

    elements.clearDataBtn.disabled = true;
    elements.clearDataBtn.textContent = 'Clearing...';

    const result = await clearAllData();

    elements.clearDataBtn.disabled = false;
    elements.clearDataBtn.textContent = 'Clear All Local Data';

    if (result.success) {
      showInlineStatus(elements.clearStatus, 'All local data cleared successfully', true);
    } else {
      showInlineStatus(elements.clearStatus, `Failed: ${result.error}`, false);
    }
  });

  // Listen for storage changes (in case settings changed from elsewhere)
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) {
      populateForm(migrateSettings(changes.settings.newValue || DEFAULT_SETTINGS));
    }
  });
}

// Start
init();
