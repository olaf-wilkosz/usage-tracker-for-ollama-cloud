// The Ollama API client: building usage data from real responses, schema edge cases and
// HTTP error mapping.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as Api from '../extension/ollama-api.js';
import * as U from '../extension/usage.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const raw = () => ({
  balance: fixture('balance-free.json'),
  day: fixture('usage-24h-by-model.json'),
  month: fixture('usage-30d-by-model.json')
});

test('buildUsage: Free account from real responses', () => {
  const u = Api.buildUsage(raw());
  assert.equal(u.status, 'ok');
  assert.equal(u.meters.length, 1);
  const [m] = u.meters;
  assert.equal(m.usedPercent.toFixed(2), '22.36');
  assert.equal(m.detail, '$1.94 of $2.50 left');
  assert.equal(m.resetVerb, 'Refills');
  assert.equal(m.resetsAt, '2026-11-04T09:55:26.250918Z');
  assert.deepEqual(u.credits, { amount: 0, text: '$0' });
  assert.deepEqual(u.modelsByRange['30d'].models, [
    { model: 'beam', requests: 73, cost: 0 },
    { model: 'nemotron-3-ultra', requests: 34, cost: 0.3689 },
    { model: 'web_search', requests: 19, cost: 0.19 }
  ]);
  assert.deepEqual([u.modelsByRange['30d'].from, u.modelsByRange['30d'].to], ['2026-10-09', '2026-11-08']);
});

test('buildUsage: the month view equals the usage page on ollama.com ("Nov 1-8, UTC": 95 requests, $0.26)', () => {
  const { month } = Api.buildUsage(raw()).modelsByRange;
  assert.deepEqual([month.from, month.to], ['2026-11-01', '2026-11-08']);
  assert.deepEqual(month.models.map((m) => [m.model, m.requests]), [['beam', 73], ['nemotron-3-ultra', 13], ['web_search', 9]]);
  assert.equal(month.models.reduce((sum, m) => sum + m.requests, 0), 95);
  assert.equal(Math.round(month.models.reduce((sum, m) => sum + m.cost, 0) * 100) / 100, 0.26, 'Total cost');
});

test('buildUsage: month = calendar month so far (UTC), 7d = last 8 days, whatever day it is', () => {
  // daily buckets from Oct 20 to Nov 12, one request per day for "m"
  const buckets = [];
  for (let i = 0; i < 24; i++) {
    const from = new Date(Date.UTC(2026, 9, 20 + i));
    buckets.push({ from: from.toISOString().replace('.000Z', 'Z'), request_count: 1, usage_usd: 0.01, groups: [{ model: 'm', request_count: 1, usage_usd: 0.01 }] });
  }
  const data = { ...raw(), month: { buckets, totals: { request_count: 24, usage_usd: 0.24, groups: [{ model: 'm', request_count: 24, usage_usd: 0.24 }] } } };
  const { month, '7d': week, '30d': thirty } = Api.buildUsage(data).modelsByRange;
  assert.deepEqual([month.from, month.to, month.models[0].requests], ['2026-11-01', '2026-11-12', 12], 'Nov 1 to Nov 12');
  assert.deepEqual([week.from, week.to, week.models[0].requests], ['2026-11-05', '2026-11-12', 8]);
  assert.deepEqual([thirty.from, thirty.to, thirty.models[0].requests], ['2026-10-20', '2026-11-12', 24]);

  // first day of a month: just that day
  const first = { ...data, month: { ...data.month, buckets: buckets.slice(0, 13) } }; // ends Nov 1
  assert.deepEqual([Api.buildUsage(first).modelsByRange.month.from, Api.buildUsage(first).modelsByRange.month.to], ['2026-11-01', '2026-11-01']);
});

test('buildUsage: the 7-day models equal what the API reports for range=7d (real Free account, 2026-11-08)', () => {
  const rows = Api.buildUsage(raw()).modelsByRange['7d'].models.map((m) => [m.model, m.requests, Math.round(m.cost * 1e4) / 1e4]);
  // /api/usage?range=7d returned: beam 73 / $0, nemotron-3-ultra 13 / $0.1677, web_search 9 / $0.09 (95 requests)
  assert.deepEqual(rows, [['beam', 73, 0], ['nemotron-3-ultra', 13, 0.1677], ['web_search', 9, 0.09]]);
  assert.equal(rows.reduce((sum, r) => sum + r[1], 0), 95);
});

test('buildUsage: 7 days is the last 8 daily buckets, with per-day remainders folded in', () => {
  const data = raw();
  const last = data.month.buckets.at(-1);
  last.remainder = { request_count: 2, usage_usd: 0.02 };
  const week = Api.buildUsage(data).modelsByRange['7d'].models;
  assert.deepEqual(week.at(-1), { model: 'other models', requests: 2, cost: 0.02 });
  // the day before the window (2026-11-01 is its first day) must not leak in
  data.month.buckets[data.month.buckets.length - 9].groups = [{ model: 'old-model', request_count: 5, usage_usd: 1 }];
  assert.ok(!Api.buildUsage(data).modelsByRange['7d'].models.some((m) => m.model === 'old-model'));
});

test('buildUsage: recent hours are the non-empty hourly buckets, newest first', () => {
  const { recentHours } = Api.buildUsage(raw());
  assert.deepEqual(recentHours.map((h) => [h.from, h.requests]), [
    ['2026-11-02T18:00:00Z', 1],
    ['2026-11-02T17:00:00Z', 4],
    ['2026-11-02T15:00:00Z', 1],
    ['2026-11-02T14:00:00Z', 16]
  ]);
  assert.deepEqual(recentHours[3].models, [{ model: 'nemotron-3-ultra', requests: 8 }, { model: 'web_search', requests: 8 }]);
  assert.equal(recentHours[3].cost, 0.16532);
});

test('buildUsage: recent days = the non-empty days of the last 14, newest first (the usage page lists requests two weeks back)', () => {
  const { recentDays } = Api.buildUsage(raw());
  assert.deepEqual(recentDays.map((d) => [d.date, d.requests]), [
    ['2026-11-07', 8], ['2026-11-06', 4], ['2026-11-04', 60], ['2026-11-03', 1], ['2026-11-02', 22], ['2026-10-31', 1]
  ]);
  const nov2 = recentDays.find((d) => d.date === '2026-11-02');
  assert.deepEqual(nov2.models, [{ model: 'nemotron-3-ultra', requests: 13 }, { model: 'web_search', requests: 9 }]);
  assert.ok(Math.abs(nov2.cost - 0.2577) < 1e-9);
  assert.ok(!recentDays.some((d) => d.date < '2026-10-26'), 'older than 14 days is left out');
});

test('buildUsage: legacy session + weekly windows', () => {
  const { meters, credits } = Api.buildUsage({ ...raw(), balance: fixture('balance-legacy.json') });
  assert.deepEqual(meters.map((m) => [m.id, m.label, m.usedPercent, m.resetVerb]), [
    ['session', 'Session usage', 25, 'Resets'],
    ['weekly', 'Weekly usage', 60, 'Resets']
  ]);
  assert.equal(meters[0].resetsAt, '2026-10-01T07:00:00Z');
  assert.equal(credits.text, '$25.00');
});

test('buildUsage: edge cases', () => {
  // overspent allowance clamps to 100%, an empty allowance (pay as you go) has no window
  const over = raw();
  over.balance.included = { balance_usd: -0.4, allowance_usd: 2.5, period: { until: 'x' } };
  assert.equal(Api.buildUsage(over).meters[0].usedPercent, 100);
  const payg = raw();
  payg.balance.included = { balance_usd: 0, allowance_usd: 0, period: { until: 'x' } };
  assert.deepEqual(Api.buildUsage(payg).meters, []);

  // the API folds models beyond its top 10 into `remainder`
  const rest = raw();
  rest.month.totals.remainder = { request_count: 3, usage_usd: 0.01, input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 };
  assert.deepEqual(Api.buildUsage(rest).modelsByRange['30d'].models.at(-1), { model: 'other models', requests: 3, cost: 0.01 });

  // a brand-new account: nothing used yet
  const empty = raw();
  empty.day.buckets = empty.day.buckets.map((b) => ({ ...b, request_count: 0, groups: [] }));
  empty.month.totals = { request_count: 0 };
  empty.month.buckets = empty.month.buckets.map((b) => ({ ...b, request_count: 0, groups: [] }));
  const u = Api.buildUsage(empty);
  assert.deepEqual(u.recentHours, []);
  for (const range of Object.values(u.modelsByRange)) assert.deepEqual(range.models, []);
});

test('buildUsage: an account without an included block has no meters but keeps its credits', () => {
  for (const included of [null, undefined]) {
    const data = raw();
    data.balance = { included, purchased: { balance_usd: 3 } };
    const usage = Api.buildUsage(data);
    assert.deepEqual(usage.meters, []);
    assert.equal(usage.credits.amount, 3);
  }
});

test('buildUsage: pay as you go shows how long the credits last at the recent pace', () => {
  // 8 daily buckets ending "today" (2026-11-08, noon UTC => half a day elapsed): $3.00 spent in total
  const data = raw();
  data.balance = { included: { balance_usd: 0, allowance_usd: 0, period: {} }, purchased: { balance_usd: 15 } };
  data.month.buckets = data.month.buckets.map((b) => ({ ...b, usage_usd: 0 }));
  data.month.buckets.at(-1).usage_usd = 0.5;
  data.month.buckets.at(-4).usage_usd = 2.5;
  const noon = Date.parse('2026-11-08T12:00:00Z');
  const { credits } = Api.buildUsage(data, noon);
  assert.ok(Math.abs(credits.perDay - 3 / 7.5) < 1e-9, `perDay ${credits.perDay}`);
  assert.ok(Math.abs(credits.runwayDays - 15 / (3 / 7.5)) < 1e-9);

  // no recent spend, no balance, or included credits: no runway
  data.month.buckets.forEach((b) => { b.usage_usd = 0; });
  assert.equal(Api.buildUsage(data, noon).credits.runwayDays, undefined);
  data.month.buckets.at(-1).usage_usd = 1;
  data.balance.purchased.balance_usd = 0;
  assert.equal(Api.buildUsage(data, noon).credits.runwayDays, undefined);
  data.balance = { included: { balance_usd: 5, allowance_usd: 10, period: {} }, purchased: { balance_usd: 15 } };
  assert.equal(Api.buildUsage(data, noon).credits.runwayDays, undefined, 'the pace does not say how long the purchased part lasts');
  // ... until the included part is all spent: then the purchased credits are what pays
  data.balance = { included: { balance_usd: 0, allowance_usd: 10, period: {} }, purchased: { balance_usd: 15 } };
  data.month.buckets.at(-1).usage_usd = 3;
  assert.ok(Api.buildUsage(data, noon).credits.runwayDays > 0);
});

test('usage helpers: when purchased credits are in use and worth showing', () => {
  const at = (...percents) => percents.map((usedPercent) => ({ usedPercent }));
  assert.equal(U.creditsInUse([]), true, 'pay as you go');
  assert.equal(U.creditsInUse(at(99.9)), false);
  assert.equal(U.creditsInUse(at(100)), true, 'included usage spent');
  assert.equal(U.creditsInUse(at(100, 40)), false, 'one of two windows is still open');
  assert.equal(U.creditsInUse([{ usedPercent: null }]), false, 'unknown: do not guess');
  assert.equal(U.creditsRelevant(null, []), false);
  assert.equal(U.creditsRelevant({ amount: 0 }, at(30)), false, 'included usage left and nothing bought');
  assert.equal(U.creditsRelevant({ amount: 4 }, at(30)), true);
  assert.equal(U.creditsRelevant({ amount: 0 }, at(100)), true, 'nothing left at all');
  assert.equal(U.creditsRelevant({ amount: 0 }, []), true);
});

test('usage helpers: toolbar badge text and colors for a credits balance', () => {
  assert.deepEqual([0, -1, 0.04, 5.43, 9.99, 10, 125.9, 999.9, 1500, 250000].map(U.formatBadgeAmount), ['$0', '$0', '$0.0', '$5.4', '$9.9', '$10', '$125', '$999', '$1k', '$99k']);
  const RED = { color: '#c62828', textColor: '#ffffff' };
  const GRAY = { color: '#5f6368', textColor: '#ffffff' };
  const ORANGE = { color: '#f57c00', textColor: '#1a1a1a' };
  const GREEN = { color: '#2e7d32', textColor: '#ffffff' };
  assert.deepEqual(U.getCreditsBadgeStyle({ amount: 0, lowDays: 3, hadCredits: true }), RED, 'ran out');
  assert.deepEqual(U.getCreditsBadgeStyle({ amount: 0, lowDays: 3, hadCredits: false }), GRAY, 'never had any: a state, not an alarm');
  assert.deepEqual(U.getCreditsBadgeStyle({ amount: 5, runwayDays: 3, lowDays: 3, hadCredits: true }), ORANGE, 'at the level counts as low');
  assert.deepEqual(U.getCreditsBadgeStyle({ amount: 5, runwayDays: 3.01, lowDays: 3, hadCredits: true }), GREEN);
  assert.deepEqual(U.getCreditsBadgeStyle({ amount: 5, lowDays: 3, hadCredits: true }), GREEN, 'no recent spending: nothing to run out of');
  assert.deepEqual(U.getCreditsBadgeStyle({ amount: 1, runwayDays: 0.5, lowDays: 0, hadCredits: true }), GREEN, 'alert off: never orange');
  assert.equal(U.formatRunway(0.4), 'less than a day');
  assert.equal(U.formatRunway(1.5), '1 day');
  assert.equal(U.formatRunway(12.4), '12 days');
  assert.equal(U.formatRunway(89.6), '90 days');
  assert.equal(U.formatRunway(90), '90+ days');
  assert.equal(U.formatRunway(5000), '90+ days');
});

test('buildUsage: unexpected shapes are schema errors, not crashes', () => {
  for (const broken of [
    { ...raw(), balance: null },
    { ...raw(), balance: { included: {}, purchased: { balance_usd: 0 } } },
    { ...raw(), balance: { included: 'nope' } },
    { ...raw(), day: {} },
    { ...raw(), month: { buckets: 'nope' } }
  ]) {
    assert.throws(() => Api.buildUsage(broken), (e) => e instanceof Api.ApiError && e.kind === 'schema');
  }
});

test('extractActivity: hours (local) and days (UTC) with request counts', () => {
  const { hours, days } = Api.extractActivity(raw());
  assert.equal(Object.values(hours).reduce((a, b) => a + b, 0), 22);
  assert.equal(Object.keys(hours).length, 4);
  const first = new Date('2026-11-02T14:00:00Z');
  const key = `${first.getFullYear()}-${String(first.getMonth() + 1).padStart(2, '0')}-${String(first.getDate()).padStart(2, '0')}T${String(first.getHours()).padStart(2, '0')}`;
  assert.equal(hours[key], 16);
  assert.equal(days['2026-11-04'], 60, 'busiest day of the real account');
  assert.equal(days['2026-11-02'], 22);
  assert.equal(Object.values(days).reduce((a, b) => a + b, 0), 126, 'equals the 30d total');
});

test('extractActivity: reports which hours and days the readings cover', () => {
  const { coverage } = Api.extractActivity(raw());
  assert.equal(coverage.daysFrom, '2026-10-09', 'first day of the 30d series');
  const hourKey = (iso) => { const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${String(d.getHours()).padStart(2, '0')}`; };
  assert.equal(coverage.hoursFrom, hourKey('2026-11-02T14:00:00Z'));
  assert.equal(coverage.hoursTo, hourKey('2026-11-03T14:00:00Z'), 'the current (partial) hour is the last');
  assert.equal(Api.extractActivity({ day: { buckets: [] }, month: { buckets: [] } }).coverage, null);
});

test('apiGet: maps HTTP failures to ApiError kinds and statuses', async () => {
  const respond = (status, headers = {}) => async () => ({
    status, ok: status >= 200 && status < 300,
    headers: { get: (n) => headers[n] ?? null },
    json: async () => ({})
  });
  const cases = [
    [respond(401), 'auth', 'auth_required'],
    [respond(403), 'forbidden', 'forbidden'],
    [respond(429, { 'Retry-After': '42' }), 'rate_limited', 'rate_limited'],
    [respond(503), 'unavailable', 'network_error'],
    [respond(418), 'http', 'network_error'],
    [async () => { throw new TypeError('Failed to fetch'); }, 'network', 'network_error'],
    [async () => ({ status: 200, ok: true, headers: { get: () => null }, json: async () => { throw new SyntaxError('bad'); } }), 'schema', 'api_error']
  ];
  for (const [impl, kind, status] of cases) {
    globalThis.fetch = impl;
    await assert.rejects(Api.apiGet('/balance', 'k'), (e) => {
      assert.equal(e.kind, kind);
      assert.equal(Api.statusForError(e), status);
      return true;
    });
  }

  globalThis.fetch = respond(429, { 'Retry-After': '42' });
  await assert.rejects(Api.apiGet('/balance', 'k'), (e) => e.retryAfter === 42);
  globalThis.fetch = respond(429);
  await assert.rejects(Api.apiGet('/balance', 'k'), (e) => e.retryAfter === 60, 'default when the header is missing');
});

test('usage helpers: formatting and accessible colors', () => {
  assert.equal(U.formatUsd(0), '$0');
  assert.equal(U.formatUsd(0.004), '<$0.01');
  assert.equal(U.formatUsd(1.94111), '$1.94');
  assert.equal(U.formatUsd(null), '');
  assert.equal(U.formatResetTime(3 * 86400 + 5 * 3600), '3d 5h');
  assert.equal(U.formatResetTime(30), '< 1m');
  assert.deepEqual(U.getBadgeStyle(50), { color: '#2e7d32', textColor: '#ffffff' });
  assert.equal(U.getBadgeStyle(75).textColor, '#1a1a1a', 'dark text on orange');
});

// WCAG contrast of every color the UI paints text or badges with
function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

test('accessibility: text and badge colors meet WCAG AA (4.5:1)', () => {
  const CARD = '#232428';
  for (const percent of [null, 10, 75, 95]) {
    assert.ok(contrast(U.getTextColor(percent), CARD) >= 4.5, `usage text at ${percent}`);
    const { color, textColor } = U.getBadgeStyle(percent);
    assert.ok(contrast(textColor, color) >= 4.5, `badge text at ${percent}`);
  }
  for (const [name, hex] of Object.entries({ muted: '#9b9ba3', secondary: '#a0a0a0', link: '#64b5f6', red: '#ff6f61', text: '#e8e8e8' })) {
    assert.ok(contrast(hex, CARD) >= 4.5, `${name} on card`);
  }
});
