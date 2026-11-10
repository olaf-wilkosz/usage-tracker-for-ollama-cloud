// Pure popup helpers: legend folding and the text summary that replaces the heatmap for screen readers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../extension/popup-logic.js';

test('pluralRequests', () => {
  assert.equal(L.pluralRequests(0), '0 requests');
  assert.equal(L.pluralRequests(1), '1 request');
  assert.equal(L.pluralRequests(12), '12 requests');
});

test('buildLegendItems: up to 6 models are listed as they are, with colors and cost', () => {
  const items = L.buildLegendItems([{ model: 'nemotron-3-ultra', requests: 10, cost: 0.5 }, { model: 'beam', requests: 3 }]);
  assert.deepEqual(items.map((i) => [i.label, i.requests, i.cost]), [['nemotron-3-ultra', 10, 0.5], ['beam', 3, 0]]);
  assert.equal(items[0].color, '#76b900', 'the color observed on ollama.com');
  assert.equal(items[0].members, null);
});

test('buildLegendItems: more than 6 models fold the tail into one gray entry', () => {
  const models = Array.from({ length: 9 }, (_, i) => ({ model: `m${i}`, requests: 20 - i, cost: 0.1 }));
  const items = L.buildLegendItems(models);
  assert.equal(items.length, L.MAX_LEGEND_ROWS);
  assert.deepEqual(items.slice(0, 5).map((i) => i.label), ['m0', 'm1', 'm2', 'm3', 'm4']);
  const other = items.at(-1);
  assert.equal(other.label, '4 other models');
  assert.equal(other.requests, 15 + 14 + 13 + 12);
  assert.equal(Math.round(other.cost * 100) / 100, 0.4);
  assert.equal(other.color, L.OTHERS_COLOR);
  assert.equal(other.members, 'm5: 15\nm6: 14\nm7: 13\nm8: 12');
  assert.equal(L.buildLegendItems(models.slice(0, 6)).length, 6, 'exactly 6 is not folded');
});

test('formatDayRange: like the date range on the usage page', () => {
  assert.equal(L.formatDayRange('2026-11-01', '2026-11-08'), 'Nov 1–8');
  assert.equal(L.formatDayRange('2026-11-09', '2026-11-09'), 'Nov 9');
  assert.equal(L.formatDayRange('2026-10-10', '2026-11-09'), 'Oct 10 – Nov 9');
  assert.equal(L.formatDayRange('2025-12-20', '2026-01-02'), 'Dec 20 – Jan 2');
  assert.equal(L.formatDayRange(null, '2026-11-09'), '');
});

test('formatRunway: days of credits left in words', () => {
  assert.equal(L.formatRunway(0.4), 'less than a day');
  assert.equal(L.formatRunway(1.5), '1 day');
  assert.equal(L.formatRunway(12.4), '12 days');
  assert.equal(L.formatRunway(89.6), '90 days');
  assert.equal(L.formatRunway(90), '90+ days');
  assert.equal(L.formatRunway(5000), '90+ days');
});

test('formatDay: weekday and date of a UTC day', () => {
  assert.equal(L.formatDay('2026-11-08'), 'Sun, Nov 8');
  assert.equal(L.formatDay('2026-11-09'), 'Mon, Nov 9');
  assert.equal(L.formatDay('2026-01-01'), 'Thu, Jan 1');
});

test('rangeEntry: accepts the current shape and the bare array an earlier version stored', () => {
  assert.deepEqual(L.rangeEntry({ from: '2026-11-01', to: '2026-11-08', models: [{ model: 'a', requests: 1 }] }), { from: '2026-11-01', to: '2026-11-08', models: [{ model: 'a', requests: 1 }] });
  assert.deepEqual(L.rangeEntry([{ model: 'a', requests: 1 }]), { from: null, to: null, models: [{ model: 'a', requests: 1 }] });
  assert.deepEqual(L.rangeEntry(undefined), { from: null, to: null, models: [] });
});

test('summarizeActivity: the text twin of the heatmap', () => {
  assert.equal(L.summarizeActivity('week', 0, null), 'No requests in the last 7 days.');
  assert.equal(L.summarizeActivity('month', 126, { label: 'Wed, Nov 4', value: 60 }), '126 requests in the last 30 days. Busiest: Wed, Nov 4, 60 requests.');
  assert.equal(L.summarizeActivity('week', 1, { label: 'Sat, Nov 7, 15:00', value: 1 }), '1 request in the last 7 days. Busiest: Sat, Nov 7, 15:00, 1 request.');
  assert.equal(L.summarizeActivity('week', 4.4, { label: 'x', value: 2.6 }), '4 requests in the last 7 days. Busiest: x, 3 requests.', 'fractions are rounded');
  assert.equal(L.summarizeActivity('week', 5, null), 'No requests in the last 7 days.', 'no busiest cell means nothing to describe');
});
