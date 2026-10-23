import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mobilePairingUrl } from './mobile-pairing';

test('camera pairing uses HTTPS and carries its secret only in the fragment', () => {
  const code = 'a'.repeat(64);
  const url = new URL(mobilePairingUrl('https://centre.example/', code));
  assert.equal(url.href, `https://centre.example/pair#code=${code}`);
  assert.equal(url.search, '');
  assert.equal(new URLSearchParams(url.hash.slice(1)).get('code'), code);
});

test('pairing validates the cloud boundary and code before generating a QR', () => {
  for (const base of ['http://centre.example', 'centre://pair', 'https://user@centre.example', 'https://centre.example/v1', 'https://centre.example/?code=secret', 'https://centre.example/#secret']) {
    assert.throws(() => mobilePairingUrl(base, 'a'.repeat(64)));
  }
  for (const code of ['', 'a'.repeat(31), 'a'.repeat(201), 'a'.repeat(63) + '+', '<script>'.repeat(8)]) {
    assert.throws(() => mobilePairingUrl('https://centre.example', code));
  }
  assert.throws(() => mobilePairingUrl('http://127.0.0.1:8789', 'a'.repeat(64)));
  assert.match(mobilePairingUrl('http://127.0.0.1:8789', 'a'.repeat(64), true), /^http:\/\/127.0.0.1:8789\/pair#/);
  assert.throws(() => mobilePairingUrl('http://centre.example', 'a'.repeat(64), true));
});
