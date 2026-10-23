import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mobilePairingPage } from './mobile-pairing-page';
import { createCloudTestHarness } from './test-support';

test('public camera handoff is anonymous HTML and never redeems a code', async () => {
  const h = await createCloudTestHarness();
  const account = await h.login('alice');
  const invitation = await h.call('/v1/pairings', 'POST', {}, String(account.token));
  const before = h.db.sqlite.prepare('SELECT * FROM centre_pairing').all();
  const response = await h.worker.fetch(new Request('https://centre.example/pair'), h.env);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/html/);
  const html = await response.text();
  assert.match(html, /Install Centre for iPhone/);
  assert.match(html, /history.replaceState/);
  assert.equal(html.includes(String(invitation.value.code)), false);
  assert.equal(html.includes('fetch('), false);
  assert.equal(html.includes('/v1/auth/pair'), false);
  assert.deepEqual(h.db.sqlite.prepare('SELECT * FROM centre_pairing').all(), before);
  const redeem = await h.call('/v1/auth/pair', 'POST', {code:invitation.value.code,deviceName:'iPhone'});
  assert.equal(redeem.status, 200);
  assert.equal((await h.call('/v1/auth/pair', 'POST', {code:invitation.value.code,deviceName:'Replay'})).status, 401);
  h.db.sqlite.close();
});

test('handoff has private no-network headers and only validated Apple install links', async () => {
  const response = mobilePairingPage('https://testflight.apple.com/join/Ab123456');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.match(response.headers.get('content-security-policy') ?? '', /connect-src 'none'/);
  assert.match(response.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
  assert.match(await response.text(), /href="https:\/\/testflight.apple.com\/join\/Ab123456"/);
  for (const value of ['https://evil.example/<script>', 'https://testflight.apple.com.evil.example/join/Ab123456', 'javascript:alert(1)']) {
    const html = await mobilePairingPage(value).text();
    assert.equal(html.includes(value), false);
    assert.match(html, /A native iPhone release isn’t available yet/);
  }
});
