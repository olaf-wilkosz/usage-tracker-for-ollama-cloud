// Sealing the API key at rest (AES-GCM with a non-extractable key).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Secret from '../extension/secret-store.js';

let sealingKey = null;
const memory = {
  async get() { return sealingKey; },
  async put(key) { sealingKey = key; },
  async delete() { sealingKey = null; }
};
Secret.setKeyStorage(memory);

test('seal / open round trip; the blob does not contain the secret', async () => {
  const sealed = await Secret.sealSecret('super-secret-key.123');
  assert.equal(sealed.v, 1);
  assert.ok(!JSON.stringify(sealed).includes('super-secret'));
  assert.equal(await Secret.openSecret(sealed), 'super-secret-key.123');
});

test('the sealing key cannot be exported', async () => {
  assert.ok(sealingKey, 'created on first use');
  assert.equal(sealingKey.extractable, false);
  await assert.rejects(crypto.subtle.exportKey('raw', sealingKey));
});

test('every seal uses a fresh IV', async () => {
  const [a, b] = await Promise.all([Secret.sealSecret('same'), Secret.sealSecret('same')]);
  assert.notEqual(a.iv, b.iv);
  assert.notEqual(a.ct, b.ct);
});

test('unusable blobs open as null instead of throwing', async () => {
  const sealed = await Secret.sealSecret('abc');
  assert.equal(await Secret.openSecret(undefined), null);
  assert.equal(await Secret.openSecret({ ...sealed, v: 99 }), null);
  assert.equal(await Secret.openSecret({ ...sealed, ct: sealed.ct.slice(0, -4) + 'AAAA' }), null, 'tampered');
});

test('after the sealing key is destroyed (or lost) the old blob cannot be opened', async () => {
  const sealed = await Secret.sealSecret('abc');
  await Secret.destroySealingKey();
  assert.equal(sealingKey, null);
  assert.equal(await Secret.openSecret(sealed), null);

  // a new key does not resurrect the old blob either
  await Secret.sealSecret('other');
  assert.equal(await Secret.openSecret(sealed), null);
});
