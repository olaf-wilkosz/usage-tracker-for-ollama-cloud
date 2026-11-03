// Integration test of the service worker (background.js) against stubbed chrome.* APIs:
// refresh -> parse (via the offscreen message) -> storage, toolbar icon/badge, notifications,
// request-log activity, error counting and settings migration.
import './support/dom.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as P from '../extension/parse-usage.js';
import * as A from '../extension/activity.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const realFree = fixture('settings-free.html');

// ---------------- background.js integration ----------------

const store = {};
const notes = [];
const icons = [];
const titles = [];
const badge = { text: null, color: null, textColor: null };
let permissionLevel = 'granted';
let currentFetch;
const handlers = {};

const clone = (o) => JSON.parse(JSON.stringify(o));
globalThis.chrome = {
  storage: { local: {
    async get(keys) {
      if (keys == null) return clone(store);
      const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      return Object.fromEntries(list.filter((k) => k in store).map((k) => [k, clone(store[k])]));
    },
    async set(obj) { Object.assign(store, clone(obj)); },
    async clear() { for (const k of Object.keys(store)) delete store[k]; }
  } },
  runtime: {
    lastError: undefined,
    getURL: (p) => p,
    getContexts: async () => [{}],
    sendMessage(msg, cb) { if (msg.type === 'PARSE_USAGE_HTML') cb({ success: true, data: P.parseUsageHtml(msg.html) }); },
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
  },
  offscreen: { createDocument: async () => {} }
};
globalThis.OffscreenCanvas = class {
  constructor(w, h) { this.w = w; this.h = h; }
  getContext() {
    const t = {};
    return new Proxy(t, { get: (o, p) => (p === 'getImageData' ? () => ({ width: this.w, height: this.h }) : (p in o ? o[p] : () => {})), set: (o, p, v) => { o[p] = v; return true; } });
  }
};
globalThis.fetch = async () => currentFetch();

const page = ({ percent, requests, resetsAt, withCredits = true }) => `<html><body><main>
  ${withCredits ? '<div class="flex items-baseline justify-between"><h2>Usage credits<span>Pay as you go</span></h2><span class="tabular-nums">$0</span></div>' : ''}
  ${percent == null ? '' : `<div class="flex justify-between"><span>Free usage</span><span>${percent}% used</span></div>
  <div><button data-usage-segment data-model="gemma4:31b" data-requests="${requests}"></button></div>
  <div class="local-time" data-time="${resetsAt}">Refills in 1 day.</div>`}
</main></body></html>`;
const ok = (html) => () => ({ type: 'basic', status: 200, ok: true, text: async () => html });
const redirect = () => ({ type: 'basic', status: 303, ok: false, text: async () => '' });

await import('../extension/background.js');
const send = (message) => new Promise((resolve) => handlers.message(message, {}, resolve));
const refresh = async () => assert.equal((await send({ type: 'FORCE_REFRESH' })).success, true);
const alerts = () => notes.filter((n) => n.id.startsWith('ollama-usage-free'));

const F1 = new Date(Date.now() + 86400e3).toISOString();
const F2 = new Date(Date.now() + 2 * 86400e3).toISOString();

await test('refresh stores meters/credits and updates icon + tooltip', async () => {
  currentFetch = ok(page({ percent: 85, requests: 10, resetsAt: F1 }));
  await refresh();
  const data = store.ollamaUsageData;
  assert.equal(data.status, 'ok');
  assert.equal(data.meters[0].id, 'free-usage');
  assert.equal(data.credits.text, '$0');
  assert.equal(data.diagnostics, undefined, 'diagnostics split out of usage data');
  assert.ok(store.ollamaDiagnostics.html.includes('Free usage'));
  assert.ok(icons.at(-1).imageData, 'drawn icon set');
  assert.match(titles.at(-1), /Free usage: 85\.0%/);
  assert.match(titles.at(-1), /Credits: \$0/);
  // single window -> percentage in the browser badge (orange at 85%), white text
  assert.deepEqual(badge, { text: '85', color: '#f57c00', textColor: '#ffffff' });
});


await test('warning notification fires once per cycle (no repeat spam)', async () => {
  assert.equal(alerts().length, 1);
  assert.match(alerts()[0].opts.message, /Free usage at 85% \(warning threshold: 80%\)/);
  await refresh(); await refresh();
  assert.equal(alerts().length, 1);
});

await test('escalation warning -> critical notifies once more', async () => {
  currentFetch = ok(page({ percent: 96, requests: 14, resetsAt: F1 }));
  await refresh();
  assert.equal(alerts().length, 2);
  assert.match(alerts()[1].opts.message, /critical threshold: 95%/);
  await refresh();
  assert.equal(alerts().length, 2);
});

await test('new cycle below threshold clears state; crossing again notifies', async () => {
  currentFetch = ok(page({ percent: 5, requests: 2, resetsAt: F2 }));
  await refresh();
  assert.equal(alerts().length, 2);
  assert.deepEqual(store.ollamaNotified, {});
  currentFetch = ok(page({ percent: 90, requests: 6, resetsAt: F2 }));
  await refresh();
  assert.equal(alerts().length, 3);
});

await test('activity: baseline ignored, deltas counted, counter reset handled', async () => {
  const buckets = store.ollamaActivity.requests;
  const total = Object.values(buckets).reduce((a, b) => a + b, 0);
  assert.equal(total, 10, JSON.stringify(buckets)); // 0 + 4 + 2(reset) + 4
  assert.equal(Object.keys(buckets).length, 1, 'all within the current hour');
});

await test('notifications disabled -> none sent', async () => {
  const before = notes.length;
  store.settings = { ...store.settings, notifyEnabled: false };
  currentFetch = ok(page({ percent: 99, requests: 9, resetsAt: F2 }));
  await refresh();
  assert.equal(notes.length, before);
  store.settings = { ...store.settings, notifyEnabled: true };
});

await test('credits-only account (no usage windows): default icon + credits title', async () => {
  currentFetch = ok(page({ percent: null, withCredits: true }));
  await refresh();
  assert.equal(store.ollamaUsageData.status, 'ok');
  assert.equal(store.ollamaUsageData.meters.length, 0);
  assert.ok(icons.at(-1).path, 'static icon');
  assert.equal(titles.at(-1), 'Usage Tracker for Ollama Cloud\nCredits: $0');
  assert.equal(badge.text, '', 'badge cleared');
});

await test('two windows -> concentric rings, badge empty', async () => {
  const two = `<html><body><main><div>
    <div class="flex justify-between"><span>Session usage</span><span>50% used</span></div>
    <div class="local-time" data-time="${F1}">Resets in 3 hours.</div>
    <div class="flex justify-between"><span>Weekly usage</span><span>20% used</span></div>
    <div class="local-time" data-time="${F2}">Resets in 4 days.</div></div></main></body></html>`;
  currentFetch = ok(two);
  await refresh();
  assert.equal(store.ollamaUsageData.meters.length, 2);
  assert.equal(badge.text, '');
  assert.match(titles.at(-1), /Session usage: 50\.0%[\s\S]*Weekly usage: 20\.0%/);
});

await test('persistent error notification fires exactly once after 3 consecutive failures', async () => {
  const errorNotes = () => notes.filter((n) => n.id === 'ollama-usage-persistent-error');
  currentFetch = redirect;
  await refresh();
  assert.equal(store.ollamaUsageData.status, 'auth_required');
  assert.equal(store.ollamaUsageData.meters.length, 0);
  await refresh();
  assert.equal(errorNotes().length, 0);
  await refresh();
  assert.equal(errorNotes().length, 1);
  assert.match(errorNotes()[0].opts.message, /Not logged into Ollama Cloud/);
  await refresh();
  assert.equal(errorNotes().length, 1);
  currentFetch = ok(page({ percent: 10, requests: 1, resetsAt: F2 }));
  await refresh();
  assert.equal(store.ollamaErrorCount, 0);
});

await test('unrecognised page -> parse_error with diagnostics stored', async () => {
  currentFetch = ok('<html><body><main><p>Totally new</p></main></body></html>');
  await refresh();
  assert.equal(store.ollamaUsageData.status, 'parse_error');
  assert.ok(store.ollamaDiagnostics.html.includes('Totally new'));
});

await test('settings: v1.0 stored keys migrate through GET_SETTINGS and onInstalled', async () => {
  store.settings = { refreshIntervalMinutes: 15, notifyThresholdSession: 70, notifyThresholdWeekly: 90, notifyEnabled: true };
  assert.equal((await send({ type: 'GET_SETTINGS' })).settings.notifyWarning, 70);
  currentFetch = ok(page({ percent: 10, requests: 1, resetsAt: F2 }));
  await handlers.installed({ reason: 'update' });
  assert.deepEqual(store.settings, { refreshIntervalMinutes: 15, notifyWarning: 70, notifyCritical: 90, notifyEnabled: true, showPeakBanner: true });
});

await test('real fetched page (with onclick handlers) goes through offscreen parsing', async () => {
  currentFetch = ok(realFree);
  await refresh();
  const d = store.ollamaUsageData;
  assert.equal(d.status, 'ok');
  assert.equal(d.meters[0].usedPercent, 22.4);
  assert.equal(badge.text, '22');
  assert.equal(badge.color, '#388e3c');
  assert.equal(d.recentRequests.length, 3);
});

await test('request log: back-fills once, never double counts, new request adds exactly one', async () => {
  const html = realFree;
  const total = (o) => Object.values(o).reduce((a, b) => a + b, 0);
  store.ollamaActivity = undefined; delete store.ollamaActivity;
  currentFetch = ok(html);
  await refresh();
  assert.equal(total(store.ollamaActivity.log), 3, 'all 3 visible requests back-filled: ' + JSON.stringify(store.ollamaActivity.log));
  assert.equal(store.ollamaActivity.log[A.hourKey(new Date('2026-11-02T18:00:00.000001Z'))], 1);
  assert.equal(store.ollamaActivity.seen.length, 3);
});

await test('request log: repeated readings and a genuinely new request', async () => {
  const html = realFree;
  const total = (o) => Object.values(o).reduce((a, b) => a + b, 0);
  const before = total(store.ollamaActivity.log);
  await refresh(); await refresh();
  assert.equal(total(store.ollamaActivity.log), before, 'same table again -> nothing added');
  const now = new Date();
  const newRow = `<tr><td class="local-time" data-time="${now.toISOString()}">now</td><td><div>gpt-oss:120b</div></td><td>$0.01</td></tr>`;
  currentFetch = ok(html.replace('<tbody>', `<tbody>${newRow}`));
  await refresh(); await refresh();
  assert.equal(total(store.ollamaActivity.log), before + 1);
  assert.equal(store.ollamaActivity.log[A.hourKey(now)], 1);
  assert.equal(store.ollamaActivity.seen[0], now.toISOString(), 'newest id first');
  assert.equal(A.pickActivityBuckets(store.ollamaActivity).kind, 'requests');
  assert.equal(A.pickActivityBuckets(store.ollamaActivity).buckets, store.ollamaActivity.log);
});


await test('model colors read from the page are remembered (and survive an error reading)', async () => {
  currentFetch = ok(realFree);
  await refresh();
  assert.deepEqual(store.ollamaModelColors, { 'nemotron-3-ultra': '#76b900', 'web search': '#22c55e' });

  // a later page with a new model + a changed color: merged, newest wins
  const html = realFree
    .replace('data-model="web search" data-requests="19"', 'data-model="kimi-k3" data-requests="19"')
    .replace('background: #22c55e', 'background: #ec4899');
  currentFetch = ok(html);
  await refresh();
  assert.equal(store.ollamaModelColors['kimi-k3'], '#ec4899');
  assert.equal(store.ollamaModelColors['web search'], '#22c55e', 'older entries are kept');

  // an unreadable page must not wipe what was learned
  currentFetch = redirect;
  await refresh();
  assert.equal(Object.keys(store.ollamaModelColors).length, 3);
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

await test('CLEAR_DATA wipes storage and resets icon', async () => {
  assert.equal((await send({ type: 'CLEAR_DATA' })).success, true);
  assert.deepEqual(Object.keys(store), []);
  assert.ok(icons.at(-1).path);
  assert.equal(titles.at(-1), 'Usage Tracker for Ollama Cloud');
});
