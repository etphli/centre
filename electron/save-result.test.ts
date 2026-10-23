import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeSaveResultSchema } from './save-result';

test('native saves distinguish cancellation, success and invalid IPC replies', () => {
  assert.deepEqual(nativeSaveResultSchema.parse({ saved: false }), { saved: false });
  assert.deepEqual(nativeSaveResultSchema.parse({ saved: true, filename: 'notes.md' }), { saved: true, filename: 'notes.md' });
  for (const value of [undefined, null, {}, { saved: true }, { saved: true, filename: '' }, { saved: false, filename: 'notes.md' }, { saved: 'true', filename: 'notes.md' }]) {
    assert.equal(nativeSaveResultSchema.safeParse(value).success, false);
  }
});
