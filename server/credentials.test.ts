import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Credentials } from './credentials';

test('macOS Keychain round trip keeps credential punctuation intact and allows removal',{ skip:process.platform !== 'darwin' },async () => {
  const credentials = new Credentials(`/tmp/centre-keychain-test-${randomUUID()}`);
  const previous = process.env.GOOGLE_CLIENT_SECRET; delete process.env.GOOGLE_CLIENT_SECRET;
  const value = `fixture_${randomUUID()}_"quote"_\\slash_$dollar`;
  try {
    assert.equal(await credentials.get('googleClientSecret'),'');
    await credentials.set('googleClientSecret',value);
    assert.equal(await credentials.get('googleClientSecret'),value);
    await credentials.set('googleClientSecret','');
    assert.equal(await credentials.get('googleClientSecret'),'');
  } finally { await credentials.set('googleClientSecret',''); if (previous !== undefined) process.env.GOOGLE_CLIENT_SECRET = previous; }
});
