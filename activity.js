/**
 * Activity history helpers shared by the background worker (which records hourly buckets)
 * and the popup (which renders them as a heatmap). Everything is stored and computed locally.
 *
 * Buckets are keyed by LOCAL date-hour, e.g. "2026-11-03T14" -> amount of activity seen
 * during that hour (requests, or percentage points when the page has no request counts).
 */

export const ACTIVITY_RETENTION_DAYS = 35;

const pad = (n) => String(n).padStart(2, '0');

/** Local calendar day key, e.g. "2026-11-03" */
export function dayKey(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Local date-hour key, e.g. "2026-11-03T14" */
export function hourKey(date) {
  return `${dayKey(date)}T${pad(date.getHours())}`;
}

function sumValues(buckets) {
  return Object.values(buckets || {}).reduce((sum, v) => sum + (v || 0), 0);
}

/**
 * Pick which recorded series to show, best first: the request log (one entry per request
 * with its exact time, read from the "Recent requests" table), then request-count deltas
 * between readings, then percentage-point deltas.
 * @param {{log?: Object, requests?: Object, percent?: Object}|undefined} activity
 * @returns {{kind: 'requests'|'percent', buckets: Object}}
 */
export function pickActivityBuckets(activity) {
  const log = activity?.log || {};
  if (sumValues(log) > 0) return { kind: 'requests', buckets: log };

  const requests = activity?.requests || {};
  const percent = activity?.percent || {};
  return sumValues(requests) > 0 || sumValues(percent) === 0
    ? { kind: 'requests', buckets: requests }
    : { kind: 'percent', buckets: percent };
}

/** Heat level 0 (none) .. 4 (busiest) for a value relative to the busiest cell. */
export function heatLevel(value, max) {
  if (!(value > 0) || !(max > 0)) return 0;
  return Math.min(4, Math.max(1, Math.ceil((value / max) * 4)));
}

/**
 * Last 7 days x 24 hours, oldest day first (today is the last row).
 * @param {Object} buckets
 * @param {Date} [now]
 * @returns {{rows: Array<{date: Date, cells: Array<{hour: number, value: number, future: boolean}>}>, max: number, total: number}}
 */
export function buildWeekGrid(buckets, now = new Date()) {
  const rows = [];
  let max = 0;
  let total = 0;

  for (let ago = 6; ago >= 0; ago--) {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ago);
    const cells = [];
    for (let hour = 0; hour < 24; hour++) {
      const slot = new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour);
      const value = buckets[hourKey(slot)] || 0;
      cells.push({ hour, value, future: slot > now });
      max = Math.max(max, value);
      total += value;
    }
    rows.push({ date, cells });
  }
  return { rows, max, total };
}

/**
 * Last 5 calendar weeks (Monday-first), one cell per day; the last row is the current week.
 * @param {Object} buckets
 * @param {Date} [now]
 * @returns {{rows: Array<{start: Date, cells: Array<{date: Date, value: number, future: boolean}>}>, max: number, total: number}}
 */
export function buildMonthGrid(buckets, now = new Date()) {
  const dayTotals = {};
  for (const [key, value] of Object.entries(buckets)) {
    const day = key.slice(0, 10);
    dayTotals[day] = (dayTotals[day] || 0) + value;
  }

  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const mondayThisWeek = new Date(today.getFullYear(), today.getMonth(), today.getDate() - ((today.getDay() + 6) % 7));
  const rows = [];
  let max = 0;
  let total = 0;

  for (let week = 4; week >= 0; week--) {
    const start = new Date(mondayThisWeek.getFullYear(), mondayThisWeek.getMonth(), mondayThisWeek.getDate() - week * 7);
    const cells = [];
    for (let i = 0; i < 7; i++) {
      const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      const value = dayTotals[dayKey(date)] || 0;
      cells.push({ date, value, future: date > today });
      max = Math.max(max, value);
      total += value;
    }
    rows.push({ start, cells });
  }
  return { rows, max, total };
}
