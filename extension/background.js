/**
 * Background service worker for Usage Tracker for Ollama Cloud.
 * Handles periodic fetching, parsing via offscreen document, storage, toolbar icon updates,
 * activity history and notifications.
 */

import { getBadgeColor, emptyUsage, pickModelsSource } from './parse-usage.js';
import { DEFAULT_SETTINGS, migrateSettings } from './settings.js';
import { hourKey, ACTIVITY_RETENTION_DAYS } from './activity.js';

const STORAGE_KEY = 'ollamaUsageData';
const DIAGNOSTICS_KEY = 'ollamaDiagnostics'; // sanitised page snapshot for "Copy diagnostics"
const ACTIVITY_KEY = 'ollamaActivity'; // hourly activity buckets for the popup heatmap
const NOTIFIED_KEY = 'ollamaNotified'; // per-meter notification state (no repeat alerts)
const ERROR_COUNT_KEY = 'ollamaErrorCount'; // persisted: the service worker is restarted between alarms
const COLORS_KEY = 'ollamaModelColors'; // model -> color, as ollama.com paints it
const MAX_LEARNED_COLORS = 200;
const ALARM_NAME = 'ollamaUsageRefresh';
const OFFSCREEN_DOCUMENT_PATH = '/offscreen.html';
const OLLAMA_SETTINGS_URL = 'https://ollama.com/settings';
const DEFAULT_ICON_PATHS = { 16: 'icons/icon16.png', 32: 'icons/icon32.png', 48: 'icons/icon48.png', 128: 'icons/icon128.png' };
const DEFAULT_TITLE = 'Usage Tracker for Ollama Cloud';

const MAX_CONSECUTIVE_ERRORS = 3;
const MAX_ICON_RINGS = 3;
const ICON_BACKGROUND = '#1a1b1e';
const LEVEL_RANK = { warning: 1, critical: 2 };

let offscreenDocumentCreated = false;
let refreshInFlight = null;

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

/**
 * Create offscreen document if not already created
 */
async function ensureOffscreenDocument() {
  if (offscreenDocumentCreated) return true;

  try {
    // Check if offscreen document already exists
    const existingContexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH)]
    });

    if (existingContexts.length > 0) {
      offscreenDocumentCreated = true;
      return true;
    }

    // Create offscreen document
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_DOCUMENT_PATH,
      reasons: ['DOM_PARSER'],
      justification: 'Parse Ollama settings page HTML to extract usage data'
    });

    offscreenDocumentCreated = true;
    // Give it a moment to load
    await new Promise(resolve => setTimeout(resolve, 100));
    return true;
  } catch (error) {
    console.error('[background] Failed to create offscreen document:', error);
    return false;
  }
}

/**
 * Parse HTML using offscreen document
 */
async function parseHtmlOffscreen(html) {
  const created = await ensureOffscreenDocument();
  if (!created) {
    throw new Error('Failed to create offscreen document');
  }

  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { type: 'PARSE_USAGE_HTML', html },
      response => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (response?.success) {
          resolve(response.data);
        } else {
          reject(new Error(response?.error || 'Unknown parse error'));
        }
      }
    );
  });
}

/**
 * Fetch Ollama settings page and parse usage data
 */
async function fetchAndParseUsage() {
  try {
    // redirect: 'manual' is required to detect auth_required reliably. An unauthenticated
    // /settings request gets a 303 redirect to the sign-in page, which itself lives on a
    // different origin (signin.ollama.com / formerly api.workos.com) - a plain fetch() would
    // either silently follow that cross-origin hop (landing on a login page with no usage
    // data, misreported as parse_error) or throw a CORS error (misreported as network_error),
    // since the extension's host_permissions only cover ollama.com. With 'manual' we stop at
    // the first hop and inspect it directly instead of following it cross-origin. Verified
    // against the real endpoint (logged out): Node's fetch surfaces this as
    // {status: 303, type: 'basic'} - since host_permissions grant unfiltered ("basic") access
    // to ollama.com the extension likely sees the real 3xx status the same way, but a
    // CORS-filtered 'opaqueredirect' (status 0) is checked too in case that assumption
    // doesn't hold in the extension context.
    const response = await fetch(OLLAMA_SETTINGS_URL, {
      credentials: 'include',
      redirect: 'manual',
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    });

    const isRedirect = response.type === 'opaqueredirect' || response.status === 0 ||
      (response.status >= 300 && response.status < 400);

    if (isRedirect || response.status === 401 || response.status === 403) {
      return { ...emptyUsage('auth_required'), lastFetch: new Date().toISOString() };
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const html = await response.text();
    const parsed = await parseHtmlOffscreen(html);

    return {
      ...parsed,
      lastFetch: new Date().toISOString()
    };
  } catch (error) {
    console.error('[background] Fetch/parse error:', error);
    return {
      ...emptyUsage(error.message.includes('offscreen') ? 'parse_error' : 'network_error'),
      lastFetch: new Date().toISOString()
    };
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
async function updateBadge(data) {
  const withPercent = (data.meters || []).filter((m) => m.usedPercent !== null && m.usedPercent !== undefined);
  const creditsLine = data.credits ? `Credits: ${data.credits.text}` : null;

  if (withPercent.length === 0) {
    // No percentage to draw (no data yet, persistent error, or a credits-only account)
    await chrome.action.setBadgeText({ text: '' });
    await chrome.action.setIcon({ path: DEFAULT_ICON_PATHS });
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
    await chrome.action.setBadgeBackgroundColor({ color: getBadgeColor(percent) });
    await chrome.action.setBadgeTextColor({ color: '#ffffff' });
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

      // An approximate reset time (parsed from "in 1 day" text) shifts on every fetch, so
      // it can't identify a cycle - fall back to escalation-only de-duplication there.
      const cycle = meter.resetsAtApprox ? '' : (meter.resetsAt || '');
      const previous = stored[meter.id];
      const alreadyNotified = previous && previous.cycle === cycle && LEVEL_RANK[previous.level] >= LEVEL_RANK[level];

      notified[meter.id] = { cycle, level: alreadyNotified ? previous.level : level };
      if (alreadyNotified) continue;

      const threshold = level === 'critical' ? settings.notifyCritical : settings.notifyWarning;
      await chrome.notifications.create(`ollama-usage-${meter.id}`, {
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
 * Show a sample notification (settings -> "Send test"), so the user can check that
 * notifications actually reach them. The "notifications" permission is granted at install,
 * so there is no prompt - but the browser/OS can still block them per extension, which
 * getPermissionLevel reports. Ignores the "Enable notifications" switch on purpose.
 * @returns {Promise<{success: boolean, level: string, error?: string}>}
 */
async function sendTestNotification() {
  const level = await chrome.notifications.getPermissionLevel();
  if (level !== 'granted') {
    return { success: false, level, error: 'Notifications are blocked for this extension in the browser settings' };
  }
  await chrome.notifications.create('ollama-usage-test', {
    type: 'basic',
    iconUrl: 'icons/icon48.png',
    title: 'Usage Tracker for Ollama Cloud',
    message: 'Notifications work. You will be alerted when usage crosses your thresholds.',
    priority: 1
  });
  return { success: true, level };
}

/**
 * Check for persistent errors and notify user
 */
async function checkPersistentErrors(data, settings) {
  const stored = await chrome.storage.local.get(ERROR_COUNT_KEY);
  let errors = stored[ERROR_COUNT_KEY] || 0;

  if (data.status !== 'ok') {
    errors++;
    if (errors === MAX_CONSECUTIVE_ERRORS && settings.notifyEnabled) {
      let message = '';
      switch (data.status) {
        case 'auth_required':
          message = 'Not logged into Ollama Cloud. Please log in at ollama.com/settings';
          break;
        case 'parse_error':
          message = 'Failed to parse Ollama settings page. The page structure may have changed. Open the extension settings and use "Copy page diagnostics" to report it.';
          break;
        case 'network_error':
          message = 'Network error fetching Ollama settings. Check your connection.';
          break;
        default:
          message = `Usage tracking stopped working (${data.status}).`;
      }

      await chrome.notifications.create('ollama-usage-persistent-error', {
        type: 'basic',
        iconUrl: 'icons/icon48.png',
        title: 'Ollama Usage Tracker Error',
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
 * Activity counter for this reading: total requests of the model breakdown when the page
 * has one (exact), else the main usage window's percentage.
 */
function activityScore(data) {
  const { meter, models } = pickModelsSource(data);
  const requests = models.reduce((sum, m) => sum + m.requests, 0);
  if (requests > 0) return { kind: 'requests', key: meter?.id ?? 'page', value: requests };

  const primary = (data.meters || []).find((m) => m.usedPercent !== null && m.usedPercent !== undefined);
  return primary ? { kind: 'percent', key: primary.id, value: primary.usedPercent } : null;
}

const MAX_SEEN_REQUESTS = 300;

/** Drop hourly buckets older than the retention window (in place). */
function pruneBuckets(buckets) {
  const cutoff = hourKey(new Date(Date.now() - ACTIVITY_RETENTION_DAYS * 86400000));
  for (const key of Object.keys(buckets)) {
    if (key < cutoff) delete buckets[key];
  }
}

/**
 * Count each request from the "Recent requests" table once, in the hour it actually
 * happened. Requests are identified by their timestamp, so repeated readings of the same
 * table never double count, and the first reading back-fills the visible history.
 * @returns {boolean} true when the page had a request table (so the delta fallback is skipped)
 */
function recordRequestLog(activity, requests) {
  if (!Array.isArray(requests) || requests.length === 0) return false;

  const seen = new Set(activity.seen || []);
  const log = { ...activity.log };
  for (const request of requests) {
    if (seen.has(request.id)) continue;
    const key = hourKey(new Date(request.at));
    log[key] = (log[key] || 0) + 1;
  }

  // Newest first, then older ids still remembered; capped so storage stays small
  activity.seen = [...new Set([...requests.map((r) => r.id), ...(activity.seen || [])])].slice(0, MAX_SEEN_REQUESTS);
  activity.log = log;
  return true;
}

/**
 * Record activity for the popup heatmap. Preferred source: the request log (exact times).
 * Fallback for pages without one: the increase since the previous reading is added to the
 * current hour's bucket. Everything stays local.
 */
async function recordActivity(data) {
  const stored = (await chrome.storage.local.get(ACTIVITY_KEY))[ACTIVITY_KEY] || {};
  const activity = { requests: {}, percent: {}, log: {}, seen: [], ...stored };

  const usedLog = recordRequestLog(activity, data.recentRequests);
  if (usedLog) {
    pruneBuckets(activity.log);
    await chrome.storage.local.set({ [ACTIVITY_KEY]: activity });
    return;
  }

  const score = activityScore(data);
  if (!score) return;
  const last = activity.last;

  // First reading (or a different window/kind) only sets the baseline - we can't know when
  // the existing usage happened.
  let delta = 0;
  if (last && last.kind === score.kind && last.key === score.key) {
    // A smaller value means the window reset; what's counted now accrued since the reset
    delta = score.value >= last.value ? score.value - last.value : score.value;
  }

  const buckets = { ...activity[score.kind] };
  if (delta > 0) {
    const key = hourKey(new Date());
    buckets[key] = Math.round(((buckets[key] || 0) + delta) * 100) / 100;
  }

  pruneBuckets(buckets);
  activity[score.kind] = buckets;
  activity.last = score;
  await chrome.storage.local.set({ [ACTIVITY_KEY]: activity });
}

/**
 * Remember the colors ollama.com paints each model with (read from the usage bars), so a
 * model keeps its real color wherever it shows up later. Newest colors win; the map is
 * capped. Returns the updated map, or null when nothing changed.
 */
async function mergeLearnedColors(data) {
  const seen = {};
  for (const m of [...(data.meters || []).flatMap((meter) => meter.models || []), ...(data.models || [])]) {
    if (m.model && m.color) seen[m.model] = m.color;
  }
  if (Object.keys(seen).length === 0) return null;

  const stored = (await chrome.storage.local.get(COLORS_KEY))[COLORS_KEY] || {};
  if (Object.entries(seen).every(([model, color]) => stored[model] === color)) return null;

  // Re-inserting refreshed models last keeps recently seen ones when the cap trims the oldest
  const merged = { ...stored };
  for (const [model, color] of Object.entries(seen)) {
    delete merged[model];
    merged[model] = color;
  }
  const entries = Object.entries(merged);
  return Object.fromEntries(entries.slice(Math.max(0, entries.length - MAX_LEARNED_COLORS)));
}

/**
 * Main refresh function - called by alarm. Concurrent calls (alarm + manual refresh) share
 * one run so activity deltas aren't double counted.
 */
function refreshUsage() {
  if (!refreshInFlight) {
    refreshInFlight = doRefresh().finally(() => { refreshInFlight = null; });
  }
  return refreshInFlight;
}

async function doRefresh() {
  console.log('[background] Refreshing usage data...');

  const { diagnostics, ...data } = await fetchAndParseUsage();

  const toStore = { [STORAGE_KEY]: data };
  if (diagnostics) toStore[DIAGNOSTICS_KEY] = { html: diagnostics, at: data.lastFetch };
  // Same write as the usage data so the popup sees colors and models in one storage event
  const colors = await mergeLearnedColors(data);
  if (colors) toStore[COLORS_KEY] = colors;
  await chrome.storage.local.set(toStore);

  await updateBadge(data);

  const settings = await getSettings();
  if (data.status === 'ok') {
    await recordActivity(data);
    await checkThresholdNotifications(data, settings);
  }
  await checkPersistentErrors(data, settings);

  console.log('[background] Refresh complete:', data.status);
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

  if (message.type === 'TEST_NOTIFICATION') {
    sendTestNotification().then(sendResponse).catch(error => {
      sendResponse({ success: false, error: error.message });
    });
    return true;
  }

  if (message.type === 'CLEAR_DATA') {
    chrome.storage.local.clear().then(async () => {
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
 * Initialize on install/update
 */
chrome.runtime.onInstalled.addListener(async (details) => {
  console.log('[background] Extension installed/updated:', details.reason);

  // Set default settings, and migrate v1.0 threshold keys on update
  const existing = await chrome.storage.local.get('settings');
  await saveSettings(existing.settings || DEFAULT_SETTINGS);

  // Initialize alarm
  await initializeAlarm();

  // Do initial fetch
  await refreshUsage();
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
