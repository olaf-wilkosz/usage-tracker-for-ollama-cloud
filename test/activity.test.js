// Heatmap grids built from hourly activity buckets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as A from '../activity.js';

test('activity: keys, week grid, month grid, level, kind pick', () => {
  const now = new Date(2026, 10, 3, 15, 30); // Tue 3 Nov 2026 local
  assert.equal(A.dayKey(now), '2026-11-03');
  assert.equal(A.hourKey(now), '2026-11-03T15');

  const buckets = { '2026-11-03T14': 4, '2026-11-03T15': 2, '2026-11-02T09': 10, '2026-10-12T10': 6, '2020-01-01T00': 99 };
  const w = A.buildWeekGrid(buckets, now);
  assert.equal(w.rows.length, 7);
  assert.equal(w.rows[6].date.getDate(), 3, 'last row is today');
  assert.equal(w.rows[0].date.getDate(), 28, 'first row is 6 days ago (Oct 28)');
  assert.equal(w.rows[6].cells[14].value, 4);
  assert.equal(w.rows[6].cells[16].future, true);
  assert.equal(w.rows[6].cells[15].future, false);
  assert.equal(w.max, 10);
  assert.equal(w.total, 16);

  const m = A.buildMonthGrid(buckets, now);
  assert.equal(m.rows.length, 5);
  assert.equal(m.rows[4].start.getDay(), 1, 'weeks start on Monday');
  assert.equal(m.rows[4].start.getDate(), 2, 'current week starts Mon Nov 2');
  assert.equal(m.rows[4].cells[0].value, 10);      // Mon Nov 2
  assert.equal(m.rows[4].cells[1].value, 6);       // Tue Nov 3 (4+2)
  assert.equal(m.rows[4].cells[2].future, true);
  assert.equal(m.rows[0].start.getDate(), 5, 'oldest row is Mon Oct 5');
  assert.equal(m.rows[1].cells[0].value, 6, 'Mon Oct 12 shows its 6');
  assert.equal(m.max, 10);

  assert.equal(A.heatLevel(0, 10), 0);
  assert.equal(A.heatLevel(1, 10), 1);
  assert.equal(A.heatLevel(10, 10), 4);
  assert.equal(A.heatLevel(5, 0), 0);

  assert.equal(A.pickActivityBuckets({ requests: { a: 1 }, percent: { b: 5 } }).kind, 'requests');
  assert.equal(A.pickActivityBuckets({ requests: {}, percent: { b: 5 } }).kind, 'percent');
  assert.equal(A.pickActivityBuckets(undefined).kind, 'requests');
});
