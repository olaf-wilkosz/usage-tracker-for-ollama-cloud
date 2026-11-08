/**
 * Pure helpers of the popup, kept out of popup.js so they can be unit tested without a DOM.
 */

import { modelColor } from './model-colors.js';

export const MAX_LEGEND_ROWS = 6;
export const OTHERS_COLOR = '#8a8a8a';

/** "1 request", "0 requests", "12 requests". */
export function pluralRequests(count) {
  return `${count} request${count === 1 ? '' : 's'}`;
}

/**
 * Legend/donut entries from the model breakdown, busiest first. With more than
 * MAX_LEGEND_ROWS models the tail is folded into one "N other models" entry, so the legend
 * (and the popup) stays a bounded height however many models were used.
 * @param {Array<{model: string, requests: number, cost?: number}>} models - sorted by requests, descending
 * @returns {Array<{label: string, requests: number, cost: number, color: string, members: string|null}>}
 */
export function buildLegendItems(models) {
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

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * "Nov 1–8" or "Oct 10 – Nov 9" for two YYYY-MM-DD UTC days, like the date range on ollama.com's usage page.
 * @returns {string} empty when a day is missing
 */
export function formatDayRange(from, to) {
  if (!from || !to) return '';
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  if (fy === ty && fm === tm) return fd === td ? `${MONTH_NAMES[fm - 1]} ${fd}` : `${MONTH_NAMES[fm - 1]} ${fd}–${td}`;
  return `${MONTH_NAMES[fm - 1]} ${fd} – ${MONTH_NAMES[tm - 1]} ${td}`;
}

/**
 * Rows of a models range. Data stored by an earlier version holds a bare array; the current
 * shape is { from, to, models }.
 * @returns {{from: string|null, to: string|null, models: Array}}
 */
export function rangeEntry(entry) {
  if (Array.isArray(entry)) return { from: null, to: null, models: entry };
  return { from: entry?.from ?? null, to: entry?.to ?? null, models: entry?.models ?? [] };
}

/**
 * The heatmap is visual only (aria-hidden); this sentence carries the same information as text.
 * @param {'week'|'month'} mode
 * @param {number} total - requests in the range
 * @param {{label: string, value: number}|null} busiest - the busiest cell
 */
export function summarizeActivity(mode, total, busiest) {
  const span = mode === 'week' ? 'last 7 days' : 'last 30 days';
  if (!(total > 0) || !busiest) return `No requests in the ${span}.`;
  return `${pluralRequests(Math.round(total))} in the ${span}. Busiest: ${busiest.label}, ${pluralRequests(Math.round(busiest.value))}.`;
}
