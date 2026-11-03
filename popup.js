/**
 * Popup logic for Ollama Cloud Usage Tracker.
 * Reads usage data from storage and renders every usage window the page reports (a "Free
 * usage" window, legacy session + weekly windows, ...) plus the credits balance, a model
 * breakdown donut, an activity heatmap and the peak / off-peak pricing banner. An in-popup
 * settings panel is toggled by the gear icon.
 */

import {
  formatResetTime,
  getBadgeColor,
  normalizeUsageData,
  pickModelsSource,
  secondsUntil
} from './parse-usage.js';
import {
  loadSettings, saveSettings, clearAllData, validateSettings, copyDiagnostics, sendTestNotification, DEFAULT_SETTINGS
} from './settings.js';
import { modelColor } from './model-colors.js';
import { getPeakStatus } from './peak-hours.js';
import { pickActivityBuckets, buildWeekGrid, buildMonthGrid, heatLevel } from './activity.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const OLLAMA_SETTINGS_URL = 'https://ollama.com/settings';
const COUNTDOWN_REFRESH_MS = 30000;
const RESET_PROGRESSIVE = { Resets: 'Resetting', Refills: 'Refilling', Renews: 'Renewing' };

// DOM elements
const elements = {
  headerTitle: document.getElementById('headerTitle'),
  tierBadge: document.getElementById('tierBadge'),
  gearIcon: document.getElementById('gearIcon'),
  closeIcon: document.getElementById('closeIcon'),
  recentBlock: document.getElementById('recentBlock'),
  recentList: document.getElementById('recentList'),
  recentSummary: document.getElementById('recentSummary'),
  statusContainer: document.getElementById('statusContainer'),
  peakBanner: document.getElementById('peakBanner'),
  peakTitle: document.getElementById('peakTitle'),
  peakDetail: document.getElementById('peakDetail'),
  metersContainer: document.getElementById('metersContainer'),
  creditsBlock: document.getElementById('creditsBlock'),
  creditsAmount: document.getElementById('creditsAmount'),
  creditsNote: document.getElementById('creditsNote'),
  modelsBlock: document.getElementById('modelsBlock'),
  modelsHeading: document.getElementById('modelsHeading'),
  modelsDonut: document.getElementById('modelsDonut'),
  modelsList: document.getElementById('modelsList'),
  activityGrid: document.getElementById('activityGrid'),
  activityNote: document.getElementById('activityNote'),
  activityWeekBtn: document.getElementById('activityWeekBtn'),
  activityMonthBtn: document.getElementById('activityMonthBtn'),
  lastUpdated: document.getElementById('lastUpdated'),
  refreshBtn: document.getElementById('refreshBtn'),
  settingsBtn: document.getElementById('settingsBtn'),
  mainView: document.getElementById('mainView'),
  settingsView: document.getElementById('settingsView'),
  refreshInterval: document.getElementById('refreshInterval'),
  notifyWarning: document.getElementById('notifyWarning'),
  notifyCritical: document.getElementById('notifyCritical'),
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

let currentSettings = { ...DEFAULT_SETTINGS };
let activityData = null;
let activityMode = 'week';
let settingsOpen = false;
let planLabel = null;
let learnedColors = {}; // model -> color as ollama.com paints it (see background.js)

/** The model's own ollama.com color when it has been seen, else the built-in fallback. */
function colorFor(model) {
  return modelColor(model, learnedColors);
}

/** Create an element with an optional class and text. */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  return node;
}

/**
 * Color a usage percentage text element based on threshold (reuses the same color scale as
 * the toolbar icon).
 */
function updatePercentText(element, percent, fallbackText = '--') {
  if (percent === null || percent === undefined || isNaN(percent)) {
    element.textContent = fallbackText;
    element.style.color = '';
    return;
  }
  element.textContent = `${percent.toFixed(1)}% used`;
  element.style.color = getBadgeColor(percent);
}

/**
 * Render a segmented usage bar: one colored segment per model, matching the real bar on
 * ollama.com/settings. Segments fill only up to `usedPercent` of the track (not the full
 * width) so bars stay comparable at a glance. Without a model breakdown the bar is a single
 * segment in the usage threshold color.
 */
function renderSegmentBar(barEl, models, usedPercent) {
  barEl.textContent = '';
  const list = models || [];
  const total = list.reduce((sum, m) => sum + m.requests, 0);
  const percent = Math.max(0, Math.min(100, usedPercent ?? 0));
  if (percent <= 0) return;

  if (total <= 0) {
    const segment = el('div', 'segment');
    segment.style.width = `${percent}%`;
    segment.style.background = getBadgeColor(percent);
    barEl.appendChild(segment);
    return;
  }

  for (const { model, requests, color } of list) {
    const segment = el('div', 'segment');
    segment.style.width = `${(requests / total) * percent}%`;
    segment.style.background = color || colorFor(model);
    segment.title = `${model}: ${requests} request${requests === 1 ? '' : 's'}`;
    barEl.appendChild(segment);
  }
}

/**
 * Fill a "Resets in 3h." line from its data attributes. Called on render and by the timer,
 * so the countdown stays correct while the popup is open (stored data only changes on fetch).
 */
function setResetText(node) {
  const verb = node.dataset.verb || 'Resets';
  const resetsAt = node.dataset.resetsAt;

  if (resetsAt) {
    const seconds = secondsUntil(resetsAt);
    if (seconds === null) {
      node.textContent = '';
    } else if (seconds <= 0) {
      node.textContent = `${RESET_PROGRESSIVE[verb] || 'Resetting'} now...`;
    } else {
      const approx = node.dataset.approx === '1' ? '~' : '';
      node.textContent = `${verb} in ${approx}${formatResetTime(seconds)}.`;
    }
  } else {
    node.textContent = node.dataset.fallback || '';
  }
  node.hidden = node.textContent === '';
}

function setAgoText(node) {
  const seconds = secondsUntil(node.dataset.at);
  node.textContent = seconds === null ? '' : `${formatResetTime(Math.max(0, -seconds))} ago`;
}

function updateCountdowns() {
  document.querySelectorAll('[data-reset-line]').forEach(setResetText);
  document.querySelectorAll('[data-at]').forEach(setAgoText);
}

/** One usage window: label, "NN% used", segmented bar and reset line. */
function buildMeterBlock(meter) {
  const block = el('section', 'usage-block');

  const row = el('div', 'usage-row');
  const value = el('span', 'usage-value');
  updatePercentText(value, meter.usedPercent, meter.valueText || '--');
  row.append(el('span', 'usage-label', meter.label), value);

  const bar = el('div', 'segment-bar');
  bar.setAttribute('aria-hidden', 'true');
  renderSegmentBar(bar, meter.models, meter.usedPercent);

  const reset = el('div', 'usage-reset');
  reset.dataset.resetLine = '1';
  reset.dataset.verb = meter.resetVerb || 'Resets';
  if (meter.resetsAt) reset.dataset.resetsAt = meter.resetsAt;
  if (meter.resetsAtApprox) reset.dataset.approx = '1';
  if (meter.refillText) reset.dataset.fallback = meter.refillText;
  setResetText(reset);

  block.append(row, bar, reset);
  return block;
}

function renderMeters(meters, status) {
  elements.metersContainer.textContent = '';
  for (const meter of meters) {
    elements.metersContainer.appendChild(buildMeterBlock(meter));
  }
  if (meters.length === 0 && status === 'ok') {
    elements.metersContainer.appendChild(el('div', 'empty-note', 'No usage windows on your Ollama page right now.'));
  }
}

function renderCredits(credits) {
  if (!credits) {
    elements.creditsBlock.hidden = true;
    return;
  }
  elements.creditsAmount.textContent = credits.text;
  elements.creditsAmount.style.color = '';

  elements.creditsNote.textContent = '';
  if (credits.amount <= 0) {
    const link = el('a', 'credits-link', 'Add credits');
    link.href = OLLAMA_SETTINGS_URL;
    link.target = '_blank';
    link.rel = 'noopener';
    elements.creditsNote.append('No credits yet. ', link);
    elements.creditsNote.hidden = false;
  } else {
    elements.creditsNote.hidden = true;
  }
  elements.creditsBlock.hidden = false;
}

const MAX_LEGEND_ROWS = 6;
const OTHERS_COLOR = '#8a8a8a';
const DONUT_MIN_PX = 96;
const DONUT_MAX_PX = 128;
const DONUT_PX_PER_ROW = 28;
const RECENT_SHOWN = 5;
// ollama.com's "Recent requests" table loads this many rows at a time; a full page that is
// entirely within the last 24h means the real count is higher ("25+")
const RECENT_PAGE_SIZE = 25;
const DAY_MS = 86400000;

/**
 * Legend/donut entries from the model breakdown, busiest first. With more than
 * MAX_LEGEND_ROWS models the tail is folded into one "N other models" entry, so the legend
 * (and the popup) stays a bounded height however many models were used.
 * @param {Array<{model: string, requests: number}>} models - sorted by requests, descending
 * @returns {Array<{label: string, requests: number, color: string, members: string|null}>}
 */
function buildLegendItems(models) {
  const items = models.map(({ model, requests, color }) => ({ label: model, requests, color: color || colorFor(model), members: null }));
  if (items.length <= MAX_LEGEND_ROWS) return items;

  const head = items.slice(0, MAX_LEGEND_ROWS - 1);
  const rest = items.slice(MAX_LEGEND_ROWS - 1);
  return [...head, {
    label: `${rest.length} other models`,
    requests: rest.reduce((sum, m) => sum + m.requests, 0),
    color: OTHERS_COLOR,
    members: rest.map((m) => `${m.label}: ${m.requests}`).join('\n')
  }];
}

/**
 * Model breakdown donut: one arc per entry in its Ollama color, total requests in the
 * center. Built with createElementNS (no innerHTML).
 */
function renderDonut(container, models, total) {
  container.textContent = '';

  const svg = svgEl('svg', { viewBox: '0 0 42 42', class: 'donut-svg', role: 'img' });
  svg.setAttribute('aria-label', `${total} requests by model`);

  const radius = 15.9155; // circumference = 100, so dash lengths read as percentages
  svg.appendChild(svgEl('circle', {
    cx: 21, cy: 21, r: radius, fill: 'none', stroke: 'var(--bg-tertiary)', 'stroke-width': 5
  }));

  let offset = 25; // start at 12 o'clock
  const gap = models.length > 1 ? 0.8 : 0;
  for (const { label, requests, color } of models) {
    const share = (requests / total) * 100;
    const arc = svgEl('circle', {
      cx: 21, cy: 21, r: radius, fill: 'none', stroke: color, 'stroke-width': 5,
      'stroke-dasharray': `${Math.max(share - gap, 0.1)} ${100 - Math.max(share - gap, 0.1)}`,
      'stroke-dashoffset': offset
    });
    const tip = svgEl('title');
    tip.textContent = `${label}: ${requests} request${requests === 1 ? '' : 's'} (${Math.round(share)}%)`;
    arc.appendChild(tip);
    svg.appendChild(arc);
    offset -= share;
  }

  const count = svgEl('text', { x: 21, y: 22, 'text-anchor': 'middle', class: 'donut-total' });
  count.textContent = String(total);
  const caption = svgEl('text', { x: 21, y: 27.5, 'text-anchor': 'middle', class: 'donut-caption' });
  caption.textContent = 'requests';
  svg.append(count, caption);

  container.appendChild(svg);
}

/** Legend next to the donut: swatch + model name, and below it "34 requests · 64%". */
function renderModelList(listEl, models, total) {
  listEl.textContent = '';
  for (const { label: name, requests, color, members } of models) {
    const share = Math.round((requests / total) * 100);
    const detail = `${requests} request${requests === 1 ? '' : 's'} · ${share}%`;

    const li = el('li');
    li.title = `${name}: ${detail}${members ? `\n${members}` : ''}`;
    const swatch = el('span', 'model-swatch');
    swatch.style.background = color;
    const text = el('div', 'model-text');
    text.append(el('div', 'model-name', name), el('div', 'model-requests', detail));
    li.append(swatch, text);
    listEl.appendChild(li);
  }
}

/**
 * The latest requests from ollama.com's "Recent requests" table: model, cost, how long ago.
 * The block is collapsed by default (it's a glance-and-go popup; the full list lives on
 * ollama.com) but its summary already says how many requests happened in the last 24h.
 */
function renderRecent(requests) {
  const all = requests || [];
  const latest = all.slice(0, RECENT_SHOWN);
  elements.recentList.textContent = '';
  elements.recentBlock.hidden = latest.length === 0;

  const lastDay = all.filter((r) => Date.now() - Date.parse(r.at) < DAY_MS).length;
  const truncated = lastDay === all.length && all.length >= RECENT_PAGE_SIZE;
  elements.recentSummary.textContent = `${lastDay}${truncated ? '+' : ''} in last 24h`;

  for (const request of latest) {
    const li = el('li');
    li.title = new Date(request.at).toLocaleString();

    const swatch = el('span', 'model-swatch');
    swatch.style.background = colorFor(request.model);
    const text = el('div', 'model-text');
    const when = el('div', 'model-requests');
    when.dataset.at = request.at;
    setAgoText(when);
    text.append(el('div', 'model-name', request.model), when);

    li.append(swatch, text, el('span', 'recent-cost', request.costText || ''));
    elements.recentList.appendChild(li);
  }
}

function renderModels(data) {
  const { meter, label, models } = pickModelsSource(data);
  const sorted = [...models].sort((a, b) => b.requests - a.requests);
  const total = sorted.reduce((sum, m) => sum + m.requests, 0);

  if (total <= 0) {
    elements.modelsBlock.hidden = true;
    return;
  }
  elements.modelsHeading.textContent = label || (meter ? `Models used · ${meter.label}` : 'Models used');
  const items = buildLegendItems(sorted);
  // The donut grows with the legend so a long list doesn't leave a hole under a small ring
  const donutPx = Math.max(DONUT_MIN_PX, Math.min(DONUT_MAX_PX, items.length * DONUT_PX_PER_ROW));
  elements.modelsDonut.style.width = elements.modelsDonut.style.height = `${donutPx}px`;
  renderDonut(elements.modelsDonut, items, total);
  renderModelList(elements.modelsList, items, total);
  elements.modelsBlock.hidden = false;
}

/** Shared activity cell: level class + tooltip. */
function heatCell(value, max, title, future) {
  const cell = el('div', future ? 'hm-cell future' : `hm-cell level-${heatLevel(value, max)}`);
  if (!future) cell.title = title;
  return cell;
}

function renderActivity() {
  const grid = elements.activityGrid;
  grid.textContent = '';
  grid.className = `heatmap ${activityMode}`;

  const { kind, buckets } = pickActivityBuckets(activityData);
  const describe = (value) => (kind === 'requests'
    ? `${Math.round(value)} request${Math.round(value) === 1 ? '' : 's'}`
    : `+${value.toFixed(1)}% usage`);

  let total;
  if (activityMode === 'week') {
    const week = buildWeekGrid(buckets);
    total = week.total;

    grid.appendChild(el('div'));
    for (let hour = 0; hour < 24; hour++) {
      grid.appendChild(el('div', 'hm-hour', hour % 3 === 0 ? String(hour).padStart(2, '0') : ''));
    }
    for (const { date, cells } of week.rows) {
      grid.appendChild(el('div', 'hm-label', date.toLocaleDateString(undefined, { weekday: 'short' })));
      for (const cell of cells) {
        const when = `${date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}, ${String(cell.hour).padStart(2, '0')}:00`;
        grid.appendChild(heatCell(cell.value, week.max, `${when} – ${describe(cell.value)}`, cell.future));
      }
    }
  } else {
    const month = buildMonthGrid(buckets);
    total = month.total;

    grid.appendChild(el('div'));
    for (const letter of ['M', 'T', 'W', 'T', 'F', 'S', 'S']) {
      grid.appendChild(el('div', 'hm-hour', letter));
    }
    for (const { start, cells } of month.rows) {
      grid.appendChild(el('div', 'hm-label', start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })));
      for (const cell of cells) {
        const when = cell.date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
        grid.appendChild(heatCell(cell.value, month.max, `${when} – ${describe(cell.value)}`, cell.future));
      }
    }
  }

  elements.activityNote.textContent = total > 0
    ? 'Based on usage this extension saw while Chrome was running.'
    : 'Collecting activity – cells fill in as you use Ollama while Chrome is running.';
}

function setActivityMode(mode) {
  activityMode = mode;
  elements.activityWeekBtn.classList.toggle('active', mode === 'week');
  elements.activityMonthBtn.classList.toggle('active', mode === 'month');
  renderActivity();
}

/** Peak / off-peak pricing banner (schedule from ollama.com/pricing, computed from the clock). */
function updatePeakBanner() {
  if (!currentSettings.showPeakBanner) {
    elements.peakBanner.hidden = true;
    return;
  }
  const { isPeak, secondsToChange } = getPeakStatus();
  elements.peakBanner.className = `peak-banner ${isPeak ? 'peak' : 'offpeak'}`;
  elements.peakTitle.textContent = isPeak ? 'Peak pricing' : 'Off-peak pricing';
  elements.peakDetail.textContent = `${isPeak ? 'Off-peak' : 'Peak'} in ${formatResetTime(secondsToChange)}`;
  elements.peakBanner.title = 'Based on the pricing hours published at ollama.com/pricing '
    + '(weekdays 12:00–18:00 UTC are peak, everything else off-peak). Not read from your account.';
  elements.peakBanner.hidden = false;
}

/**
 * Show status message
 */
function showStatus(status, message) {
  const container = elements.statusContainer;
  container.className = `status-container ${status}`;
  container.textContent = message;
  container.hidden = false;
}

/**
 * Hide status message
 */
function hideStatus() {
  elements.statusContainer.hidden = true;
  elements.statusContainer.className = 'status-container';
  elements.statusContainer.textContent = '';
}

/**
 * Format last updated timestamp
 */
function formatLastUpdated(isoString) {
  if (!isoString) return 'Never';

  try {
    const date = new Date(isoString);
    const now = new Date();
    const diffMs = now - date;

    if (diffMs < 60000) return 'Just now';
    if (diffMs < 3600000) return `${Math.floor(diffMs / 60000)}m ago`;
    if (diffMs < 86400000) return `${Math.floor(diffMs / 3600000)}h ago`;

    return date.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  } catch {
    return 'Unknown';
  }
}

const STATUS_MESSAGES = {
  auth_required: 'Not logged into Ollama Cloud. Click "Open Ollama Settings" to sign in.',
  parse_error: 'Could not read the Ollama usage page – its layout may have changed. '
    + 'Open Settings (gear) and use "Copy page diagnostics" to report it.',
  network_error: 'Network error. Check your connection and try refreshing.'
};

/**
 * Render usage data in the popup
 */
function renderUsage(rawData) {
  const data = normalizeUsageData(rawData);

  if (!data) {
    // No data yet
    hideStatus();
    planLabel = null;
    syncHeader();
    elements.metersContainer.textContent = '';
    elements.metersContainer.appendChild(el('div', 'empty-note', 'No data yet – click refresh.'));
    elements.creditsBlock.hidden = true;
    elements.modelsBlock.hidden = true;
    elements.recentBlock.hidden = true;
    elements.lastUpdated.hidden = true;
    return;
  }

  // Plan label (e.g. "free", "Pay as you go"). Capitalise only the first letter:
  // "free" -> "Free", "Pay as you go" stays readable.
  planLabel = data.tier ? data.tier.charAt(0).toUpperCase() + data.tier.slice(1) : null;
  syncHeader();

  // Handle error states
  if (data.status !== 'ok') {
    showStatus(data.status, STATUS_MESSAGES[data.status] || `Error: ${data.status}`);
  } else {
    hideStatus();
  }

  renderMeters(data.meters || [], data.status);
  renderCredits(data.credits);
  renderModels(data);
  renderRecent(data.recentRequests);

  // Last updated
  elements.lastUpdated.textContent = `Last updated: ${formatLastUpdated(data.lastFetch)}`;
  elements.lastUpdated.hidden = false;
}

/**
 * Load usage data from storage
 */
async function loadUsageData() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'GET_USAGE_DATA' }, (response) => {
      if (chrome.runtime.lastError) {
        console.error('[popup] Error getting data:', chrome.runtime.lastError);
        resolve(null);
      } else {
        resolve(response?.data || null);
      }
    });
  });
}

/**
 * Force refresh by messaging background
 */
async function forceRefresh() {
  elements.refreshBtn.disabled = true;
  elements.refreshBtn.style.opacity = '0.5';

  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'FORCE_REFRESH' }, (response) => {
      elements.refreshBtn.disabled = false;
      elements.refreshBtn.style.opacity = '';
      if (chrome.runtime.lastError) {
        console.error('[popup] Refresh error:', chrome.runtime.lastError);
        resolve(false);
      } else {
        resolve(response?.success ?? false);
      }
    });
  });
}

/**
 * Settings panel
 */
function populateSettingsForm(settings) {
  elements.refreshInterval.value = String(settings.refreshIntervalMinutes);
  elements.notifyWarning.value = String(settings.notifyWarning);
  elements.notifyCritical.value = String(settings.notifyCritical);
  elements.notifyEnabled.checked = settings.notifyEnabled;
  elements.showPeakBanner.checked = settings.showPeakBanner;
}

function collectSettingsForm() {
  return {
    refreshIntervalMinutes: parseInt(elements.refreshInterval.value, 10),
    notifyWarning: parseInt(elements.notifyWarning.value, 10),
    notifyCritical: parseInt(elements.notifyCritical.value, 10),
    notifyEnabled: elements.notifyEnabled.checked,
    showPeakBanner: elements.showPeakBanner.checked
  };
}

function showSaveStatus(message, isSuccess) {
  const originalText = elements.saveBtn.textContent;
  elements.saveBtn.textContent = message;
  elements.saveBtn.style.background = isSuccess ? '#388e3c' : '#d32f2f';

  setTimeout(() => {
    elements.saveBtn.textContent = originalText;
    elements.saveBtn.style.background = '';
  }, 2000);
}

function showInlineStatus(node, message, isSuccess, hideAfterMs = 3000) {
  node.textContent = message;
  node.className = `clear-status ${isSuccess ? 'success' : 'error'}`;
  node.hidden = false;

  setTimeout(() => {
    node.hidden = true;
  }, hideAfterMs);
}

/**
 * The header stays put between views; only its title and icons change (usage view: plan
 * badge + refresh + gear; settings view: "Settings" + close) so the layout never jumps.
 */
function syncHeader() {
  elements.headerTitle.textContent = settingsOpen ? 'Settings' : 'Ollama Cloud Usage';
  elements.tierBadge.textContent = planLabel || '';
  elements.tierBadge.hidden = settingsOpen || !planLabel;
  elements.refreshBtn.hidden = settingsOpen;
  // SVG elements have no .hidden property - toggle the attribute
  elements.gearIcon.toggleAttribute('hidden', settingsOpen);
  elements.closeIcon.toggleAttribute('hidden', !settingsOpen);
  const label = settingsOpen ? 'Close settings' : 'Settings';
  elements.settingsBtn.title = label;
  elements.settingsBtn.setAttribute('aria-label', label);
}

async function openSettingsView() {
  const settings = await loadSettings();
  populateSettingsForm(settings);
  settingsOpen = true;
  elements.mainView.hidden = true;
  elements.settingsView.hidden = false;
  syncHeader();
}

function closeSettingsView() {
  settingsOpen = false;
  elements.settingsView.hidden = true;
  elements.mainView.hidden = false;
  syncHeader();
}

/**
 * Initialize popup
 */
async function init() {
  // Load initial data
  const [data, settings, stored] = await Promise.all([
    loadUsageData(),
    loadSettings(),
    chrome.storage.local.get(['ollamaActivity', 'ollamaModelColors'])
  ]);
  currentSettings = settings;
  activityData = stored.ollamaActivity || null;
  learnedColors = stored.ollamaModelColors || {};

  renderUsage(data);
  renderActivity();
  updatePeakBanner();
  setInterval(() => {
    updateCountdowns();
    updatePeakBanner();
  }, COUNTDOWN_REFRESH_MS);

  elements.activityWeekBtn.addEventListener('click', () => setActivityMode('week'));
  elements.activityMonthBtn.addEventListener('click', () => setActivityMode('month'));

  // Refresh button
  elements.refreshBtn.addEventListener('click', async () => {
    const success = await forceRefresh();
    if (success) {
      const newData = await loadUsageData();
      renderUsage(newData);
    }
  });

  // Settings panel (in-popup, not a new window/tab)
  elements.settingsBtn.addEventListener('click', () => (settingsOpen ? closeSettingsView() : openSettingsView()));

  elements.saveBtn.addEventListener('click', async () => {
    const settings = collectSettingsForm();
    const errors = validateSettings(settings);

    if (errors.length > 0) {
      showSaveStatus(errors[0], false);
      return;
    }

    elements.saveBtn.disabled = true;
    const result = await saveSettings(settings);
    elements.saveBtn.disabled = false;

    if (result.success) {
      currentSettings = settings;
      updatePeakBanner();
      showSaveStatus('Saved!', true);
    } else {
      showSaveStatus(`Failed: ${result.error}`, false);
    }
  });

  elements.testNotifyBtn.addEventListener('click', async () => {
    const result = await sendTestNotification();
    showInlineStatus(
      elements.testNotifyStatus,
      result.success
        ? 'Sent. Nothing showed up? Check Do Not Disturb / Focus Assist and your browser’s notification settings.'
        : `Not sent: ${result.error}.`,
      result.success,
      7000
    );
  });

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
      activityData = null;
      renderUsage(await loadUsageData());
      renderActivity();
    } else {
      showInlineStatus(elements.clearStatus, `Failed: ${result.error}`, false);
    }
  });

  // Listen for storage changes (updates from background)
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    // Colors first: background.js writes them together with the usage data it renders
    if (changes.ollamaModelColors) {
      learnedColors = changes.ollamaModelColors.newValue || {};
    }
    if (changes.ollamaUsageData) {
      renderUsage(changes.ollamaUsageData.newValue);
    }
    if (changes.ollamaActivity) {
      activityData = changes.ollamaActivity.newValue || null;
      renderActivity();
    }
  });
}

// Start
init();
