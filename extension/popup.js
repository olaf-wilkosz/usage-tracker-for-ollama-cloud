/**
 * Popup logic for Usage Tracker for Ollama Cloud.
 * Reads usage data from storage and renders every usage window the Ollama API reports
 * (included credits, or legacy session + weekly windows) plus the purchased credits, a model
 * breakdown donut, recent activity, an activity heatmap and the peak / off-peak pricing
 * banner. Until an API key is connected it shows a setup prompt instead. An in-popup
 * settings panel is toggled by the gear icon.
 */

import { formatResetTime, formatUsd, getBadgeColor, getTextColor, secondsUntil } from './usage.js';
import {
  loadSettings, saveSettings, clearAllData, validateSettings, copyDiagnostics, sendTestNotification, DEFAULT_SETTINGS
} from './settings.js';
import { modelColor } from './model-colors.js';
import { getPeakStatus } from './peak-hours.js';
import { buildWeekGrid, buildMonthGrid, heatLevel } from './activity.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const OLLAMA_BILLING_URL = 'https://ollama.com/settings';
const COUNTDOWN_REFRESH_MS = 30000;
const RESET_PROGRESSIVE = { Resets: 'Resetting', Refills: 'Refilling', Renews: 'Renewing' };

// DOM elements
const elements = {
  headerTitle: document.getElementById('headerTitle'),
  gearIcon: document.getElementById('gearIcon'),
  closeIcon: document.getElementById('closeIcon'),
  recentBlock: document.getElementById('recentBlock'),
  recentList: document.getElementById('recentList'),
  recentSummary: document.getElementById('recentSummary'),
  statusContainer: document.getElementById('statusContainer'),
  connectBlock: document.getElementById('connectBlock'),
  connectText: document.getElementById('connectText'),
  connectBtn: document.getElementById('connectBtn'),
  manageKeyBtn: document.getElementById('manageKeyBtn'),
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
  activityBlock: document.getElementById('activityBlock'),
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
let setupNeeded = false; // no API key yet (or it was rejected): the setup prompt replaces the usage view

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
  element.style.color = getTextColor(percent);
}

/**
 * Render a usage bar: a single segment in the usage threshold color, filled up to
 * `usedPercent` of the track. (Segments per model are supported when a meter carries a
 * model breakdown.)
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
    segment.style.background = color || modelColor(model);
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
  const detail = node.dataset.prefix || '';

  let text = '';
  const seconds = resetsAt ? secondsUntil(resetsAt) : null;
  if (seconds !== null && seconds <= 0) {
    text = `${RESET_PROGRESSIVE[verb] || 'Resetting'} now...`;
  } else if (seconds !== null) {
    text = `${verb} in ${formatResetTime(seconds)}.`;
  }
  node.textContent = [detail, text].filter(Boolean).join(' · ');
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
  if (meter.detail) reset.dataset.prefix = meter.detail;
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
    elements.metersContainer.appendChild(el('div', 'empty-note', 'Your plan has no included usage to track.'));
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
    link.href = OLLAMA_BILLING_URL;
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

/**
 * Legend/donut entries from the model breakdown, busiest first. With more than
 * MAX_LEGEND_ROWS models the tail is folded into one "N other models" entry, so the legend
 * (and the popup) stays a bounded height however many models were used.
 * @param {Array<{model: string, requests: number, cost?: number}>} models - sorted by requests, descending
 * @returns {Array<{label: string, requests: number, cost: number, color: string, members: string|null}>}
 */
function buildLegendItems(models) {
  const items = models.map(({ model, requests, cost }) => ({ label: model, requests, cost: cost || 0, color: modelColor(model), members: null }));
  if (items.length <= MAX_LEGEND_ROWS) return items;

  const head = items.slice(0, MAX_LEGEND_ROWS - 1);
  const rest = items.slice(MAX_LEGEND_ROWS - 1);
  return [...head, {
    label: `${rest.length} other models`,
    requests: rest.reduce((sum, m) => sum + m.requests, 0),
    cost: rest.reduce((sum, m) => sum + m.cost, 0),
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
  for (const { label: name, requests, cost, color, members } of models) {
    const share = Math.round((requests / total) * 100);
    const detail = `${requests} request${requests === 1 ? '' : 's'} · ${share}%`;

    const li = el('li');
    li.title = `${name}: ${detail}${cost > 0 ? ` · ${formatUsd(cost)}` : ''}${members ? `\n${members}` : ''}`;
    const swatch = el('span', 'model-swatch');
    swatch.style.background = color;
    const text = el('div', 'model-text');
    text.append(el('div', 'model-name', name), el('div', 'model-requests', detail));
    li.append(swatch, text);
    listEl.appendChild(li);
  }
}

/**
 * The busiest recent hours (newest first): when, requests, top model and cost. The block is
 * collapsed by default (it's a glance-and-go popup) but its summary already says how many
 * requests happened in the last 24h.
 */
function renderRecent(hours) {
  const all = hours || [];
  const latest = all.slice(0, RECENT_SHOWN);
  elements.recentList.textContent = '';
  elements.recentBlock.hidden = latest.length === 0;

  const requests = all.reduce((sum, h) => sum + h.requests, 0);
  const cost = all.reduce((sum, h) => sum + h.cost, 0);
  elements.recentSummary.textContent = `${requests} request${requests === 1 ? '' : 's'} · ${formatUsd(cost)} in 24h`;

  for (const hour of latest) {
    const start = new Date(hour.from);
    const top = [...hour.models].sort((a, b) => b.requests - a.requests)[0];

    const li = el('li');
    li.title = hour.models.map((m) => `${m.model}: ${m.requests}`).join('\n');

    const swatch = el('span', 'model-swatch');
    swatch.style.background = modelColor(top?.model ?? '');
    const text = el('div', 'model-text');
    const when = `${start.toLocaleDateString(undefined, { weekday: 'short' })} ${String(start.getHours()).padStart(2, '0')}:00`;
    const detail = `${hour.requests} request${hour.requests === 1 ? '' : 's'}${hour.models.length > 1 ? ` · ${hour.models.length} models` : ''}`;
    text.append(el('div', 'model-name', when), el('div', 'model-requests', detail));

    li.append(swatch, text, el('span', 'recent-cost', formatUsd(hour.cost)));
    elements.recentList.appendChild(li);
  }
}

function renderModels(data) {
  const sorted = [...(data.models || [])].sort((a, b) => b.requests - a.requests);
  const total = sorted.reduce((sum, m) => sum + m.requests, 0);

  if (total <= 0) {
    elements.modelsBlock.hidden = true;
    return;
  }
  elements.modelsHeading.textContent = data.modelsLabel || 'Models used';
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

  const hours = activityData?.hours || {};
  const describe = (value) => `${Math.round(value)} request${Math.round(value) === 1 ? '' : 's'}`;

  let total;
  if (activityMode === 'week') {
    const week = buildWeekGrid(hours);
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
    const month = buildMonthGrid(hours, new Date(), activityData?.days || {});
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

  elements.activityNote.textContent = activityMode === 'week'
    ? (total > 0
      ? 'Hourly detail covers the last 24 h and builds up while your browser is running.'
      : 'No requests yet – hourly cells fill in as you use Ollama.')
    : 'Requests per day over the last 30 days (days start at 00:00 UTC).';
}

function setActivityMode(mode) {
  activityMode = mode;
  elements.activityWeekBtn.classList.toggle('active', mode === 'week');
  elements.activityMonthBtn.classList.toggle('active', mode === 'month');
  renderActivity();
}

/** Peak / off-peak pricing banner (schedule from ollama.com/pricing, computed from the clock). */
function updatePeakBanner() {
  if (!currentSettings.showPeakBanner || setupNeeded) {
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
  forbidden: 'Ollama says your account is suspended or access is denied.',
  rate_limited: 'Ollama is rate limiting requests. Showing the last data; retrying soon.',
  api_error: 'The Ollama API returned something unexpected. Use Settings → Copy diagnostics to report it.',
  network_error: 'Could not reach the Ollama API. Showing the last data; check your connection.'
};

const CONNECT_TEXT = {
  no_key: 'The tracker reads your usage through Ollama\u2019s official API and needs an API key. Setup takes a minute.',
  auth_required: 'Ollama rejected the saved API key (revoked or replaced?). Paste a new one to continue.'
};

function openSetup() {
  chrome.runtime.openOptionsPage();
  window.close();
}

/**
 * Render usage data in the popup
 */
function renderUsage(data) {
  const needsKey = !data || data.status === 'no_key' || data.status === 'auth_required';

  setupNeeded = needsKey;
  elements.connectBlock.hidden = !needsKey;
  updatePeakBanner();
  if (needsKey) {
    elements.connectText.textContent = CONNECT_TEXT[data?.status] || CONNECT_TEXT.no_key;
    hideStatus();
    elements.metersContainer.textContent = '';
    for (const node of [elements.creditsBlock, elements.modelsBlock, elements.recentBlock, elements.lastUpdated, elements.activityBlock]) {
      node.hidden = true;
    }
    return;
  }
  elements.activityBlock.hidden = false;

  // Error states keep showing the last good numbers (marked stale by the worker)
  if (data.status !== 'ok') {
    showStatus(data.status, STATUS_MESSAGES[data.status] || `Error: ${data.status}`);
  } else {
    hideStatus();
  }

  renderMeters(data.meters || [], data.status);
  renderCredits(data.credits);
  renderModels(data);
  renderRecent(data.recentHours);

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
    chrome.storage.local.get('ollamaActivity')
  ]);
  currentSettings = settings;
  activityData = stored.ollamaActivity || null;

  renderUsage(data);
  renderActivity();
  updatePeakBanner();
  setInterval(() => {
    updateCountdowns();
    updatePeakBanner();
  }, COUNTDOWN_REFRESH_MS);

  elements.activityWeekBtn.addEventListener('click', () => setActivityMode('week'));
  elements.activityMonthBtn.addEventListener('click', () => setActivityMode('month'));

  elements.connectBtn.addEventListener('click', openSetup);
  elements.manageKeyBtn.addEventListener('click', openSetup);

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
    if (!confirm('This clears all locally stored data, including the saved API key. Continue?')) {
      return;
    }

    elements.clearDataBtn.disabled = true;
    elements.clearDataBtn.textContent = 'Clearing...';

    const result = await clearAllData();

    elements.clearDataBtn.disabled = false;
    elements.clearDataBtn.textContent = 'Clear All Local Data';

    if (result.success) {
      showInlineStatus(elements.clearStatus, 'All local data cleared, including the saved API key', true);
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
