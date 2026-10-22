import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mobileDistribution } from '../shared/mobile-distribution';

test('installation accepts Apple distribution paths, independent of account pairing', () => {
  assert.deepEqual(mobileDistribution('https://testflight.apple.com/join/Ab12Cd34'), { kind:'testflight',url:'https://testflight.apple.com/join/Ab12Cd34' });
  assert.equal(mobileDistribution('https://apps.apple.com/au/app/centre/id1234567890')?.kind, 'app-store');
  assert.equal(mobileDistribution('https://apps.apple.com/app/id1234567890')?.kind, 'app-store');
});

test('installation rejects credentials, non-Apple hosts, redirects, IPAs and malformed invitations', () => {
  for (const value of [undefined,'','https://example.com/app.ipa','itms-services://install','http://testflight.apple.com/join/Ab12Cd34','https://testflight.apple.com.evil.test/join/Ab12Cd34','https://testflight.apple.com@evil.test/join/Ab12Cd34','https://user:secret@testflight.apple.com/join/Ab12Cd34','https://testflight.apple.com:444/join/Ab12Cd34','https://testflight.apple.com/join/short','https://testflight.apple.com/join/Ab12Cd34?token=secret','https://testflight.apple.com/join/Ab12Cd34#token','https://apps.apple.com/app/centre.ipa','https://apps.apple.com/app/id0']) {
    assert.equal(mobileDistribution(value), null, value);
  }
});
