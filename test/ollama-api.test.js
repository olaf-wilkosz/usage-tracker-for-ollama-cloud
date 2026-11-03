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
  assert.equal(u.modelsLabel, 'Models · last 30 days');
  assert.deepEqual(u.models, [
    { model: 'nemotron-3-ultra', requests: 41, cost: 0.4377 },
    { model: 'web_search', requests: 28, cost: 0.19 }
  ]);
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
  assert.deepEqual(Api.buildUsage(rest).models.at(-1), { model: 'other models', requests: 3, cost: 0.01 });

  // a brand-new account: nothing used yet
  const empty = raw();
  empty.day.buckets = empty.day.buckets.map((b) => ({ ...b, request_count: 0, groups: [] }));
  empty.month.totals = { request_count: 0 };
  const u = Api.buildUsage(empty);
  assert.deepEqual(u.recentHours, []);
  assert.deepEqual(u.models, []);
});

test('buildUsage: unexpected shapes are schema errors, not crashes', () => {
  for (const broken of [
    { ...raw(), balance: null },
    { ...raw(), balance: { included: {}, purchased: { balance_usd: 0 } } },
    { ...raw(), balance: { included: null } },
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
  assert.deepEqual(days, { '2026-10-20': 5, '2026-10-27': 12, '2026-10-28': 30, '2026-11-02': 22 });
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
