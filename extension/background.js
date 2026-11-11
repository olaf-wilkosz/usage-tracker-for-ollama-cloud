/**
 * Background service worker for Usage Tracker for Ollama Cloud.
 * Periodically reads the user's usage from the official Ollama API (ollama-api.js) with the
 * API key they provided, stores it, draws the toolbar icon, keeps the activity history and
 * sends notifications.
 */

import {
  getBadgeColor, getBadgeStyle, getCreditsBadgeStyle, creditsInUse, creditsRelevant, formatBadgeAmount, formatRunway, formatUsd, emptyUsage
} from './usage.js';
import { apiGet, fetchApiData, buildUsage, extractActivity, statusForError } from './ollama-api.js';
import { sealSecret, openSecret, destroySealingKey } from './secret-store.js';
import { DEFAULT_SETTINGS, migrateSettings } from './settings.js';
import { mergeActivity } from './activity.js';

const STORAGE_KEY = 'ollamaUsageData';
const DIAGNOSTICS_KEY = 'ollamaDiagnostics'; // last raw API responses, for "Copy diagnostics"
const ACTIVITY_KEY = 'ollamaActivity'; // hourly + daily request counts for the popup heatmap
const NOTIFIED_KEY = 'ollamaNotified'; // per-meter notification state (no repeat alerts)
const ERROR_COUNT_KEY = 'ollamaErrorCount'; // persisted: the service worker is restarted between alarms
const API_KEY_KEY = 'ollamaApiKey'; // the API key, sealed (see secret-store.js)
const CREDITS_STATE_KEY = 'ollamaCreditsState'; // { level, hadCredits }: only a drop notifies; "ran out" needs "had some"
const MONTH_CACHE_KEY = 'ollamaMonthCache'; // last 30-day response, reused for MONTH_CACHE_MS
const BACKOFF_KEY = 'ollamaBackoffUntil'; // epoch ms: after a 429 no request is made before this
const ALARM_NAME = 'ollamaUsageRefresh';
const DEFAULT_ICON_PATHS = { 16: 'icons/icon16.png', 32: 'icons/icon32.png', 48: 'icons/icon48.png', 128: 'icons/icon128.png' };
const DEFAULT_TITLE = 'Usage Tracker for Ollama Cloud';

const MONTH_CACHE_MS = 10 * 60 * 1000;
const MAX_BACKOFF_MS = 10 * 60 * 1000;
const MAX_CONSECUTIVE_ERRORS = 3;
const MAX_ICON_RINGS = 3;
const ICON_BACKGROUND = '#1a1b1e';
const SETUP_BADGE_COLOR = '#f57c00';
const SETUP_BADGE_TEXT = '#1a1a1a'; // white on orange is below 4.5:1
const LEVEL_RANK = { warning: 1, critical: 2 };
// Failures that should not blank the popup: keep showing the last good numbers, flagged stale
const TRANSIENT_STATUSES = new Set(['network_error', 'rate_limited', 'api_error']);
// Statuses where the user has to (re)connect an API key
const NEEDS_KEY_STATUSES = new Set(['no_key', 'auth_required']);

let refreshInFlight = null;
let keyEpoch = 0; // bumped whenever the API key is saved or removed; a refresh that spans a change is discarded

/**
 * Get current settings from storage
 */
async function getSettings() {
  const result = await chrome.storage.local.get('settings');
  return migrateSettings(result.settings);
}

/**
 * Save settings to storage
 */
async function saveSettings(settings) {
  await chrome.storage.local.set({ settings: migrateSettings(settings) });
}

async function loadApiKey() {
  const stored = await chrome.storage.local.get(API_KEY_KEY);
  return openSecret(stored[API_KEY_KEY]);
}

/**
 * Read everything from the Ollama API and turn it into usage data.
 * @returns {Promise<{data: Object, raw?: Object}>} raw API responses when they were received
 */
async function collectUsage() {
  const key = await loadApiKey();
  if (!key) return { data: emptyUsage('no_key') };

  const stored = await chrome.storage.local.get([BACKOFF_KEY, MONTH_CACHE_KEY]);
  const now = Date.now();
  if (stored[BACKOFF_KEY] > now) {
    // Ollama asked us to wait (429 Retry-After): no request until then
    return { data: { ...emptyUsage('rate_limited'), lastFetch: new Date().toISOString() } };
  }
  const cache = stored[MONTH_CACHE_KEY];
  const cachedMonth = cache && now - cache.at < MONTH_CACHE_MS ? cache.month : undefined;

  let raw;
  try {
    raw = await fetchApiData(key, cachedMonth);
    const usage = buildUsage(raw); // validates the response before anything is cached
    if (!cachedMonth) await chrome.storage.local.set({ [MONTH_CACHE_KEY]: { at: now, month: raw.month } });
    return { data: { ...usage, lastFetch: new Date().toISOString() }, raw };
  } catch (error) {
    // Details stay out of the log: errors here carry no key, but keep the console quiet anyway
    console.warn('[background] Refresh failed:', error?.kind || 'unknown', error?.message);
    if (error?.kind === 'rate_limited') {
      await chrome.storage.local.set({ [BACKOFF_KEY]: now + Math.min(error.retryAfter * 1000, MAX_BACKOFF_MS) });
    }
    return { data: { ...emptyUsage(statusForError(error)), lastFetch: new Date().toISOString() }, raw };
  }
}

/**
 * Draw the toolbar icon at the given pixel size.
 * One usage window -> a single chunky ring (its percentage goes in the browser's own badge,
 * see updateBadge - digits drawn inside a 16px icon were unreadable); two or more (e.g.
 * legacy session + weekly plans) -> concentric rings, outermost first. Drawing happens on an
 * OffscreenCanvas.
 * @param {number} size - icon size in pixels (e.g. 16, 32)
 * @param {Array<{usedPercent: number}>} meters - meters that have a percentage
 * @returns {ImageData}
 */
function drawUsageIcon(size, meters) {
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, size, size);

  const center = size / 2;
  const startAngle = -Math.PI / 2;

  function drawRing(radius, lineWidth, percent) {
    if (radius <= 0) return;

    // Background track - kept faint so the colored, filled arc reads clearly against it
    ctx.beginPath();
    ctx.arc(center, center, radius, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
    ctx.lineWidth = lineWidth;
    ctx.stroke();

    const clamped = Math.max(0, Math.min(100, percent));
    if (clamped <= 0) return;

    ctx.beginPath();
    ctx.arc(center, center, radius, startAngle, startAngle + (clamped / 100) * Math.PI * 2);
    ctx.strokeStyle = getBadgeColor(clamped);
    ctx.lineWidth = lineWidth;
    ctx.lineCap = 'round';
    ctx.stroke();
  }

  if (meters.length === 1) {
    const percent = Math.max(0, Math.min(100, meters[0].usedPercent));

    // Full-size, chunky ring: the browser's badge covers only the bottom-right corner, and
    // a ring shrunk to dodge it turned out too small to read (tried in v1.1.0 testing).
    const lineWidth = Math.max(3, size * 0.22);

    // Dark disc behind the ring so it reads on light and dark toolbars alike
    ctx.beginPath();
    ctx.arc(center, center, center - 0.5, 0, Math.PI * 2);
    ctx.fillStyle = ICON_BACKGROUND;
    ctx.fill();

    drawRing(center - lineWidth / 2 - 0.5, lineWidth, percent);
  } else {
    const lineWidth = Math.max(2, size * 0.16);
    const gap = Math.max(1, size * 0.05);
    let radius = center - lineWidth;
    for (const meter of meters.slice(0, MAX_ICON_RINGS)) {
      drawRing(radius, lineWidth, meter.usedPercent);
      radius -= lineWidth + gap;
    }
  }

  return ctx.getImageData(0, 0, size, size);
}

/**
 * Update the toolbar icon and tooltip based on usage data
 */
async function updateBadge(data, settings = DEFAULT_SETTINGS, creditsInfo = null) {
  if (NEEDS_KEY_STATUSES.has(data.status)) {
    // Nudge towards setup: "!" badge and a tooltip that says what to do
    await chrome.action.setIcon({ path: DEFAULT_ICON_PATHS });
    await chrome.action.setBadgeBackgroundColor({ color: SETUP_BADGE_COLOR });
    await chrome.action.setBadgeTextColor({ color: SETUP_BADGE_TEXT });
    await chrome.action.setBadgeText({ text: '!' });
    await chrome.action.setTitle({
      title: `${DEFAULT_TITLE}\n${data.status === 'no_key' ? 'Click to connect your Ollama account' : 'Ollama rejected the API key - click to fix'}`
    });
    return;
  }

  const withPercent = (data.meters || []).filter((m) => m.usedPercent !== null && m.usedPercent !== undefined);
  const creditsLine = creditsRelevant(data.credits, data.meters || []) ? `Credits: ${data.credits.text}` : null;

  if (withPercent.length === 0) {
    // No percentage to draw: no data yet, a persistent error, or an account without included
    // usage (pay as you go), where the credits balance is the number that matters
    await chrome.action.setIcon({ path: DEFAULT_ICON_PATHS });
    if (creditsInfo) {
      const style = getCreditsBadgeStyle({
        amount: data.credits.amount,
        runwayDays: data.credits.runwayDays ?? null,
        lowDays: settings.lowCreditsDays,
        hadCredits: creditsInfo.hadCredits
      });
      await chrome.action.setBadgeBackgroundColor({ color: style.color });
      await chrome.action.setBadgeTextColor({ color: style.textColor });
      await chrome.action.setBadgeText({ text: formatBadgeAmount(data.credits.amount) });
    } else {
      await chrome.action.setBadgeText({ text: '' });
    }
    await chrome.action.setTitle({ title: [DEFAULT_TITLE, creditsLine].filter(Boolean).join('\n') });
    return;
  }

  await chrome.action.setIcon({
    imageData: {
      16: drawUsageIcon(16, withPercent),
      32: drawUsageIcon(32, withPercent)
    }
  });

  // A single window shows its percentage in the badge (bottom-right counter, like Gmail's);
  // several windows are already visible as rings, so the badge stays empty.
  if (withPercent.length === 1) {
    const percent = withPercent[0].usedPercent;
    const style = getBadgeStyle(percent);
    await chrome.action.setBadgeBackgroundColor({ color: style.color });
    await chrome.action.setBadgeTextColor({ color: style.textColor });
    await chrome.action.setBadgeText({ text: String(Math.round(percent)) });
  } else {
    await chrome.action.setBadgeText({ text: '' });
  }

  const lines = withPercent.map((m) => `${m.label}: ${m.usedPercent.toFixed(1)}%`);
  await chrome.action.setTitle({ title: [DEFAULT_TITLE, ...lines, creditsLine].filter(Boolean).join('\n') });
}

/**
 * Notify once per usage window and cycle when it crosses the warning / critical threshold
 * (again only if it later escalates from warning to critical or the window resets).
 */
async function checkThresholdNotifications(data, settings) {
  const stored = (await chrome.storage.local.get(NOTIFIED_KEY))[NOTIFIED_KEY] || {};
  const notified = {}; // rebuilt every run: windows back under the threshold get alerts again later

  if (settings.notifyEnabled) {
    for (const meter of data.meters || []) {
      const percent = meter.usedPercent;
      if (percent === null || percent === undefined) continue;

      const level = percent >= settings.notifyCritical ? 'critical'
        : percent >= settings.notifyWarning ? 'warning'
        : null;
      if (!level) continue;

      const cycle = meter.resetsAt || '';
      const previous = stored[meter.id];
      const alreadyNotified = previous && previous.cycle === cycle && LEVEL_RANK[previous.level] >= LEVEL_RANK[level];

      notified[meter.id] = { cycle, level: alreadyNotified ? previous.level : level };
      if (alreadyNotified) continue;

      const threshold = level === 'critical' ? settings.notifyCritical : settings.notifyWarning;
      await showNotification(`ollama-usage-${meter.id}`, {
        type: 'basic',
        iconUrl: 'icons/icon48.png',
        title: level === 'critical' ? 'Ollama Cloud Usage Critical' : 'Ollama Cloud Usage Alert',
        message: `${meter.label} at ${Math.round(percent)}% (${level} threshold: ${threshold}%)`,
        priority: level === 'critical' ? 2 : 1
      });
    }
  }

  await chrome.storage.local.set({ [NOTIFIED_KEY]: notified });
}

/**
 * Pay as you go: where the purchased credits stand. "low" = they last the configured number of
 * days or less at the recent pace, "empty" = nothing left. Only fresh readings are recorded.
 * @returns {Promise<{level: string|null, hadCredits: boolean, previous: Object|null}|null>}
 *   null while included usage is left (the purchased credits are not touched yet, and the
 *   percentage alerts cover that) or when there is no credits information
 */
async function trackCredits(data, settings) {
  const meters = data.meters || [];
  if (!data.credits || !creditsInUse(meters)) return null;
  const stored = (await chrome.storage.local.get(CREDITS_STATE_KEY))[CREDITS_STATE_KEY];
  const { amount, runwayDays } = data.credits;
  const low = settings.lowCreditsDays;
  const hadCredits = Boolean(stored?.hadCredits) || amount > 0;
  let level = amount <= 0 ? 'empty' : low > 0 && runwayDays !== undefined && runwayDays <= low ? 'low' : null;
  // Included usage is spent and nothing was ever bought: the usage alert already said it, and
  // "your purchased credits are used up" would be wrong
  if (level === 'empty' && meters.length > 0 && !hadCredits) level = null;
  const state = { level, hadCredits };
  if (data.status === 'ok') await chrome.storage.local.set({ [CREDITS_STATE_KEY]: state });
  return { ...state, previous: stored ?? null };
}

const CREDIT_LEVEL_RANK = { low: 1, empty: 2 };

/**
 * Notify when the credits get worse (ok -> low -> empty), once per step. The first reading only
 * records the state, so an account that starts at $0 is not news, and a level that was already
 * reported is not repeated until the balance has been better again.
 */
async function notifyCredits(data, settings, info) {
  if (!info || !info.level || !info.previous || !settings.notifyEnabled) return;
  if (CREDIT_LEVEL_RANK[info.level] <= (CREDIT_LEVEL_RANK[info.previous.level] ?? 0)) return;

  const { text, runwayDays, perDay } = data.credits;
  await showNotification('ollama-usage-credits', {
    type: 'basic',
    iconUrl: 'icons/icon48.png',
    title: info.level === 'empty' ? 'Ollama credits used up' : 'Ollama credits running low',
    message: info.level === 'empty'
      ? 'Your purchased credits are used up. Add credits to keep using cloud models.'
      : `${text} left: about ${formatRunway(runwayDays)} at ${formatUsd(perDay)}/day.`,
    priority: info.level === 'empty' ? 2 : 1
  });
}

/**
 * Show a sample notification (settings -> "Send test"), so the user can check that
 * notifications actually reach them. The "notifications" permission is granted at install,
 * so there is no prompt - but the browser/OS can still block them per extension, which
 * getPermissionLevel reports. Ignores the "Enable notifications" switch on purpose.
 * @returns {Promise<{success: boolean, level: string, error?: string}>}
 */
/**
 * Show a notification. A notification that was already shown under the same id is cleared
 * first: Windows can update such a toast in place without popping it up again, so a repeated
 * alert (or a second click on "Send test") would otherwise look as if nothing happened.
 */
async function showNotification(id, options) {
  await chrome.notifications.clear(id);
  await chrome.notifications.create(id, options);
}

let lastTestNotificationId = null;

async function sendTestNotification() {
  // Firefox has no getPermissionLevel; there a blocked notification is simply not shown
  const level = chrome.notifications.getPermissionLevel ? await chrome.notifications.getPermissionLevel() : 'granted';
  if (level !== 'granted') {
    return { success: false, level, error: 'Notifications are blocked for this extension in the browser settings' };
  }
  // A fresh id per click: every test is a new toast, and the previous one is removed
  if (lastTestNotificationId) await chrome.notifications.clear(lastTestNotificationId);
  lastTestNotificationId = `ollama-usage-test-${Date.now()}`;
  await chrome.notifications.create(lastTestNotificationId, {
    type: 'basic',
    iconUrl: 'icons/icon48.png',
    title: 'Usage Tracker for Ollama Cloud',
    message: 'Notifications work. You will be alerted when usage crosses your thresholds.',
    priority: 1
  });
  return { success: true, level };
}

// What to tell the user once a failure has persisted; statuses missing here stay silent
const PERSISTENT_ERROR_MESSAGES = {
  auth_required: 'Ollama rejected your API key. Open the extension settings and paste a new one.',
  forbidden: 'Ollama says your account is suspended or access is denied.',
  api_error: 'The Ollama API returned something unexpected. Open the extension settings and use "Copy diagnostics" to report it.',
  network_error: 'Could not reach the Ollama API. Check your connection.'
};

/**
 * Check for persistent errors and notify user
 */
async function checkPersistentErrors(data, settings) {
  const stored = await chrome.storage.local.get(ERROR_COUNT_KEY);
  let errors = stored[ERROR_COUNT_KEY] || 0;

  if (data.status === 'no_key') {
    // Not set up yet is not an error
    errors = 0;
  } else if (data.status !== 'ok') {
    errors++;
    const message = PERSISTENT_ERROR_MESSAGES[data.status];
    if (errors === MAX_CONSECUTIVE_ERRORS && settings.notifyEnabled && message) {
      await showNotification('ollama-usage-persistent-error', {
        type: 'basic',
        iconUrl: 'icons/icon48.png',
        title: 'Usage Tracker for Ollama Cloud: problem',
        message,
        priority: 2
      });
    }
  } else {
    errors = 0;
    // Clear persistent error notification if it exists
    await chrome.notifications.clear('ollama-usage-persistent-error');
  }

  await chrome.storage.local.set({ [ERROR_COUNT_KEY]: errors });
}

/**
 * Main refresh function - called by alarm. Concurrent calls (alarm + manual refresh) share
 * one run so the API is only asked once.
 */
function refreshUsage() {
  if (!refreshInFlight) {
    refreshInFlight = doRefresh().finally(() => { refreshInFlight = null; });
  }
  return refreshInFlight;
}

async function doRefresh() {
  console.log('[background] Refreshing usage data...');

  const epoch = keyEpoch;
  const collected = await collectUsage();
  // The key was saved or removed while this read was running: what it read belongs to the old key
  if (epoch !== keyEpoch) return doRefresh();
  let { data } = collected;
  const { raw } = collected;

  const previous = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
  if (TRANSIENT_STATUSES.has(data.status) && previous?.meters) {
    // A hiccup (offline, rate limit, odd response): keep the last good numbers on screen
    data = { ...previous, status: data.status, stale: true };
  }

  const toStore = { [STORAGE_KEY]: data };
  if (raw) toStore[DIAGNOSTICS_KEY] = { text: JSON.stringify({ at: data.lastFetch, status: data.status, ...raw }), at: data.lastFetch };
  await chrome.storage.local.set(toStore);

  const settings = await getSettings();
  const creditsInfo = await trackCredits(data, settings);
  await updateBadge(data, settings, creditsInfo);

  if (data.status === 'ok') {
    const stored = (await chrome.storage.local.get(ACTIVITY_KEY))[ACTIVITY_KEY];
    await chrome.storage.local.set({ [ACTIVITY_KEY]: mergeActivity(stored, extractActivity(raw)) });
    await checkThresholdNotifications(data, settings);
    await notifyCredits(data, settings, creditsInfo);
  }
  await checkPersistentErrors(data, settings);

  console.log('[background] Refresh complete:', data.status);
}

/**
 * Validate a pasted API key against Ollama, then keep it sealed. The key never leaves this
 * worker: it is not echoed back, logged or stored in the clear.
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function saveApiKey(rawKey) {
  const key = String(rawKey ?? '').trim();
  if (!/^[\x21-\x7e]{8,512}$/.test(key)) {
    return { success: false, error: 'That does not look like an API key - paste the whole key without spaces.' };
  }

  try {
    await apiGet('/balance', key);
  } catch (error) {
    return {
      success: false,
      error: error.kind === 'auth' ? 'Ollama rejected this key. Check that you copied all of it.' : `Could not check the key: ${error.message}`
    };
  }

  await chrome.storage.local.remove([MONTH_CACHE_KEY, BACKOFF_KEY]);
  await chrome.storage.local.set({ [API_KEY_KEY]: await sealSecret(key), [ERROR_COUNT_KEY]: 0 });
  keyEpoch++;
  await refreshUsage();
  return { success: true };
}

/** Forget the key and everything derived from it; the popup goes back to the setup prompt. */
async function removeApiKey() {
  await chrome.storage.local.remove([API_KEY_KEY, STORAGE_KEY, DIAGNOSTICS_KEY, NOTIFIED_KEY, CREDITS_STATE_KEY, ERROR_COUNT_KEY, MONTH_CACHE_KEY, BACKOFF_KEY]);
  await destroySealingKey();
  keyEpoch++;
  const data = { ...emptyUsage('no_key'), lastFetch: new Date().toISOString() };
  await chrome.storage.local.set({ [STORAGE_KEY]: data });
  await updateBadge(data);
}

/**
 * Initialize alarm with current settings
 */
async function initializeAlarm() {
  const settings = await getSettings();
  const intervalMinutes = Math.max(1, settings.refreshIntervalMinutes); // Minimum 1 minute

  await chrome.alarms.create(ALARM_NAME, {
    periodInMinutes: intervalMinutes
  });

  console.log(`[background] Alarm set to ${intervalMinutes} minute(s)`);
}

/**
 * Handle alarm events
 */
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_NAME) {
    await refreshUsage();
  }
});

/**
 * Handle messages from popup/options
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Only the extension's own pages may talk to the worker
  if (sender?.id && sender.id !== chrome.runtime.id) return false;

  if (message.type === 'GET_USAGE_DATA') {
    chrome.storage.local.get(STORAGE_KEY).then(result => {
      sendResponse({ data: result[STORAGE_KEY] || null });
    });
    return true; // Async response
  }

  if (message.type === 'FORCE_REFRESH') {
    refreshUsage().then(() => {
      sendResponse({ success: true });
    }).catch(error => {
      sendResponse({ success: false, error: error.message });
    });
    return true;
  }

  if (message.type === 'GET_SETTINGS') {
    getSettings().then(settings => {
      sendResponse({ settings });
    });
    return true;
  }

  if (message.type === 'SAVE_SETTINGS') {
    saveSettings(message.settings).then(() => {
      initializeAlarm(); // Re-create alarm with new interval
      sendResponse({ success: true });
    }).catch(error => {
      sendResponse({ success: false, error: error.message });
    });
    return true;
  }

  if (message.type === 'GET_KEY_STATE') {
    chrome.storage.local.get([API_KEY_KEY, STORAGE_KEY]).then((stored) => {
      // status lets the pages tell "a key is stored" from "a key that works"
      sendResponse({ hasKey: Boolean(stored[API_KEY_KEY]), status: stored[STORAGE_KEY]?.status ?? null });
    });
    return true;
  }

  if (message.type === 'SAVE_API_KEY') {
    saveApiKey(message.key).then(sendResponse).catch(() => {
      sendResponse({ success: false, error: 'Could not store the key' });
    });
    return true;
  }

  if (message.type === 'REMOVE_API_KEY') {
    removeApiKey().then(() => sendResponse({ success: true })).catch(error => {
      sendResponse({ success: false, error: error.message });
    });
    return true;
  }

  if (message.type === 'TEST_NOTIFICATION') {
    sendTestNotification().then(sendResponse).catch(error => {
      sendResponse({ success: false, error: error.message });
    });
    return true;
  }

  if (message.type === 'CLEAR_DATA') {
    chrome.storage.local.clear().then(async () => {
      await destroySealingKey();
      await chrome.action.setBadgeText({ text: '' });
      await chrome.action.setIcon({ path: DEFAULT_ICON_PATHS });
      await chrome.action.setTitle({ title: DEFAULT_TITLE });
      sendResponse({ success: true });
    }).catch(error => {
      sendResponse({ success: false, error: error.message });
    });
    return true;
  }
});

/**
 * First-run setup: the toolbar popup itself, which opens on the "paste your key" screen. That is
 * only done while a browser window has focus: a popup opened in an unfocused window never gets
 * the blur that closes it and stays on screen (seen with action.openPopup() in Brave). When the
 * browser cannot open it (Firefox needs a click) or nothing is focused, the options page opens as
 * a welcome tab, which closes itself once the key is connected.
 */
async function showSetup() {
  try {
    // getBrowserInfo exists only in Firefox, where the popup cannot be opened without a click (and
    // may resolve without showing anything, leaving no setup at all): go straight to the welcome tab
    const isFirefox = typeof chrome.runtime.getBrowserInfo === 'function';
    if (chrome.action.openPopup && !isFirefox) {
      const focused = await chrome.windows.getLastFocused();
      if (focused?.focused) {
        await chrome.action.openPopup({ windowId: focused.id });
        return;
      }
    }
  } catch {
    // not allowed here: use the welcome tab
  }
  chrome.runtime.openOptionsPage();
}

/**
 * Initialize on install/update
 */
chrome.runtime.onInstalled.addListener(async (details) => {
  console.log('[background] Extension installed/updated:', details.reason);

  // Shown in the settings, so a stale copy loaded in one browser is easy to tell from a fresh one
  await chrome.storage.local.set({ ollamaInstalledAt: new Date().toISOString() });

  // Set default settings, and migrate v1.0 threshold keys on update
  const existing = await chrome.storage.local.get('settings');
  await saveSettings(existing.settings || DEFAULT_SETTINGS);

  // Initialize alarm
  await initializeAlarm();

  // Do initial fetch (shows the "!" setup badge until an API key is saved)
  await refreshUsage();

  // First run: show the setup, unless a working key is already stored (a reinstall keeps the
  // extension's data, and there is nothing to set up then).
  if (details.reason === 'install') {
    const { [STORAGE_KEY]: usage } = await chrome.storage.local.get(STORAGE_KEY);
    if (!usage || NEEDS_KEY_STATUSES.has(usage.status)) await showSetup();
  }
});

/**
 * Handle startup
 */
chrome.runtime.onStartup.addListener(async () => {
  console.log('[background] Browser startup');
  await initializeAlarm();
  await refreshUsage();
});

console.log('[background] Service worker loaded');
