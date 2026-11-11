/**
 * Client for the official Ollama API (https://docs.ollama.com/api): the only data source of
 * this extension. Three read-only calls per refresh, authenticated with the user's API key:
 *
 *   GET /api/balance                       included + purchased credits (or legacy session/weekly)
 *   GET /api/usage?range=24h&group_by=model  hourly buckets  -> recent hours + hourly heatmap
 *   GET /api/usage?range=30d&group_by=model  daily buckets   -> model breakdown + daily heatmap
 *
 * The API allows 10 requests per minute per user (shared with the user's other tools);
 * three calls every few minutes stays far below that. Requests never carry cookies.
 */

import { creditsInUse, formatUsd } from './usage.js';

export const API_BASE = 'https://ollama.com/api';
const REQUEST_TIMEOUT_MS = 15000;
const MAX_RECENT_HOURS = 24;
const RECENT_DAYS = 14;

/** Failure talking to the API; `kind` decides how the UI reports it. */
export class ApiError extends Error {
  /**
   * @param {'auth'|'forbidden'|'rate_limited'|'unavailable'|'http'|'network'|'schema'} kind
   * @param {string} message
   * @param {{status?: number, retryAfter?: number}} [extra]
   */
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    this.status = extra.status;
    this.retryAfter = extra.retryAfter;
  }
}

/** Usage-data status shown to the user for each failure kind. */
export function statusForError(error) {
  switch (error?.kind) {
    case 'auth': return 'auth_required';
    case 'forbidden': return 'forbidden';
    case 'rate_limited': return 'rate_limited';
    case 'schema': return 'api_error';
    default: return 'network_error';
  }
}

/**
 * GET a JSON document from the API.
 * @param {string} path - e.g. "/balance"
 * @param {string} key - Ollama API key
 * @returns {Promise<Object>}
 */
export async function apiGet(path, key) {
  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      credentials: 'omit', // the API key is the only credential; never send the browser's cookies
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch (cause) {
    throw new ApiError('network', cause?.name === 'TimeoutError' ? 'Request timed out' : 'Network error');
  }

  if (response.status === 401) throw new ApiError('auth', 'Ollama rejected the API key', { status: 401 });
  if (response.status === 403) throw new ApiError('forbidden', 'Ollama account suspended or access denied', { status: 403 });
  if (response.status === 429) {
    const retryAfter = parseInt(response.headers?.get?.('Retry-After'), 10);
    throw new ApiError('rate_limited', 'Too many requests', { status: 429, retryAfter: retryAfter > 0 ? retryAfter : 60 });
  }
  if (response.status >= 500) throw new ApiError('unavailable', `Ollama API unavailable (HTTP ${response.status})`, { status: response.status });
  if (!response.ok) throw new ApiError('http', `Unexpected HTTP ${response.status}`, { status: response.status });

  try {
    return await response.json();
  } catch {
    throw new ApiError('schema', 'Ollama API returned invalid JSON');
  }
}

/**
 * Fetch everything one refresh needs. The 30-day series only changes meaningfully a few
 * times an hour, so the caller may pass a recent copy and save a third of the requests.
 * @param {string} key
 * @param {Object} [cachedMonth] - a previous /api/usage?range=30d response to reuse
 */
export async function fetchApiData(key, cachedMonth) {
  const [balance, day, month] = await Promise.all([
    apiGet('/balance', key),
    apiGet('/usage?range=24h&group_by=model', key),
    cachedMonth ?? apiGet('/usage?range=30d&group_by=model', key)
  ]);
  return { balance, day, month };
}

const isNumber = (v) => typeof v === 'number' && Number.isFinite(v);
const clampPercent = (v) => Math.max(0, Math.min(100, v));

function schemaError(what) {
  return new ApiError('schema', `Unexpected ${what} in the Ollama API response`);
}

/** Usage meters from /api/balance (included credits, or legacy session + weekly windows). */
function metersFromBalance(included) {
  // No "included" block at all (an account without plan credits): nothing to track, not an error
  if (included === undefined || included === null) return [];
  if (typeof included !== 'object') throw schemaError('"included" balance');

  if (isNumber(included.allowance_usd) && isNumber(included.balance_usd)) {
    // Accounts without included credits (e.g. pay as you go) have no window to track
    if (included.allowance_usd <= 0) return [];
    const used = included.allowance_usd - included.balance_usd;
    return [{
      id: 'included',
      label: 'Included usage',
      usedPercent: clampPercent((used / included.allowance_usd) * 100),
      detail: `${formatUsd(Math.max(0, included.balance_usd))} of ${formatUsd(included.allowance_usd)} left`,
      resetsAt: included.period?.until ?? null,
      resetVerb: 'Refills'
    }];
  }

  const legacy = [['session', 'Session usage'], ['weekly', 'Weekly usage']]
    .filter(([id]) => included[id] && isNumber(included[id].remaining_percent))
    .map(([id, label]) => ({
      id,
      label,
      usedPercent: clampPercent(100 - included[id].remaining_percent),
      detail: null,
      resetsAt: included[id].resets_at ?? null,
      resetVerb: 'Resets'
    }));
  if (legacy.length === 0) throw schemaError('"included" balance');
  return legacy;
}

/** Model rows (busiest first) from a usage period's groups; the API folds the tail into `remainder`. */
function modelsFromTotals(totals) {
  const rows = (totals?.groups ?? []).map((g) => ({
    model: String(g.model),
    requests: g.request_count || 0,
    cost: g.usage_usd || 0
  }));
  const rest = totals?.remainder;
  if (rest && rest.request_count > 0) {
    rows.push({ model: 'other models', requests: rest.request_count, cost: rest.usage_usd || 0 });
  }
  return rows.filter((m) => m.requests > 0).sort((a, b) => b.requests - a.requests);
}

const MIN_SPEND_PER_DAY = 0.005;

/**
 * Average spend per day over the last 7 days plus the part of today that has passed (UTC days).
 * @param {Array} buckets - daily buckets, today last
 * @param {number} now - epoch ms
 */
function dailySpend(buckets, now) {
  const week = buckets.slice(-8);
  const today = week.at(-1);
  if (!today) return 0;
  const elapsed = Math.min(1, Math.max(0, (now - Date.parse(today.from)) / 86400000));
  const days = week.length - 1 + elapsed;
  return days > 0 ? week.reduce((sum, b) => sum + (b.usage_usd || 0), 0) / days : 0;
}

/** The API's 7d range is the last 8 daily buckets (7 days ago at 00:00 UTC up to today). */
const SHORT_RANGE_DAYS = 8;

/** Same rows as modelsFromTotals, summed from daily buckets (so the 7d view needs no extra request). */
function modelsFromBuckets(buckets) {
  const sums = new Map();
  const add = (model, requests, cost) => {
    const row = sums.get(model) ?? { model, requests: 0, cost: 0 };
    row.requests += requests || 0;
    row.cost += cost || 0;
    sums.set(model, row);
  };
  for (const b of buckets) {
    for (const g of b.groups ?? []) add(String(g.model), g.request_count, g.usage_usd);
    if (b.remainder?.request_count > 0) add('other models', b.remainder.request_count, b.remainder.usage_usd);
  }
  return [...sums.values()].filter((m) => m.requests > 0).sort((a, b) => b.requests - a.requests);
}

/** A models range: the UTC days it covers (first and last) plus its rows. */
function rangeOf(buckets, models = modelsFromBuckets(buckets)) {
  return { from: buckets[0]?.from.slice(0, 10) ?? null, to: buckets.at(-1)?.from.slice(0, 10) ?? null, models };
}

/**
 * The three model views, all from the one 30-day response (daily buckets start at 00:00 UTC,
 * so every range is exact): the calendar month so far - what the usage page on ollama.com
 * shows - plus the API's own 7d and 30d ranges.
 */
function modelRanges(month) {
  const days = month.buckets;
  const monthStart = days.length > 0 ? `${days.at(-1).from.slice(0, 7)}-01` : '';
  return {
    month: rangeOf(days.filter((b) => b.from.slice(0, 10) >= monthStart)),
    '7d': rangeOf(days.slice(-SHORT_RANGE_DAYS)),
    '30d': rangeOf(days, modelsFromTotals(month.totals))
  };
}

/**
 * Turn the raw API responses into the extension's usage data (see usage.js).
 * @param {{balance: Object, day: Object, month: Object}} raw
 * @returns {Object} usage data with status "ok" (lastFetch is added by the caller)
 */
export function buildUsage({ balance, day, month }, now = Date.now()) {
  if (!balance || typeof balance !== 'object') throw schemaError('balance');
  if (!Array.isArray(day?.buckets)) throw schemaError('24h usage');
  if (!Array.isArray(month?.buckets)) throw schemaError('30-day usage');

  const meters = metersFromBalance(balance.included);

  const purchased = balance.purchased?.balance_usd;
  const credits = isNumber(purchased) ? { amount: purchased, text: formatUsd(purchased) } : null;

  // How long the purchased balance lasts at the recent pace - once it is what pays for requests:
  // pay as you go (no included credits) or included credits all spent. While included usage is
  // left, the pace says nothing about the purchased balance, which is used second.
  if (credits && creditsInUse(meters) && credits.amount > 0) {
    const perDay = dailySpend(month.buckets, now);
    if (perDay >= MIN_SPEND_PER_DAY) {
      credits.perDay = perDay;
      credits.runwayDays = credits.amount / perDay;
    }
  }

  // The usage page lists requests two weeks back; the API has no per-request detail, so days stand in for them
  const recentDays = month.buckets
    .slice(-RECENT_DAYS)
    .filter((b) => b.request_count > 0)
    .map((b) => ({
      date: b.from.slice(0, 10),
      requests: b.request_count,
      cost: b.usage_usd || 0,
      models: (b.groups ?? []).map((g) => ({ model: String(g.model), requests: g.request_count || 0 }))
    }))
    .reverse(); // newest first

  const recentHours = day.buckets
    .filter((b) => b.request_count > 0)
    .map((b) => ({
      from: b.from,
      requests: b.request_count,
      cost: b.usage_usd || 0,
      models: (b.groups ?? []).map((g) => ({ model: String(g.model), requests: g.request_count || 0 }))
    }))
    .reverse() // newest first
    .slice(0, MAX_RECENT_HOURS);

  return {
    status: 'ok',
    meters,
    credits,
    modelsByRange: modelRanges(month),
    recentHours,
    recentDays
  };
}

const pad = (n) => String(n).padStart(2, '0');

/**
 * Activity series for the popup heatmap: requests per local hour (last 24h, exact) and per
 * day (last 30 days; the API cuts days at 00:00 UTC, which the heatmap shows as-is).
 * @returns {{hours: Object<string, number>, days: Object<string, number>}}
 */
export function extractActivity({ day, month }) {
  const hours = {};
  for (const b of day?.buckets ?? []) {
    const start = new Date(b.from);
    if (isNaN(start) || !(b.request_count > 0)) continue;
    const key = `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}T${pad(start.getHours())}`;
    hours[key] = (hours[key] || 0) + b.request_count;
  }

  const days = {};
  for (const b of month?.buckets ?? []) {
    if (typeof b.from !== 'string' || !(b.request_count > 0)) continue;
    days[b.from.slice(0, 10)] = b.request_count;
  }
  // What the readings cover, so the heatmap can tell "no requests" from "not recorded yet"
  const first = (day?.buckets ?? [])[0];
  const last = (day?.buckets ?? []).at(-1);
  const keyOf = (iso) => {
    const d = new Date(iso);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}`;
  };
  const coverage = first && last && !isNaN(new Date(first.from)) && !isNaN(new Date(last.from))
    ? { hoursFrom: keyOf(first.from), hoursTo: keyOf(last.from), daysFrom: month?.buckets?.[0]?.from?.slice(0, 10) ?? null }
    : null;
  return { hours, days, coverage };
}
