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
test('deriveConnected: a stored key counts only while Ollama has not rejected it', () => {
  assert.equal(S.deriveConnected({ hasKey: true, status: 'ok' }), true);
  assert.equal(S.deriveConnected({ hasKey: true, status: 'network_error' }), true, 'a hiccup is not a rejected key');
  assert.equal(S.deriveConnected({ hasKey: true, status: null }), true, 'before the first refresh');
  assert.equal(S.deriveConnected({ hasKey: true, status: 'auth_required' }), false, 'revoked key');
  assert.equal(S.deriveConnected({ hasKey: true, status: 'no_key' }), false, 'sealing key lost');
  assert.equal(S.deriveConnected({ hasKey: false, status: 'no_key' }), false);
  assert.equal(S.deriveConnected(), false);
});

test('isPinnedToToolbar: true / false when the browser says, null when it cannot', async () => {
  globalThis.chrome = { action: { getUserSettings: async () => ({ isOnToolbar: true }) } };
  assert.equal(await S.isPinnedToToolbar(), true);
  globalThis.chrome = { action: { getUserSettings: async () => ({ isOnToolbar: false }) } };
  assert.equal(await S.isPinnedToToolbar(), false);
  globalThis.chrome = { action: {} };
  assert.equal(await S.isPinnedToToolbar(), null, 'API missing');
  globalThis.chrome = { action: { getUserSettings: async () => { throw new Error('nope'); } } };
  assert.equal(await S.isPinnedToToolbar(), null, 'API failing');
  globalThis.chrome = { action: { getUserSettings: async () => ({}) } };
  assert.equal(await S.isPinnedToToolbar(), null, 'unexpected answer');
  delete globalThis.chrome;
});

test('validateSettings', () => {
  assert.deepEqual(S.validateSettings(S.DEFAULT_SETTINGS), []);
  assert.ok(S.validateSettings({ ...S.DEFAULT_SETTINGS, notifyWarning: 0 }).length);
  assert.ok(S.validateSettings({ ...S.DEFAULT_SETTINGS, notifyWarning: NaN }).length);
  assert.ok(S.validateSettings({ ...S.DEFAULT_SETTINGS, notifyWarning: 99, notifyCritical: 50 }).length);
  assert.ok(S.validateSettings({ ...S.DEFAULT_SETTINGS, refreshIntervalMinutes: 0 }).length);
});
