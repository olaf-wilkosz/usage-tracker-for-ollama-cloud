/**
 * Shared HTML parsing module for extracting Ollama Cloud usage data.
 * This module has zero dependencies and works in both browser and Node.js contexts.
 * Keep parsing logic isolated here so markup changes only require a single-file fix.
 *
 * Result shape (see parseUsageFromDocument):
 *   { status, tier, meters: [{ id, label, usedPercent, valueText, resetsAt, resetsAtApprox,
 *     refillText, resetVerb, models }], credits, modelsLabel, models, diagnostics }
 *
 * Ollama has changed its billing page before (Cloud usage with Session + Weekly windows ->
 * a single "Free usage" window + "Usage credits" for pay-as-you-go), so nothing here assumes
 * a fixed number or naming of usage windows: every "<label> ... NN% used" row on the page
 * becomes one "meter". Parsing never falls back to scanning the whole document for stray
 * percentages / timestamps - that silently attached unrelated dates to the wrong window.
 */

// Selectors for the Ollama settings page (https://ollama.com/settings) - update these if markup changes.
// Structure verified against real SSR markup (2026-09-01 usage windows, 2026-11 usage credits card).
const SELECTORS = {
  headings: 'h1, h2, h3',
  // "<Label> / NN% used" rows, e.g. <div class="flex justify-between mb-2"><span>Free usage</span><span>56.6% used</span></div>
  usageRow: 'div.flex.justify-between',
  // Reset/refill time element near a usage row, e.g. <div class="... local-time" data-time="2026-09-01T22:00:00Z">Resets in 4 hours.</div>
  resetTime: '.local-time, [data-time]',
  // Per-model usage segments, e.g. <button data-usage-segment data-model="nemotron-3-ultra" data-requests="11">
  usageSegment: '[data-usage-segment]',
  // Auth required indicators. ollama.com redirects unauthenticated /settings requests to a
  // sign-in page on a different origin, so this rarely matches - background.js does the
  // HTTP-level redirect/status check, which is the primary auth_required signal.
  // Deliberately specific: broad [class*="error"] / [class*="sign-in"] selectors false-positive
  // on billing/payment markup.
  loginPrompt: '[data-testid="login-prompt"], .login-prompt',
  errorMessage: '[data-testid="error"], .error-message'
};

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const MAX_DIAGNOSTICS_CHARS = 60000;

/**
 * Extract percentage value from text like "24.6%" or "24%"
 * @param {string} text
 * @returns {number|null}
 */
function extractPercent(text) {
  if (!text) return null;
  const match = text.match(/(\d+(?:\.\d+)?)\s*%/);
  return match ? parseFloat(match[1]) : null;
}

const UNIT_SECONDS = [
  [/^(?:months?|mos?)$/, 30 * 86400],
  [/^(?:weeks?|wks?|w)$/, 7 * 86400],
  [/^(?:days?|d)$/, 86400],
  [/^(?:hours?|hrs?|h)$/, 3600],
  [/^(?:minutes?|mins?|m)$/, 60],
  [/^(?:seconds?|secs?|s)$/, 1]
];

/**
 * Extract a duration in seconds from text like "3h 14m", "2 hours", "Refills in 1 day.",
 * "5 hours 30 minutes" or "resets in an hour" (all "<number> <unit>" pairs are summed).
 * Only used as a fallback - the data-time attribute is exact and preferred when present.
 * @param {string} text
 * @returns {number|null}
 */
function extractResetSeconds(text) {
  if (!text) return null;
  const lower = text.toLowerCase().replace(/\ban?\b/g, '1');
  const re = /(\d+(?:\.\d+)?)\s*(months?|mos?|weeks?|wks?|w|days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/g;

  let total = 0;
  let found = false;
  let match;
  while ((match = re.exec(lower))) {
    const unit = UNIT_SECONDS.find(([pattern]) => pattern.test(match[2]));
    if (!unit) continue;
    total += parseFloat(match[1]) * unit[1];
    found = true;
  }
  return found ? Math.round(total) : null;
}

/**
 * Seconds from now until an ISO timestamp (negative if it is already in the past).
 * @param {string|null} isoString
 * @param {number} [now]
 * @returns {number|null}
 */
function secondsUntil(isoString, now = Date.now()) {
  if (!isoString) return null;
  const ms = Date.parse(isoString);
  return isNaN(ms) ? null : Math.round((ms - now) / 1000);
}

/**
 * Parse a number written either "1,234.50" or "1.234,50" (or "0,5").
 * @param {string} raw
 * @returns {number|null}
 */
function parseNumber(raw) {
  let s = raw.replace(/\s/g, '');
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma > -1 && lastDot > -1) {
    s = lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (lastComma > -1) {
    s = /,\d{1,2}$/.test(s) ? s.replace(',', '.') : s.replace(/,/g, '');
  }
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

/**
 * Parse a money string like "$0", "$12.50" or "12,50 €".
 * @param {string} text
 * @returns {{amount: number, currency: string}|null}
 */
function parseMoney(text) {
  if (!text) return null;
  const lead = text.match(/([$€£])\s*(\d[\d.,]*)/);
  const trail = text.match(/(\d[\d.,]*)\s*([$€£])/);
  const [symbol, digits] = lead ? [lead[1], lead[2]] : trail ? [trail[2], trail[1]] : [null, null];
  if (!symbol) return null;
  const amount = parseNumber(digits);
  return amount === null ? null : { amount, currency: symbol };
}

/** Text of an element's own text nodes only (skips child elements such as plan badges). */
function ownText(el) {
  return Array.from(el.childNodes)
    .filter((n) => n.nodeType === 3)
    .map((n) => n.textContent)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Visible label of a row cell: own text when the cell has badge children, else all text. */
function labelOf(el) {
  return ownText(el) || el.textContent.replace(/\s+/g, ' ').trim();
}

function slugify(label) {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'usage';
}

/**
 * Elements matching `selector` that belong to a usage row: its following siblings up to the
 * next usage row, or - when the row is alone in its parent - everything inside the parent.
 * Keeps one window's reset time / model segments from being attributed to another.
 * @param {Element} row
 * @param {string} selector
 * @param {Element[]} allRows
 * @returns {Element[]}
 */
function nearbyElements(row, selector, allRows) {
  const parent = row.parentElement;
  if (!parent) return [];
  const otherRows = allRows.filter((r) => r !== row && parent.contains(r));
  if (otherRows.length === 0) return Array.from(parent.querySelectorAll(selector));

  const found = [];
  for (let node = row.nextElementSibling; node; node = node.nextElementSibling) {
    if (allRows.some((r) => node === r || node.contains(r))) break;
    if (node.matches(selector)) found.push(node);
    found.push(...node.querySelectorAll(selector));
  }
  return found;
}

/**
 * Read a reset/refill element: exact time from its data-time ISO 8601 attribute when
 * present, otherwise an approximation parsed from its visible text.
 * @param {Element|null} el
 */
function readReset(el) {
  const none = { resetsAt: null, resetsAtApprox: false, refillText: null, resetVerb: 'Resets' };
  if (!el) return none;

  const text = el.textContent.replace(/\s+/g, ' ').trim();
  const resetVerb = /refill/i.test(text) ? 'Refills' : /renew/i.test(text) ? 'Renews' : 'Resets';
  const base = { ...none, refillText: text || null, resetVerb };

  const iso = el.getAttribute('data-time');
  const ms = iso ? Date.parse(iso) : NaN;
  if (!isNaN(ms)) return { ...base, resetsAt: new Date(ms).toISOString() };

  const seconds = extractResetSeconds(text);
  if (seconds !== null) {
    return { ...base, resetsAt: new Date(Date.now() + seconds * 1000).toISOString(), resetsAtApprox: true };
  }
  return base;
}

/**
 * Per-model usage breakdown read from progress-bar segments (exact request counts).
 * @param {Element[]} segmentEls
 * @returns {Array<{model: string, requests: number}>}
 */
function readModels(segmentEls) {
  const byModel = new Map();
  for (const el of segmentEls) {
    const model = el.getAttribute('data-model') || '';
    if (!model) continue;
    const requests = parseInt(el.getAttribute('data-requests'), 10) || 0;
    byModel.set(model, Math.max(requests, byModel.get(model) ?? 0));
  }
  return Array.from(byModel, ([model, requests]) => ({ model, requests }));
}

/**
 * Find the "Usage credits" card (pay-as-you-go balance), e.g.
 * <div class="flex items-baseline justify-between"><h2>Usage credits<span>Pay as you go</span></h2><span class="tabular-nums">$0</span></div>
 * @param {Document} doc
 * @returns {{credits: {text: string, amount: number, currency: string}|null, planLabel: string|null, row: Element|null}}
 */
function findCredits(doc) {
  const heading = Array.from(doc.querySelectorAll(SELECTORS.headings)).find((h) => /credit/i.test(ownText(h)));
  if (!heading) return { credits: null, planLabel: null, row: null };

  const badge = heading.querySelector('span');
  const planLabel = badge && badge.textContent.trim().length <= 30 ? badge.textContent.trim() : null;

  // Balance: a money-looking span next to the heading (not inside it)
  let balance = null;
  let row = heading.parentElement;
  for (let depth = 0; row && depth < 2 && !balance; depth++, row = row.parentElement) {
    balance = Array.from(row.querySelectorAll('span'))
      .filter((s) => !heading.contains(s))
      .map((s) => ({ text: s.textContent.trim(), money: parseMoney(s.textContent) }))
      .find((s) => s.money);
  }

  return {
    credits: balance ? { text: balance.text, amount: balance.money.amount, currency: balance.money.currency } : null,
    planLabel,
    row: heading.parentElement
  };
}

/**
 * Find all usage windows ("meters") on the page.
 * A row counts when its label cell is short text and its value cell starts with a percentage
 * ("56.6% used"), or - as a degraded fallback - when the label ends in "usage" (e.g.
 * "Free usage") and the value is something we can't parse; those show their raw text.
 * @param {Document} doc
 * @param {Element|null} skipRow - row already claimed by the credits card
 */
function findMeters(doc, skipRow) {
  const candidates = [];
  for (const row of doc.querySelectorAll(SELECTORS.usageRow)) {
    if (row === skipRow) continue;
    const cells = Array.from(row.children);
    if (cells.length < 2) continue;

    const label = labelOf(cells[0]);
    const value = cells[cells.length - 1].textContent.replace(/\s+/g, ' ').trim();
    if (!label || label.length > 60 || !value || value.length > 40) continue;

    const isPercent = /^\d+(?:\.\d+)?\s*%/.test(value);
    const isRawUsage = !isPercent && /usage$/i.test(label);
    if (isPercent || isRawUsage) candidates.push({ row, label, value, isPercent });
  }

  const allRows = candidates.map((c) => c.row);
  const usedIds = new Set();

  return candidates.map(({ row, label, value, isPercent }) => {
    let id = slugify(label);
    for (let n = 2; usedIds.has(id); n++) id = `${slugify(label)}-${n}`;
    usedIds.add(id);

    return {
      id,
      label,
      usedPercent: isPercent ? extractPercent(value) : null,
      valueText: value,
      ...readReset(nearbyElements(row, SELECTORS.resetTime, allRows)[0] || null),
      models: readModels(nearbyElements(row, SELECTORS.usageSegment, allRows))
    };
  });
}

/**
 * Text of the "Models used this month/week" style heading, if the page has one.
 * @param {Document} doc
 * @returns {string|null}
 */
function findModelsLabel(doc) {
  for (const el of doc.querySelectorAll('h2, h3, h4, p, span, div')) {
    const text = ownText(el);
    if (text.length <= 60 && /^models used/i.test(text)) return text;
  }
  return null;
}

const MAX_RECENT_REQUESTS = 50;

/**
 * The "Recent requests" table: one row per request with its exact time (data-time ISO
 * string), model and cost, newest first, e.g.
 * <tr><td class="local-time" data-time="2026-11-02T18:20:22.145671Z">16 hours ago</td>
 *     <td><div>nemotron-3-ultra</div></td><td>$0.02</td></tr>
 * The trailing "Load more" row has no timestamp and is skipped.
 * @param {Document} doc
 * @returns {Array<{id: string, at: string, model: string, costText: string|null, cost: number|null, costBelow: boolean}>}
 *   `id` is the raw timestamp (unique per request, microsecond precision) for de-duplication.
 */
function findRecentRequests(doc) {
  const heading = Array.from(doc.querySelectorAll(SELECTORS.headings)).find((h) => /^recent requests/i.test(ownText(h)));
  const scope = heading && (heading.closest('section') || heading.parentElement);
  if (!scope) return [];

  const requests = [];
  for (const row of scope.querySelectorAll('tr')) {
    const timeEl = row.querySelector('[data-time]');
    const id = timeEl && timeEl.getAttribute('data-time');
    const ms = id ? Date.parse(id) : NaN;
    if (isNaN(ms)) continue;

    const texts = Array.from(row.children)
      .filter((cell) => cell !== timeEl && !cell.contains(timeEl))
      .map((cell) => cell.textContent.replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    const costText = [...texts].reverse().find((t) => /[$€£]/.test(t)) || null;
    const model = texts.find((t) => t !== costText) || '';
    if (!model) continue;

    const money = costText ? parseMoney(costText) : null;
    requests.push({
      id,
      at: new Date(ms).toISOString(),
      model,
      costText,
      cost: money ? money.amount : null,
      costBelow: costText ? /^</.test(costText) : false
    });
    if (requests.length >= MAX_RECENT_REQUESTS) break;
  }
  return requests;
}

/**
 * Sanitised snapshot of the page's main content (class/style/data-* attributes only, e-mail
 * addresses masked) so an unrecognised layout can be shared and fixed without DevTools.
 * @param {Document} doc
 * @returns {string|null}
 */
function buildDiagnostics(doc) {
  const root = doc.querySelector('main') || doc.body;
  if (!root) return null;

  const clone = root.cloneNode(true);
  clone.querySelectorAll('script, style, svg, img, input, textarea, nav, header, footer').forEach((el) => el.remove());
  clone.querySelectorAll('*').forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      // hx-* (htmx) attributes are kept: they hold the endpoint behind "Load more"
      if (!/^(class|style|data-.*|hx-.*)$/.test(attr.name)) el.removeAttribute(attr.name);
    }
  });

  const html = clone.outerHTML.replace(EMAIL_RE, '***@***');
  return html.length > MAX_DIAGNOSTICS_CHARS ? `${html.slice(0, MAX_DIAGNOSTICS_CHARS)}<!-- truncated -->` : html;
}

/**
 * Result with no data, for error states.
 * @param {string} status
 */
function emptyUsage(status) {
  return { status, tier: null, meters: [], credits: null, modelsLabel: null, models: [], recentRequests: [] };
}

/**
 * Extract all usage data from a parsed document.
 * @param {Document} doc - Parsed HTML document
 * @returns {Object} Parsed usage data
 */
function parseUsageFromDocument(doc) {
  const result = emptyUsage('ok');

  const loginPrompt = doc.querySelector(SELECTORS.loginPrompt);
  if (loginPrompt && loginPrompt.textContent.trim().length > 0) {
    result.status = 'auth_required';
    return result;
  }

  const errorMsg = doc.querySelector(SELECTORS.errorMessage);
  if (errorMsg && errorMsg.textContent.trim().length > 0) {
    result.status = 'network_error';
    return result;
  }

  const { credits, planLabel, row: creditsRow } = findCredits(doc);
  result.credits = credits;
  result.tier = planLabel;
  result.meters = findMeters(doc, creditsRow);
  result.modelsLabel = findModelsLabel(doc);
  result.recentRequests = findRecentRequests(doc);

  // Segments that aren't attached to any usage row (kept as a last resort for the models view)
  if (!result.meters.some((m) => m.models.length > 0)) {
    result.models = readModels(Array.from(doc.querySelectorAll(SELECTORS.usageSegment)));
  }

  // Plan label fallback: a badge span inside a usage heading, e.g. <h2>Cloud usage <span>free</span></h2>
  if (!result.tier) {
    const heading = Array.from(doc.querySelectorAll(SELECTORS.headings)).find((h) => /usage/i.test(h.textContent));
    const badge = heading && heading.querySelector('span');
    const text = badge ? badge.textContent.trim() : '';
    if (text && text.length <= 30) result.tier = text;
  }

  // Nothing recognisable: report it instead of guessing
  if (result.meters.length === 0 && !result.credits) {
    result.status = 'parse_error';
  }

  result.diagnostics = buildDiagnostics(doc);
  return result;
}

// Inline event-handler attributes (onclick="...", onload='...'), matched inside a tag
const INLINE_HANDLER_RE = /(?<=[\s"'/])on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;

/**
 * Remove inline event-handler attributes before parsing. ollama.com's buttons carry
 * onclick="..." handlers, and Chrome reports each one as a Content-Security-Policy violation
 * ("Executing inline event handler violates ... script-src 'self'") the moment DOMParser
 * creates the element inside the extension's page - harmless (never executed) but it fills
 * the extension's error list. We only read text and data-* attributes, never handlers.
 * @param {string} html
 * @returns {string}
 */
function stripInlineHandlers(html) {
  return html.replace(INLINE_HANDLER_RE, '');
}

/**
 * Parse HTML string and extract usage data
 * @param {string} html - Raw HTML from ollama.com/settings
 * @returns {Object} Parsed usage data with status
 */
export function parseUsageHtml(html) {
  if (!html || typeof html !== 'string') {
    return emptyUsage('parse_error');
  }

  let doc;
  try {
    // In browser context (offscreen document), use DOMParser
    if (typeof DOMParser !== 'undefined') {
      const parser = new DOMParser();
      doc = parser.parseFromString(stripInlineHandlers(html), 'text/html');
    } else {
      // Node.js fallback - would need jsdom, but we don't use it here
      // This module is designed for browser use via offscreen document
      throw new Error('DOMParser not available');
    }
  } catch (e) {
    console.error('[parse-usage] Failed to parse HTML:', e);
    return emptyUsage('parse_error');
  }

  return parseUsageFromDocument(doc);
}

/**
 * Convert data stored by v1.0 ({session, weekly}) into the meters shape, so a popup opened
 * before the first post-update refresh doesn't break.
 * @param {Object|null} data
 * @returns {Object|null}
 */
function normalizeUsageData(data) {
  if (!data || Array.isArray(data.meters)) return data || null;

  const fetchedAt = Date.parse(data.lastFetch) || Date.now();
  const meters = [];
  for (const [id, label] of [['session', 'Session usage'], ['weekly', 'Weekly usage']]) {
    const w = data[id];
    if (!w || (w.usedPercent == null && w.resetsInSeconds == null)) continue;
    meters.push({
      id,
      label,
      usedPercent: w.usedPercent ?? null,
      valueText: null,
      resetsAt: w.resetsInSeconds == null ? null : new Date(fetchedAt + w.resetsInSeconds * 1000).toISOString(),
      resetsAtApprox: true,
      refillText: null,
      resetVerb: 'Resets',
      models: w.models || []
    });
  }
  return { ...data, meters, credits: null, modelsLabel: null, models: [], recentRequests: [] };
}

/**
 * The model breakdown to show: the meter with the furthest-away reset (the widest window,
 * e.g. weekly rather than 5h session) that has models, else the page-level segments.
 * @param {Object|null} data - normalized usage data
 * @returns {{meter: Object|null, label: string|null, models: Array<{model: string, requests: number}>}}
 */
function pickModelsSource(data) {
  const withModels = (data?.meters || []).filter((m) => m.models && m.models.length > 0);
  if (withModels.length === 0) {
    return { meter: null, label: data?.modelsLabel || null, models: data?.models || [] };
  }
  const time = (m) => (m.resetsAt ? Date.parse(m.resetsAt) || -Infinity : -Infinity);
  const meter = withModels.reduce((best, m) => (time(m) > time(best) ? m : best));
  return { meter, label: data.modelsLabel || null, models: meter.models };
}

/**
 * Format seconds into human-readable string like "3h 14m"
 * @param {number|null} seconds
 * @returns {string}
 */
function formatResetTime(seconds) {
  if (seconds === null || seconds === undefined || isNaN(seconds)) {
    return 'unknown';
  }
  if (seconds < 0) return 'resetting...';

  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (days > 0 && hours > 0) return `${days}d ${hours}h`;
  if (days > 0) return `${days}d`;
  if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h`;
  if (minutes > 0) return `${minutes}m`;
  return '< 1m';
}

/**
 * Get badge color based on percentage
 * @param {number|null} percent
 * @returns {string} CSS color
 */
function getBadgeColor(percent) {
  if (percent === null) return '#666'; // gray for unknown
  if (percent >= 90) return '#d32f2f'; // red
  if (percent >= 70) return '#f57c00'; // orange/yellow
  return '#388e3c'; // green
}

export {
  SELECTORS,
  stripInlineHandlers,
  extractPercent,
  extractResetSeconds,
  secondsUntil,
  parseMoney,
  emptyUsage,
  normalizeUsageData,
  pickModelsSource,
  formatResetTime,
  getBadgeColor
};
