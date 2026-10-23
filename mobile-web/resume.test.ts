import test from 'node:test';
import assert from 'node:assert/strict';
import { resourceSchema } from '../shared/schema';
import { quizDraftSchema } from '../shared/practice';
import { latestUnfinishedQuiz } from './resume';

const stamp = '2026-10-23T00:00:00.000Z';
const resource = resourceSchema.parse({ id: 'quiz', title: 'Forces', kind: 'quiz', content: '', createdAt: stamp, updatedAt: stamp, subjectId: null, topicId: null, questions: [{ id: 'q1', prompt: 'Explain force.', responseType: 'short_response', marks: 2, choices: [], answer: 'A push or pull.', explanation: '', concept: 'force' }] });
const draft = quizDraftSchema.parse({ schemaVersion: 1, id: '118917ac-63f0-47c2-88bf-3d7d35ddc336', revision: 1, resourceId: resource.id, answers: { q1: 'A push.' }, currentQuestion: 0, createdAt: stamp, updatedAt: stamp, deletedAt: null });

test('resume shows the newest saved quiz with an answer to a retained question', () => {
  const newer = quizDraftSchema.parse({ ...draft, id: '08fe1544-71e5-422f-bec1-bb99b2d0a063', updatedAt: '2026-10-23T01:00:00.000Z' });
  const result = latestUnfinishedQuiz([resource], [draft, newer]);
  assert.equal(result?.draft.id, newer.id);
  assert.equal(result?.resource.id, resource.id);
  assert.equal(result?.answered, 1);
});

test('resume excludes deleted, unavailable, empty and stale-question-only work', () => {
  assert.equal(latestUnfinishedQuiz([], [draft]), null);
  assert.equal(latestUnfinishedQuiz([{ ...resource, deletedAt: stamp }], [draft]), null);
  assert.equal(latestUnfinishedQuiz([resource], [{ ...draft, deletedAt: stamp }]), null);
  assert.equal(latestUnfinishedQuiz([resource], [{ ...draft, answers: { q1: '  ', old: 'An old answer' } }]), null);
  assert.deepEqual(draft.answers, { q1: 'A push.' });
});
