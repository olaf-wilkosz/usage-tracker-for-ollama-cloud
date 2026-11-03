// Settings defaults, v1.0 -> v1.1 migration and validation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as S from '../extension/settings.js';

test('migrateSettings: v1.0 keys carried over, old keys removed, new defaults added', () => {
  const m = S.migrateSettings({ refreshIntervalMinutes: 15, notifyThresholdSession: 70, notifyThresholdWeekly: 90, notifyEnabled: false });
  assert.deepEqual(m, { refreshIntervalMinutes: 15, notifyWarning: 70, notifyCritical: 90, notifyEnabled: false, showPeakBanner: true });
  assert.deepEqual(S.migrateSettings(undefined), S.DEFAULT_SETTINGS);
  assert.equal(S.migrateSettings({ notifyWarning: 50, notifyThresholdSession: 70 }).notifyWarning, 50, 'new key wins');
});
test('validateSettings', () => {
  assert.deepEqual(S.validateSettings(S.DEFAULT_SETTINGS), []);
  assert.ok(S.validateSettings({ ...S.DEFAULT_SETTINGS, notifyWarning: 0 }).length);
  assert.ok(S.validateSettings({ ...S.DEFAULT_SETTINGS, notifyWarning: NaN }).length);
  assert.ok(S.validateSettings({ ...S.DEFAULT_SETTINGS, notifyWarning: 99, notifyCritical: 50 }).length);
  assert.ok(S.validateSettings({ ...S.DEFAULT_SETTINGS, refreshIntervalMinutes: 0 }).length);
});
