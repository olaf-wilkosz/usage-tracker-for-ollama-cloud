// Parser tests on jsdom: the real ollama.com markup (sanitised fixtures) plus degraded layouts.
import './support/dom.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as P from '../parse-usage.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const credits = fixture('settings-credits.html');
const realFree = fixture('settings-free.html');
const inHours = (h) => new Date(Date.now() + h * 3600e3).toISOString();

// ---- time-text parsing ----
test('extractResetSeconds: day / refills / hours+minutes / compact', () => {
  assert.equal(P.extractResetSeconds('Refills in 1 day.'), 86400);
  assert.equal(P.extractResetSeconds('Resets in 5 hours 30 minutes'), 19800);
  assert.equal(P.extractResetSeconds('3h 14m'), 3 * 3600 + 14 * 60);
  assert.equal(P.extractResetSeconds('resets in an hour'), 3600);
  assert.equal(P.extractResetSeconds('Renews in 2 weeks'), 14 * 86400);
  assert.equal(P.extractResetSeconds('Resets in 45 seconds'), 45);
  assert.equal(P.extractResetSeconds('nothing here'), null);
});

test('parseMoney', () => {
  assert.deepEqual(P.parseMoney('$0'), { amount: 0, currency: '$' });
  assert.deepEqual(P.parseMoney('$1,234.50'), { amount: 1234.5, currency: '$' });
  assert.deepEqual(P.parseMoney('12,50 €'), { amount: 12.5, currency: '€' });
  assert.equal(P.parseMoney('hello'), null);
});

// ---- the REAL pages (user-pasted) ----
test('real Free-usage page: meter, credits, plan, models, exact refill time', () => {
  const r = P.parseUsageHtml(realFree);
  assert.equal(r.status, 'ok');
  assert.equal(r.tier, 'Pay as you go');
  assert.deepEqual(r.credits, { text: '$0', amount: 0, currency: '$' });
  assert.equal(r.meters.length, 1, JSON.stringify(r.meters.map((m) => m.label)));
  const m = r.meters[0];
  assert.equal(m.id, 'free-usage');
  assert.equal(m.usedPercent, 22.4);
  assert.equal(m.resetsAt, '2026-11-04T10:00:00.000Z');
  assert.equal(m.resetsAtApprox, false);
  assert.equal(m.resetVerb, 'Refills');
  assert.deepEqual(m.models, [{ model: 'nemotron-3-ultra', requests: 34, color: '#76b900' }, { model: 'web search', requests: 19, color: '#22c55e' }]);
  assert.equal(r.modelsLabel, 'Models used this month');
  assert.equal(P.pickModelsSource(r).label, 'Models used this month');
});

test('real page: Recent requests table parsed (exact times, model, cost; Load more row skipped)', () => {
  const r = P.parseUsageHtml(realFree);
  assert.equal(r.recentRequests.length, 3);
  assert.deepEqual(r.recentRequests[0], {
    id: '2026-11-02T18:00:00.000001Z', at: '2026-11-02T18:00:00.000Z', model: 'nemotron-3-ultra',
    costText: '$0.02', cost: 0.02, costBelow: false });
  assert.equal(r.recentRequests[1].model, 'web search');
  assert.equal(r.recentRequests[2].costText, '<$0.01');
  assert.equal(r.recentRequests[2].costBelow, true);
  assert.equal(r.recentRequests[2].cost, 0.01);
  // pages without the table
  assert.deepEqual(P.parseUsageHtml(credits).recentRequests, []);
});

test('request table: rows without timestamp / model are ignored, cost optional', () => {
  const html = `<html><body><main><div class="flex justify-between"><span>Free usage</span><span>1% used</span></div>
    <section><h2>Recent requests</h2><table><tbody>
      <tr><td class="local-time" data-time="2026-11-02T10:00:00Z">x</td><td>kimi-k3</td></tr>
      <tr><td class="local-time" data-time="bad">x</td><td>nope</td><td>$1</td></tr>
      <tr><td class="local-time" data-time="2026-11-02T11:00:00Z">x</td></tr>
      <tr><td><button>Load more</button></td></tr></tbody></table></section></main></body></html>`;
  const r = P.parseUsageHtml(html);
  assert.equal(r.recentRequests.length, 1);
  assert.equal(r.recentRequests[0].model, 'kimi-k3');
  assert.equal(r.recentRequests[0].costText, null);
  assert.equal(r.recentRequests[0].cost, null);
});

test('diagnostics keep hx-* attributes (Load more endpoint) but drop other attributes', () => {
  const html = `<html><body><main><button hx-get="/settings/requests?before=1" onclick="x()" href="/secret" id="b" class="c">Load more</button></main></body></html>`;
  const d = P.parseUsageHtml(html).diagnostics;
  assert.ok(d.includes('hx-get="/settings/requests?before=1"'));
  assert.ok(!d.includes('id="b"') && !d.includes('href') && !d.includes('onclick'));
});

test('inline onclick handlers are stripped before parsing (CSP noise) without harming data', () => {
  assert.ok(/onclick=/.test(realFree), 'fixture must contain handlers');
  const out = P.stripInlineHandlers(realFree);
  assert.ok(!/\son[a-z]+\s*=/i.test(out), 'no on*= left');
  assert.equal(P.stripInlineHandlers('<a class="x"onclick="a(1)" href="/b">on=1 online</a>'), '<a class="x" href="/b">on=1 online</a>');
  assert.equal(P.stripInlineHandlers("<b onload='x()' data-a=\"1\">"), '<b  data-a="1">');
  assert.equal(P.stripInlineHandlers('<i onclick=go()>t</i>'), '<i >t</i>');
  const r = P.parseUsageHtml(realFree);
  assert.equal(r.diagnostics.includes('onclick'), false);
});

test('credits fixture alone: balance + plan label, no bogus meters', () => {
  const r = P.parseUsageHtml(`<html><body><main>${credits}</main></body></html>`);
  assert.equal(r.status, 'ok');
  assert.equal(r.tier, 'Pay as you go');
  assert.deepEqual(r.credits, { text: '$0', amount: 0, currency: '$' });
  assert.equal(r.meters.length, 0);
});

// ---- credits + Free usage window + stray timestamp elsewhere (the original bug) ----
const freePage = (resetTime) => `<html><body><main>
  <section>${credits}</section>
  <section>
    <div class="flex justify-between mb-2"><span>Free usage</span><span>12.5% used</span></div>
    <div class="flex h-2 w-full"><button data-usage-segment data-model="gemma4:31b" data-requests="7" style="background:#22c55e"></button><button data-usage-segment data-model="gpt-oss:120b" data-requests="3" style="background:#525252"></button></div>
    <div class="text-xs local-time" ${resetTime ? `data-time="${resetTime}"` : ''}>Refills in 1 day.</div>
  </section>
  <section><span class="local-time" data-time="2020-01-01T00:00:00Z">Jan 1, 2020</span><span>Billing: 99% </span></section>
</main></body></html>`;

test('free window: one meter, reset from data-time, stray past timestamp NOT attached', () => {
  const target = inHours(24);
  const r = P.parseUsageHtml(freePage(target));
  assert.equal(r.status, 'ok');
  assert.equal(r.meters.length, 1);
  const m = r.meters[0];
  assert.equal(m.id, 'free-usage');
  assert.equal(m.usedPercent, 12.5);
  assert.equal(m.resetsAt, new Date(target).toISOString());
  assert.equal(m.resetsAtApprox, false);
  assert.equal(m.resetVerb, 'Refills');
  assert.deepEqual(m.models, [{ model: 'gemma4:31b', requests: 7, color: '#22c55e' }, { model: 'gpt-oss:120b', requests: 3, color: '#525252' }]);
  assert.equal(r.credits.amount, 0);
});

test('free window without data-time: approximate reset parsed from text', () => {
  const r = P.parseUsageHtml(freePage(null));
  const m = r.meters[0];
  assert.equal(m.resetsAtApprox, true);
  const secs = P.secondsUntil(m.resetsAt);
  assert.ok(Math.abs(secs - 86400) < 5, `secs=${secs}`);
});

// ---- legacy layout still parses: two windows sharing one parent ----
test('legacy two windows in one container keep their own reset/models', () => {
  const s = inHours(3), w = inHours(100);
  const html = `<html><body><main><div>
    <h2>Cloud usage <span class="capitalize">free</span></h2>
    <div class="flex justify-between"><span>Session usage</span><span>56.6% used</span></div>
    <div><button data-usage-segment data-model="nemotron-3-ultra" data-requests="11"></button></div>
    <div class="local-time" data-time="${s}">Resets in 3 hours.</div>
    <div class="flex justify-between"><span>Weekly usage</span><span>24% used</span></div>
    <div><button data-usage-segment data-model="gemma4:31b" data-requests="4"></button></div>
    <div class="local-time" data-time="${w}">Resets in 4 days.</div>
  </div></main></body></html>`;
  const r = P.parseUsageHtml(html);
  assert.equal(r.status, 'ok');
  assert.equal(r.tier, 'free');
  assert.equal(r.meters.length, 2);
  assert.equal(r.meters[0].id, 'session-usage');
  assert.equal(r.meters[0].usedPercent, 56.6);
  assert.equal(r.meters[0].resetsAt, new Date(s).toISOString());
  assert.deepEqual(r.meters[0].models, [{ model: 'nemotron-3-ultra', requests: 11 }]);
  assert.equal(r.meters[1].usedPercent, 24);
  assert.equal(r.meters[1].resetsAt, new Date(w).toISOString());
  assert.deepEqual(r.meters[1].models, [{ model: 'gemma4:31b', requests: 4 }]);
  // widest window (furthest reset) wins for the models view
  assert.equal(P.pickModelsSource(r).meter.id, 'weekly-usage');
});

// ---- degradation ----
test('unknown value format on a "... usage" row degrades to raw text, not an error', () => {
  const html = `<html><body><main><div class="flex justify-between"><span>Free usage</span><span>3 / 50 requests</span></div></main></body></html>`;
  const r = P.parseUsageHtml(html);
  assert.equal(r.status, 'ok');
  assert.equal(r.meters.length, 1);
  assert.equal(r.meters[0].usedPercent, null);
  assert.equal(r.meters[0].valueText, '3 / 50 requests');
});

test('nothing recognisable -> parse_error with diagnostics, and stray % is NOT picked up', () => {
  const html = `<html><body><main><p>Brand new layout 42% of something</p><span class="local-time" data-time="2020-01-01T00:00:00Z">x</span><a href="mailto:me@example.com" class="x">me@example.com</a></main></body></html>`;
  const r = P.parseUsageHtml(html);
  assert.equal(r.status, 'parse_error');
  assert.equal(r.meters.length, 0);
  assert.ok(r.diagnostics.includes('Brand new layout'));
  assert.ok(!r.diagnostics.includes('me@example.com'), 'e-mail must be masked');
  assert.ok(!r.diagnostics.includes('mailto'), 'href must be stripped');
});

test('error-ish class names no longer false-positive', () => {
  const html = `<html><body><main><div class="error-boundary-wrapper">Something</div><div class="flex justify-between"><span>Free usage</span><span>1% used</span></div></main></body></html>`;
  assert.equal(P.parseUsageHtml(html).status, 'ok');
});

test('empty / non-string input', () => {
  assert.equal(P.parseUsageHtml('').status, 'parse_error');
  assert.equal(P.parseUsageHtml(null).status, 'parse_error');
});

// ---- legacy stored data ----
test('normalizeUsageData maps v1.0 {session, weekly}', () => {
  const old = { status: 'ok', lastFetch: new Date().toISOString(), tier: 'free',
    session: { usedPercent: 10, resetsInSeconds: 3600, models: [] },
    weekly: { usedPercent: 20, resetsInSeconds: null, models: [{ model: 'a', requests: 1 }] } };
  const n = P.normalizeUsageData(old);
  assert.equal(n.meters.length, 2);
  assert.equal(n.meters[0].id, 'session');
  assert.ok(n.meters[0].resetsAt);
  assert.equal(P.normalizeUsageData(null), null);
  const modern = { meters: [] };
  assert.equal(P.normalizeUsageData(modern), modern);
});

test('formatResetTime', () => {
  assert.equal(P.formatResetTime(86400 + 3600), '1d 1h');
  assert.equal(P.formatResetTime(30), '< 1m');
  assert.equal(P.formatResetTime(-5), 'resetting...');
  assert.equal(P.formatResetTime(null), 'unknown');
});

// ---- model colors (read from the page, not guessed) ----
test('extractColor: accepts plain colors only', () => {
  assert.equal(P.extractColor('width: 66%; background: #76b900'), '#76b900');
  assert.equal(P.extractColor('background-color:rgb(34, 197, 94)'), 'rgb(34, 197, 94)');
  assert.equal(P.extractColor('background: hsl(120 40% 50%)'), 'hsl(120 40% 50%)');
  assert.equal(P.extractColor('width: 10%'), null);
  assert.equal(P.extractColor(null), null);
  // anything that could smuggle more CSS into our inline style is rejected
  assert.equal(P.extractColor('background: url(https://evil.example/x.png)'), null);
  assert.equal(P.extractColor('background: red; position: fixed'), null);
  assert.equal(P.extractColor('background: #fff url(x)'), null);
  assert.equal(P.extractColor('background: expression(alert(1))'), null);
});

test('real page: each model carries the color ollama.com paints it with', () => {
  const r = P.parseUsageHtml(realFree);
  assert.deepEqual(r.meters[0].models, [
    { model: 'nemotron-3-ultra', requests: 34, color: '#76b900' },
    { model: 'web search', requests: 19, color: '#22c55e' }
  ]);
});

test('a segment without a usable color just has no color field', () => {
  const html = `<html><body><main><div class="flex justify-between"><span>Free usage</span><span>5% used</span></div>
    <button data-usage-segment data-model="a" data-requests="1" style="background: url(x)"></button>
    <button data-usage-segment data-model="b" data-requests="2"></button></main></body></html>`;
  assert.deepEqual(P.parseUsageHtml(html).meters[0].models, [{ model: 'a', requests: 1 }, { model: 'b', requests: 2 }]);
});
