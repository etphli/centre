import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createResourceSchema } from '../shared/schema';
import { saveResourceInput } from './index';
import { Store } from './store';
import { Codex } from './codex';
import { Resources } from './resources';

test('automatic flashcards save a variable deck of 1 to 30 cards while exact counts stay enforced', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'centre-flashcards-'));
  const store = await Store.open(directory);
  const codex = new Codex(directory, [], async () => undefined);
  const resources = new Resources(store, codex);
  const input = createResourceSchema.parse({ kind: 'flashcards', subjectId: null, topicId: null });
  assert.equal(input.kind === 'flashcards' && input.questionCount, 'auto');
  const generated = (count: number) => ({
    title: 'Recall cards', content: '',
    questions: Array.from({ length: count }, (_, index) => ({ responseType: 'short_response', choices: [], prompt: `Concept ${index + 1}?`, answer: `Answer ${index + 1}.`, explanation: '', marks: 1 })),
  });
  try {
    for (const count of [1, 7, 30]) {
      const toolInput = saveResourceInput.parse({ ...input, generated: generated(count) });
      const saved = await resources.saveGenerated(toolInput, toolInput.generated);
      assert.equal(saved.questions.length, count);
      assert.equal((await Store.open(directory)).state.resources[0]?.questions.length, count);
    }
    const savedCount = store.state.resources.length;
    await assert.rejects(resources.saveGenerated(input, generated(0)), /at least one card/);
    await assert.rejects(resources.saveGenerated(input, generated(31)), /at most 30/);
    const exact = createResourceSchema.parse({ ...input, questionCount: 3 });
    await assert.rejects(resources.saveGenerated(exact, generated(2)), /Expected 3 questions/);
    assert.equal(store.state.resources.length, savedCount);
    assert.equal((await resources.saveGenerated(exact, generated(3))).questions.length, 3);
    for (const questionCount of [0, 31, 1.5, '3', null]) {
      assert.equal(createResourceSchema.safeParse({ ...input, questionCount }).success, false);
    }
    assert.equal(createResourceSchema.safeParse({ kind: 'quiz', subjectId: null, topicId: null, questionCount: 'auto' }).success, false);
  } finally {
    await codex.close();
    await rm(directory, { recursive: true, force: true });
  }
});
