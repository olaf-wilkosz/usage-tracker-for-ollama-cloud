// Peak / off-peak pricing window (weekdays 12:00-18:00 UTC, per ollama.com/pricing).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as H from '../peak-hours.js';

test('peak hours: weekday window, weekend, countdowns', () => {
  const at = (iso) => H.getPeakStatus(new Date(iso));
  // Tue 2026-11-03 (UTC)
  assert.deepEqual(at('2026-11-03T11:00:00Z'), { isPeak: false, secondsToChange: 3600 });
  assert.deepEqual(at('2026-11-03T12:00:00Z'), { isPeak: true, secondsToChange: 6 * 3600 });
  assert.deepEqual(at('2026-11-03T17:59:30Z'), { isPeak: true, secondsToChange: 30 });
  assert.deepEqual(at('2026-11-03T18:00:00Z'), { isPeak: false, secondsToChange: 18 * 3600 }); // until Wed 12:00
  // Fri 2026-11-06 18:00 -> off-peak until Mon 2026-11-09 12:00 (66h)
  assert.deepEqual(at('2026-11-06T18:00:00Z'), { isPeak: false, secondsToChange: 66 * 3600 });
  // Sat/Sun all day off-peak
  assert.equal(at('2026-11-07T14:00:00Z').isPeak, false);
  assert.equal(at('2026-11-08T14:00:00Z').isPeak, false);
});
