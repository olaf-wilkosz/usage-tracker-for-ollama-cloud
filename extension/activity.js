/**
 * Activity history helpers shared by the background worker (which merges what the API
 * reports) and the popup (which renders it as a heatmap). Everything is stored locally.
 *
 * "hours": requests per LOCAL date-hour, e.g. "2026-11-03T14". The API only reports hourly
 * detail for the last 24h, so this series grows as the extension keeps running.
 * "days": requests per day for the last 30 days (days start at 00:00 UTC), available from
 * the very first refresh.
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

/**
 * Whether a local hour lies inside the periods the extension has actually read from the API
 * (a cell outside them is "not recorded yet", not "zero requests"). No list = everything counts as known.
 * @param {Array<[string, string]>|null} covered - [firstHourKey, lastHourKey] pairs
 */
export function isCovered(covered, key) {
  return !covered || covered.some(([from, to]) => key >= from && key <= to);
}

function hourAfter(key) {
  const [day, hour] = key.split('T');
  const [y, m, d] = day.split('-').map(Number);
  return hourKey(new Date(y, m - 1, d, Number(hour) + 1));
}

/** Merge overlapping or touching [from, to] hour-key pairs. */
function mergeIntervals(intervals) {
  const sorted = [...intervals].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const merged = [];
  for (const [from, to] of sorted) {
    const last = merged.at(-1);
    if (last && from <= hourAfter(last[1])) {
      if (to > last[1]) last[1] = to;
    } else {
      merged.push([from, to]);
    }
  }
  return merged;
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
export function buildWeekGrid(buckets, now = new Date(), covered = null) {
  const rows = [];
  let max = 0;
  let total = 0;

  for (let ago = 6; ago >= 0; ago--) {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ago);
    const cells = [];
    for (let hour = 0; hour < 24; hour++) {
      const slot = new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour);
      const value = buckets[hourKey(slot)] || 0;
      cells.push({ hour, value, future: slot > now, known: isCovered(covered, hourKey(slot)) });
      max = Math.max(max, value);
      total += value;
    }
    rows.push({ date, cells });
  }
  return { rows, max, total };
}

/**
 * Last 5 calendar weeks (Monday-first), one cell per day; the last row is the current week.
 * A day shows the larger of the API's daily total and the sum of the hours recorded for it.
 * @param {Object} hours - requests per local date-hour
 * @param {Date} [now]
 * @param {Object} [days] - requests per day as reported by the API
 * @returns {{rows: Array<{start: Date, cells: Array<{date: Date, value: number, future: boolean}>}>, max: number, total: number}}
 */
export function buildMonthGrid(hours, now = new Date(), days = {}, daysFrom = null) {
  const dayTotals = { ...days };
  const fromHours = {};
  for (const [key, value] of Object.entries(hours)) {
    const day = key.slice(0, 10);
    fromHours[day] = (fromHours[day] || 0) + value;
  }
  for (const [day, value] of Object.entries(fromHours)) {
    dayTotals[day] = Math.max(dayTotals[day] || 0, value);
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
      cells.push({ date, value, future: date > today, known: !daysFrom || dayKey(date) >= daysFrom });
      max = Math.max(max, value);
      total += value;
    }
    rows.push({ start, cells });
  }
  return { rows, max, total };
}

/**
 * Merge a fresh API reading into the stored series (the API's numbers replace stored ones
 * for the periods it covers) and drop entries older than the retention window.
 * @param {{hours?: Object, days?: Object}|undefined} stored
 * @param {{hours: Object, days: Object}} fresh
 * @param {Date} [now]
 * @returns {{hours: Object, days: Object}}
 */
export function mergeActivity(stored, fresh, now = new Date()) {
  const cutoff = new Date(now.getTime() - ACTIVITY_RETENTION_DAYS * 86400000);
  const cutoffHour = hourKey(cutoff);
  const cutoffDay = dayKey(cutoff);
  const prune = (series, cutoffKey) => Object.fromEntries(Object.entries(series).filter(([key]) => key >= cutoffKey));

  const hours = prune({ ...stored?.hours, ...fresh.hours }, cutoffHour);
  const days = prune({ ...stored?.days, ...fresh.days }, cutoffDay);
  const result = { hours, days };

  // Which hours / days the series really covers. Data stored before this was tracked is
  // assumed to cover the span it spans.
  let covered = stored?.covered;
  if (!covered) {
    const keys = Object.keys(stored?.hours ?? {}).sort();
    covered = keys.length > 0 ? [[keys[0], keys.at(-1)]] : [];
  }
  if (fresh.coverage) {
    result.covered = mergeIntervals([...covered, [fresh.coverage.hoursFrom, fresh.coverage.hoursTo]])
      .filter(([, to]) => to >= cutoffHour)
      .map(([from, to]) => [from < cutoffHour ? cutoffHour : from, to]);
    const known = [stored?.daysFrom, fresh.coverage.daysFrom].filter(Boolean).sort();
    if (known.length > 0) result.daysFrom = known[0] < cutoffDay ? cutoffDay : known[0];
  } else if (stored?.covered) {
    result.covered = stored.covered;
    if (stored.daysFrom) result.daysFrom = stored.daysFrom;
  }
  return result;
}
