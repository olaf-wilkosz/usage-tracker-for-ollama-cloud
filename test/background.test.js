// Integration test of the service worker (background.js) against stubbed chrome.* APIs and a
// stubbed Ollama API: key setup -> refresh -> storage, toolbar icon/badge, notifications,
// activity, error handling, key removal and settings migration.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setKeyStorage } from '../extension/secret-store.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const FREE = {
  balance: fixture('balance-free.json'),
  day: fixture('usage-24h-by-model.json'),
  month: fixture('usage-30d-by-model.json')
};
const API_KEY = 'a1b2c3d4e5f60718.AbCdEfGhIjKlMnOpQrStUv';

// In-memory stand-in for the extension's IndexedDB key store
let sealingKey = null;
setKeyStorage({
  async get() { return sealingKey; },
  async put(key) { sealingKey = key; },
  async delete() { sealingKey = null; }
});

const store = {};
const notes = [];
const icons = [];
const titles = [];
const badge = { text: null, color: null, textColor: null };
let permissionLevel = 'granted';
const handlers = {};
let openedOptions = 0;

const clone = (o) => JSON.parse(JSON.stringify(o));
globalThis.chrome = {
  storage: { local: {
    async get(keys) {
      if (keys == null) return clone(store);
      const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      return Object.fromEntries(list.filter((k) => k in store).map((k) => [k, clone(store[k])]));
    },
    async set(obj) { Object.assign(store, clone(obj)); },
    async remove(keys) { for (const k of [].concat(keys)) delete store[k]; },
    async clear() { for (const k of Object.keys(store)) delete store[k]; }
  } },
  runtime: {
    id: 'test-extension',
    lastError: undefined,
    getURL: (p) => p,
    openOptionsPage: () => { openedOptions++; },
    onMessage: { addListener: (fn) => { handlers.message = fn; } },
    onInstalled: { addListener: (fn) => { handlers.installed = fn; } },
    onStartup: { addListener: (fn) => { handlers.startup = fn; } }
  },
  alarms: { create: async () => {}, onAlarm: { addListener: (fn) => { handlers.alarm = fn; } } },
  action: {
    setBadgeText: async ({ text }) => { badge.text = text; },
    setBadgeBackgroundColor: async ({ color }) => { badge.color = color; },
    setBadgeTextColor: async ({ color }) => { badge.textColor = color; },
    setIcon: async (a) => { icons.push(a); },
    setTitle: async ({ title }) => { titles.push(title); }
  },
  notifications: {
    create: async (id, opts) => { notes.push({ id, opts }); },
    clear: async () => {},
    getPermissionLevel: async () => permissionLevel
  }
};
globalThis.OffscreenCanvas = class {
  constructor(w, h) { this.w = w; this.h = h; }
  getContext() {
    const t = {};
    return new Proxy(t, { get: (o, p) => (p === 'getImageData' ? () => ({ width: this.w, height: this.h }) : (p in o ? o[p] : () => {})), set: (o, p, v) => { o[p] = v; return true; } });
  }
};

// ---- stubbed Ollama API ----
let world = { ...FREE };   // what the API currently returns
let failWith = null;       // { status, headers } or 'network' to fail every call
let validKey = API_KEY;    // the key the API accepts
let gate = null;           // when set, API calls wait for it (to hold a refresh in flight)
const calls = [];

const respond = (status, body, headers = {}) => ({
  status, ok: status >= 200 && status < 300,
  headers: { get: (name) => headers[name] ?? null },
  json: async () => body
});
globalThis.fetch = async (url, init) => {
  calls.push({ url, init });
  if (gate) await gate;
  if (failWith === 'network') throw new TypeError('Failed to fetch');
  if (init.headers.Authorization !== `Bearer ${validKey}`) return respond(401, { error: 'unauthorized' });
  if (failWith) return respond(failWith.status, { error: 'failure' }, failWith.headers);
  if (url.endsWith('/balance')) return respond(200, world.balance);
  if (url.includes('range=24h')) return respond(200, world.day);
  if (url.includes('range=30d')) return respond(200, world.month);
  return respond(404, {});
};

await import('../extension/background.js');
const send = (message) => new Promise((resolve) => handlers.message(message, {}, resolve));
const refresh = async () => assert.equal((await send({ type: 'FORCE_REFRESH' })).success, true);
const alerts = () => notes.filter((n) => n.id === 'ollama-usage-included');

/** Balance with `percent` of a $100 allowance used, in the cycle ending at `until`. */
const balanceUsed = (percent, until = '2026-12-01T00:00:00Z') => ({
  included: { balance_usd: 100 - percent, allowance_usd: 100, period: { from: '2026-11-01T00:00:00Z', until } },
  purchased: { balance_usd: 0 }
});

await test('before setup: refresh reports no_key and the toolbar nudges to connect', async () => {
  await refresh();
  assert.equal(store.ollamaUsageData.status, 'no_key');
  assert.equal(calls.length, 0, 'no request without a key');
  assert.equal(badge.text, '!');
  assert.equal(badge.textColor, '#1a1a1a');
  assert.match(titles.at(-1), /connect your Ollama account/);
  assert.equal(store.ollamaErrorCount, 0, 'not set up is not an error');
  assert.deepEqual(await send({ type: 'GET_KEY_STATE' }), { hasKey: false, status: 'no_key' });
});

await test('first install: setup opens in the popup when the browser allows it, else as a welcome tab', async () => {
  // no action.openPopup in the stub (like Firefox, which refuses it without a click): welcome tab
  await handlers.installed({ reason: 'install' });
  assert.equal(openedOptions, 1);
  await handlers.installed({ reason: 'update' });
  assert.equal(openedOptions, 1, 'updates do not');

  let popups = 0;
  chrome.action.openPopup = async () => { popups++; };
  await handlers.installed({ reason: 'install' });
  assert.equal(popups, 1);
  assert.equal(openedOptions, 1, 'no extra tab when the popup opened');

  chrome.action.openPopup = async () => { throw new Error('No active browser window'); };
  await handlers.installed({ reason: 'install' });
  assert.equal(openedOptions, 2, 'refused popup falls back to the tab');

  // accepted but nothing appeared (no focused window): where the popup can be queried, fall back too
  chrome.runtime.getContexts = async () => [];
  chrome.action.openPopup = async () => { popups++; };
  await handlers.installed({ reason: 'install' });
  assert.equal(openedOptions, 3, 'a popup that never showed up falls back to the tab');
  chrome.runtime.getContexts = async () => [{}];
  await handlers.installed({ reason: 'install' });
  assert.equal(openedOptions, 3, 'a visible popup does not');
  delete chrome.runtime.getContexts;
  delete chrome.action.openPopup;
});

await test('saving a key: format check, rejected key, then accepted and sealed', async () => {
  assert.equal((await send({ type: 'SAVE_API_KEY', key: '  ' })).success, false);
  assert.equal((await send({ type: 'SAVE_API_KEY', key: 'has space inside key' })).success, false);

  const rejected = await send({ type: 'SAVE_API_KEY', key: 'wrong-key-1234567890' });
  assert.equal(rejected.success, false);
  assert.match(rejected.error, /rejected this key/);
  assert.equal(store.ollamaApiKey, undefined, 'a rejected key is not stored');

  const accepted = await send({ type: 'SAVE_API_KEY', key: `  ${API_KEY}\n` });
  assert.deepEqual(accepted, { success: true });
  assert.ok(store.ollamaApiKey.ct, 'sealed blob stored');
  assert.ok(!JSON.stringify(store).includes(API_KEY), 'the key is nowhere in storage in the clear');
  assert.deepEqual(await send({ type: 'GET_KEY_STATE' }), { hasKey: true, status: 'ok' });
});

await test('requests go to the three API endpoints with the key and without cookies', async () => {
  const mine = calls.filter((c) => c.init.headers.Authorization === `Bearer ${API_KEY}`).slice(-3);
  assert.deepEqual(mine.map((c) => c.url).sort(), [
    'https://ollama.com/api/balance',
    'https://ollama.com/api/usage?range=24h&group_by=model',
    'https://ollama.com/api/usage?range=30d&group_by=model'
  ]);
  for (const c of mine) {
    assert.equal(c.init.credentials, 'omit');
    assert.equal(c.init.method, 'GET');
    assert.equal(c.init.referrerPolicy, 'no-referrer');
  }
});

await test('real Free-account responses: meter, credits, models, recent hours, icon + badge', async () => {
  const data = store.ollamaUsageData;
  assert.equal(data.status, 'ok');
  assert.equal(data.meters.length, 1);
  assert.equal(data.meters[0].id, 'included');
  assert.equal(data.meters[0].usedPercent.toFixed(1), '22.4');
  assert.equal(data.meters[0].detail, '$1.94 of $2.50 left');
  assert.equal(data.meters[0].resetsAt, '2026-11-04T09:55:26.250918Z');
  assert.equal(data.credits.text, '$0');
  assert.deepEqual(data.modelsByRange['30d'].map((m) => m.model), ['beam', 'nemotron-3-ultra', 'web_search']);
  assert.deepEqual(data.modelsByRange['7d'].map((m) => [m.model, m.requests]), [['beam', 73], ['nemotron-3-ultra', 13], ['web_search', 9]]);
  assert.equal(data.recentHours.length, 4);
  assert.equal(data.recentHours[0].from, '2026-11-02T18:00:00Z', 'newest first');
  assert.ok(store.ollamaDiagnostics.text.includes('"balance_usd":1.94111'));
  assert.ok(!store.ollamaDiagnostics.text.includes(API_KEY), 'diagnostics never contain the key');

  assert.ok(icons.at(-1).imageData, 'drawn icon set');
  assert.match(titles.at(-1), /Included usage: 22\.4%/);
  assert.match(titles.at(-1), /Credits: \$0/);
  assert.deepEqual(badge, { text: '22', color: '#2e7d32', textColor: '#ffffff' });
});

await test('the 30-day series is reused for 10 minutes, then fetched again', async () => {
  const before = calls.length;
  await refresh();
  const urls = calls.slice(before).map((c) => c.url);
  assert.deepEqual(urls.sort(), ['https://ollama.com/api/balance', 'https://ollama.com/api/usage?range=24h&group_by=model'], 'balance + 24h only');
  assert.equal(store.ollamaUsageData.modelsByRange['30d'].length, 3, 'models still come from the cached series');

  store.ollamaMonthCache = { ...store.ollamaMonthCache, at: Date.now() - 11 * 60e3 };
  const stale = calls.length;
  await refresh();
  assert.ok(calls.slice(stale).some((c) => c.url.includes('range=30d')), 'refetched once the copy is older than 10 minutes');
});

await test('activity: hourly requests from the 24h reading, daily totals from the 30d reading', async () => {
  const { hours, days } = store.ollamaActivity;
  assert.equal(Object.values(hours).reduce((a, b) => a + b, 0), 22);
  assert.equal(days['2026-11-02'], 22);
  assert.equal(days['2026-11-04'], 60);
  const before = JSON.stringify(store.ollamaActivity);
  await refresh();
  assert.equal(JSON.stringify(store.ollamaActivity), before, 'reading again does not double count');
});

await test('warning notification fires once per cycle; escalation and new cycle notify again', async () => {
  assert.equal(alerts().length, 0, 'Free account at 22% is quiet');
  world = { ...FREE, balance: balanceUsed(85) };
  await refresh();
  assert.equal(alerts().length, 1);
  assert.match(alerts()[0].opts.message, /Included usage at 85% \(warning threshold: 80%\)/);
  await refresh(); await refresh();
  assert.equal(alerts().length, 1, 'no repeat spam');

  world = { ...FREE, balance: balanceUsed(96) };
  await refresh();
  assert.equal(alerts().length, 2);
  assert.match(alerts()[1].opts.message, /critical threshold: 95%/);
  await refresh();
  assert.equal(alerts().length, 2);

  world = { ...FREE, balance: balanceUsed(5, '2027-01-01T00:00:00Z') }; // refilled
  await refresh();
  assert.deepEqual(store.ollamaNotified, {});
  world = { ...FREE, balance: balanceUsed(90, '2027-01-01T00:00:00Z') };
  await refresh();
  assert.equal(alerts().length, 3);
  assert.equal(badge.color, '#c62828', '90% -> red badge with white text');
});

await test('notifications disabled -> none sent', async () => {
  const before = notes.length;
  store.settings = { ...store.settings, notifyEnabled: false };
  world = { ...FREE, balance: balanceUsed(99, '2027-02-01T00:00:00Z') };
  await refresh();
  assert.equal(notes.length, before);
  store.settings = { ...store.settings, notifyEnabled: true };
});

await test('pay-as-you-go account (no included credits): default icon + credits title', async () => {
  world = { ...FREE, balance: { included: { balance_usd: 0, allowance_usd: 0, period: { from: 'a', until: 'b' } }, purchased: { balance_usd: 12.5 } } };
  await refresh();
  assert.equal(store.ollamaUsageData.meters.length, 0);
  assert.equal(store.ollamaUsageData.credits.text, '$12.50');
  assert.ok(icons.at(-1).path, 'static icon');
  assert.equal(titles.at(-1), 'Usage Tracker for Ollama Cloud\nCredits: $12.50');
  assert.equal(badge.text, '', 'badge cleared');
});

await test('legacy plan (session + weekly) -> concentric rings, badge empty', async () => {
  world = { ...FREE, balance: fixture('balance-legacy.json') };
  await refresh();
  assert.deepEqual(store.ollamaUsageData.meters.map((m) => [m.id, m.usedPercent]), [['session', 25], ['weekly', 60]]);
  assert.equal(store.ollamaUsageData.meters[0].resetVerb, 'Resets');
  assert.equal(badge.text, '');
  assert.match(titles.at(-1), /Session usage: 25\.0%[\s\S]*Weekly usage: 60\.0%/);
});

await test('network trouble keeps the last good data (flagged stale); persistent notice after 3 failures', async () => {
  world = { ...FREE };
  await refresh();
  const good = store.ollamaUsageData;
  const errorNotes = () => notes.filter((n) => n.id === 'ollama-usage-persistent-error');

  failWith = 'network';
  await refresh();
  assert.equal(store.ollamaUsageData.status, 'network_error');
  assert.equal(store.ollamaUsageData.stale, true);
  assert.deepEqual(store.ollamaUsageData.meters, good.meters, 'numbers stay on screen');
  assert.equal(store.ollamaUsageData.lastFetch, good.lastFetch, 'last SUCCESSFUL read time is kept');
  await refresh();
  assert.equal(errorNotes().length, 0);
  await refresh();
  assert.equal(errorNotes().length, 1);
  assert.match(errorNotes()[0].opts.message, /Could not reach the Ollama API/);
  await refresh();
  assert.equal(errorNotes().length, 1, 'only once');

  failWith = null;
  await refresh();
  assert.equal(store.ollamaUsageData.status, 'ok');
  assert.equal(store.ollamaUsageData.stale, undefined);
  assert.equal(store.ollamaErrorCount, 0);
});

await test('rate limit (429): last data stays, no request is made until Retry-After has passed', async () => {
  failWith = { status: 429, headers: { 'Retry-After': '30' } };
  await refresh();
  assert.equal(store.ollamaUsageData.status, 'rate_limited');
  assert.equal(store.ollamaUsageData.stale, true);
  const wait = store.ollamaBackoffUntil - Date.now();
  assert.ok(wait > 25e3 && wait <= 30e3, 'backoff of about 30 s: ' + wait);

  failWith = null;
  const before = calls.length;
  await refresh();
  assert.equal(calls.length, before, 'nothing is sent while backing off');
  assert.equal(store.ollamaUsageData.status, 'rate_limited');
  assert.equal(store.ollamaUsageData.stale, true);

  store.ollamaBackoffUntil = Date.now() - 1; // Retry-After elapsed
  await refresh();
  assert.equal(store.ollamaUsageData.status, 'ok');
  assert.ok(calls.length > before);
});

await test('server errors (503) are transient too', async () => {
  failWith = { status: 503, headers: {} };
  await refresh();
  assert.equal(store.ollamaUsageData.status, 'network_error');
  assert.ok(!(store.ollamaBackoffUntil > Date.now()), 'only 429 backs off');
  failWith = null;
  await refresh();
  assert.equal(store.ollamaUsageData.status, 'ok');
});

await test('revoked key (401) -> auth_required, empty data, setup badge; recovers when a new key is saved', async () => {
  validKey = 'some-other-key-0000';
  await refresh();
  assert.equal(store.ollamaUsageData.status, 'auth_required');
  assert.deepEqual(store.ollamaUsageData.meters, []);
  assert.equal(badge.text, '!');
  assert.match(titles.at(-1), /rejected the API key/);

  validKey = 'brand-new-key-123456789';
  assert.deepEqual(await send({ type: 'SAVE_API_KEY', key: validKey }), { success: true });
  assert.equal(store.ollamaUsageData.status, 'ok');
  assert.equal(badge.text, '22');
});

await test('unexpected API response -> api_error with the raw responses kept for diagnostics', async () => {
  world = { ...FREE, balance: { included: { surprise: true }, purchased: {} } };
  await refresh();
  assert.equal(store.ollamaUsageData.status, 'api_error');
  assert.ok(store.ollamaDiagnostics.text.includes('surprise'));
  world = { ...FREE };
  await refresh();
});

await test('settings: v1.0 stored keys migrate through GET_SETTINGS and onInstalled', async () => {
  store.settings = { refreshIntervalMinutes: 15, notifyThresholdSession: 70, notifyThresholdWeekly: 90, notifyEnabled: true };
  assert.equal((await send({ type: 'GET_SETTINGS' })).settings.notifyWarning, 70);
  await handlers.installed({ reason: 'update' });
  assert.deepEqual(store.settings, { refreshIntervalMinutes: 15, notifyWarning: 70, notifyCritical: 90, notifyEnabled: true, showPeakBanner: true });
});

await test('test notification: sent when granted, reported (not sent) when the browser blocks it', async () => {
  const before = notes.length;
  const ok1 = await send({ type: 'TEST_NOTIFICATION' });
  assert.deepEqual(ok1, { success: true, level: 'granted' });
  assert.equal(notes.length, before + 1);
  assert.equal(notes.at(-1).id, 'ollama-usage-test');

  permissionLevel = 'denied';
  const blocked = await send({ type: 'TEST_NOTIFICATION' });
  assert.equal(blocked.success, false);
  assert.equal(blocked.level, 'denied');
  assert.match(blocked.error, /blocked/);
  assert.equal(notes.length, before + 1, 'nothing shown while blocked');
  permissionLevel = 'granted';

  // works even with notifications switched off in the settings
  store.settings = { ...store.settings, notifyEnabled: false };
  assert.equal((await send({ type: 'TEST_NOTIFICATION' })).success, true);
});

await test('removing the key forgets it and everything read with it, but keeps settings and activity', async () => {
  assert.ok(store.ollamaActivity);
  assert.deepEqual(await send({ type: 'REMOVE_API_KEY' }), { success: true });
  assert.equal(store.ollamaApiKey, undefined);
  assert.equal(sealingKey, null, 'sealing key destroyed');
  assert.equal(store.ollamaUsageData.status, 'no_key');
  assert.equal(store.ollamaDiagnostics, undefined);
  assert.ok(store.settings && store.ollamaActivity);
  assert.equal(badge.text, '!');
  assert.deepEqual(await send({ type: 'GET_KEY_STATE' }), { hasKey: false, status: 'no_key' });

  const callsBefore = calls.length;
  await refresh();
  assert.equal(calls.length, callsBefore, 'no API traffic without a key');
});

await test('CLEAR_DATA wipes storage and resets icon', async () => {
  assert.deepEqual(await send({ type: 'SAVE_API_KEY', key: validKey }), { success: true });
  assert.equal((await send({ type: 'CLEAR_DATA' })).success, true);
  assert.deepEqual(Object.keys(store), []);
  assert.equal(sealingKey, null);
  assert.ok(icons.at(-1).path);
  assert.equal(titles.at(-1), 'Usage Tracker for Ollama Cloud');
});

await test('removing the key while a refresh is in flight: the stale result is discarded', async () => {
  assert.deepEqual(await send({ type: 'SAVE_API_KEY', key: validKey }), { success: true });
  assert.equal(store.ollamaUsageData.status, 'ok');

  let release;
  gate = new Promise((resolve) => { release = resolve; });
  const inFlight = send({ type: 'FORCE_REFRESH' });       // held inside the API calls with the old key
  await new Promise((resolve) => setTimeout(resolve, 30));
  await send({ type: 'REMOVE_API_KEY' });
  gate = null;
  release();
  await inFlight;

  assert.equal(store.ollamaUsageData.status, 'no_key', 'the old key\'s data must not come back');
  assert.equal(store.ollamaApiKey, undefined);
  assert.equal(badge.text, '!');
});

await test('saving a key while a refresh without a key runs: data of the new key ends up shown', async () => {
  let release;
  gate = new Promise((resolve) => { release = resolve; });
  // a refresh with no key never calls the API, so hold the save's own validation call instead
  const saving = send({ type: 'SAVE_API_KEY', key: validKey });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const alarm = send({ type: 'FORCE_REFRESH' });           // no key stored yet: reports no_key
  gate = null;
  release();
  await Promise.all([saving, alarm]);
  assert.equal(store.ollamaUsageData.status, 'ok');
  assert.equal(badge.text, '22');
});
