import test from 'node:test';
import assert from 'node:assert/strict';
import { PromptDraft, promptDraftKey } from './prompt-drafts';

function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
}
test('half-typed text and exact whitespace survive a new draft reader', () => {
  const disk = storage(), key = promptDraftKey([null, 'account'], 'chat-a');
  new PromptDraft(key, () => disk).setText('  Explain this half-typed\n');
  assert.deepEqual(new PromptDraft(key, () => disk).getSnapshot(), { text: '  Explain this half-typed\n', error: null });
});
test('new prompts, chats and accounts have distinct private drafts', () => {
  const disk = storage(), a = new PromptDraft(promptDraftKey([null, 'alice'], 'chat-a'), () => disk);
  a.setText('Only Alice in chat A');
  for (const [accounts, chat] of [[[null, 'bob'], 'chat-a'], [[null, 'alice'], 'chat-b'], [[null, 'alice'], null]] satisfies [Array<string | null>, string | null][]) {
    assert.equal(new PromptDraft(promptDraftKey(accounts, chat), () => disk).getSnapshot().text, '');
  }
  assert.notEqual(promptDraftKey([null, 'alice'], null), promptDraftKey([null, 'alice'], 'null'));
});
test('clearing one sent prompt leaves other drafts intact', () => {
  const disk = storage(), first = promptDraftKey([null], 'a'), second = promptDraftKey([null], 'b');
  const a = new PromptDraft(first, () => disk), b = new PromptDraft(second, () => disk);
  a.setText('Sent'); b.setText('Still typing'); a.setText('');
  assert.equal(disk.getItem(first), null);
  assert.equal(new PromptDraft(second, () => disk).getSnapshot().text, 'Still typing');
});
test('a failed disk write keeps exact text in the live draft and reports the limit', () => {
  const disk = storage(), draft = new PromptDraft('key', () => ({ ...disk, setItem() { throw new Error('Storage full'); } }));
  draft.setText('Keep these final characters');
  assert.equal(draft.getSnapshot().text, 'Keep these final characters');
  assert.match(draft.getSnapshot().error ?? '', /could not be saved/);
});
test('rapid edits persist the last value and notify subscribed views', () => {
  const disk = storage(), draft = new PromptDraft('key', () => disk); let updates = 0;
  const unsubscribe = draft.subscribe(() => updates++);
  for (let i = 0; i < 100; i++) draft.setText(`Draft ${i}`);
  unsubscribe(); draft.setText('Final');
  assert.equal(updates, 100);
  assert.equal(new PromptDraft('key', () => disk).getSnapshot().text, 'Final');
});
test('malformed saved data is reported without accepting another record shape', () => {
  const disk = storage(); disk.setItem('key', JSON.stringify({ token: 'not a draft', text: 42 }));
  const draft = new PromptDraft('key', () => disk);
  assert.equal(draft.getSnapshot().text, '');
  assert.match(draft.getSnapshot().error ?? '', /could not be opened/);
  assert.ok(disk.getItem('key')?.includes('not a draft'));
});
