import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { applyGradeEvidence, applyReviewEvidence, relevantLearningNeeds, validateGradeResult, type LearningNeed } from '../shared/practice';
import { emptySnapshot } from './store';
import { snapshotSchema } from '../shared/schema';

const now = '2026-10-22T00:00:00.000Z';
const questions = [{ id:'q1', marks:2, concept:'Linear equations' }, { id:'q2', marks:1, concept:'Substitution' }];
const feedback = (questionId = 'q1', score = 0, maxScore = 2) => ({ questionId, concept:'Linear equations', score, maxScore, feedback:'Check inverse operations.', needsReview:score < maxScore });
function grade(learningNeeds: readonly LearningNeed[], overrides: Partial<Parameters<typeof applyGradeEvidence>[0]> = {}) {
  return applyGradeEvidence({ learningNeeds, subjectId:'math', topicId:'algebra', resourceId:'quiz', questionId:'q1', questionConcept:'Linear equations', concept:'Linear equations', topicName:'Algebra', feedback:feedback(), attemptId:randomUUID(), now, createId:randomUUID, ...overrides });
}

test('grade validation derives totals from each real question and falls back to its concept', () => {
  const result = validateGradeResult(questions, { score:999, total:999, feedback:[{ ...feedback('q2',1,1), concept:'' }, feedback('q1',1,2)] });
  assert.equal(result.score,2);
  assert.equal(result.total,3);
  assert.equal(result.feedback[0]?.concept,'Substitution');
});

test('grade validation rejects missing, duplicate, unknown, over-scored and wrong-mark feedback', () => {
  const valid = [feedback(),feedback('q2',1,1)];
  for (const invalid of [valid.slice(0,1), [valid[0],valid[0]], [feedback('unknown'),valid[1]], [feedback('q1',3,2),valid[1]], [feedback('q1',-1,2),valid[1]], [feedback('q1',1,3),valid[1]]]) {
    assert.throws(() => validateGradeResult(questions,{ score:0,total:3,feedback:invalid }));
  }
});

test('repeated mistakes update the same scoped need, retry evidence is idempotent, and correct work reduces it', () => {
  const first = grade([]);
  const original = structuredClone(first.learningNeeds);
  const attemptId = randomUUID();
  const second = grade(first.learningNeeds,{ attemptId, concept:'Untrusted model label', questionConcept:'  LINEAR equations  ' });
  assert.deepEqual(first.learningNeeds,original,'The shared transition must not mutate its input.');
  assert.equal(second.learningNeeds.length,1);
  assert.equal(second.updatedNeed?.id,first.updatedNeed?.id);
  assert.equal(second.updatedNeed?.needScore,4);
  assert.equal(second.updatedNeed?.evidence.length,2);
  assert.deepEqual(grade(second.learningNeeds,{ attemptId }).learningNeeds,second.learningNeeds);
  const correct = grade(second.learningNeeds,{ feedback:feedback('q1',2,2) });
  assert.equal(correct.updatedNeed?.needScore,2);
  assert.equal(correct.updatedNeed?.evidence.at(-1)?.outcome,'correct');
  assert.equal(grade([],{ feedback:feedback('q1',2,2) }).learningNeeds.length,0);
});

test('learning evidence is bounded and scores saturate without losing recent outcomes', () => {
  let needs: LearningNeed[] = [];
  for (let index = 0; index < 12; index++) needs = grade(needs,{ now:new Date(Date.parse(now) + index * 1000).toISOString() }).learningNeeds;
  assert.equal(needs[0]?.needScore,10);
  assert.equal(needs[0]?.evidence.length,8);
  assert.equal(needs[0]?.evidence[0]?.recordedAt,'2026-10-22T00:00:04.000Z');
  for (let index = 0; index < 6; index++) needs = grade(needs,{ feedback:feedback('q1',2,2) }).learningNeeds;
  assert.equal(needs[0]?.needScore,0);
  assert.equal(relevantLearningNeeds(needs,'math','algebra').length,0);
});

test('review resolution decreases its linked need once and preserves unrelated topics', () => {
  const first = grade([]);
  const other = grade(first.learningNeeds,{ topicId:'geometry' });
  const input = { learningNeeds:other.learningNeeds, learningNeedId:first.updatedNeed?.id ?? null, memoryId:'review-1', resourceId:'quiz', now, createId:randomUUID };
  const reviewed = applyReviewEvidence(input);
  assert.equal(reviewed.updatedNeed?.needScore,0);
  assert.equal(reviewed.updatedNeed?.evidence.at(-1)?.source,'review');
  assert.deepEqual(reviewed.learningNeeds[1],other.learningNeeds[1]);
  assert.deepEqual(applyReviewEvidence({ ...input, learningNeeds:reviewed.learningNeeds }).learningNeeds,reviewed.learningNeeds);
  const reopened = grade(reviewed.learningNeeds);
  const reviewedAgain = applyReviewEvidence({ ...input, learningNeeds:reopened.learningNeeds, now:'2026-10-23T00:00:00.000Z' });
  assert.equal(reviewedAgain.updatedNeed?.needScore,0,'A later review cycle supplies new improvement evidence.');
  assert.deepEqual(relevantLearningNeeds(reviewed.learningNeeds,'math','algebra'),[]);
  assert.equal(relevantLearningNeeds(reviewed.learningNeeds,'math','geometry').length,1);
});

test('topic and subject selection isolate the same concept, exclude tombstones and return at most five needs', () => {
  let needs = grade([]).learningNeeds;
  needs = grade(needs,{ topicId:'geometry' }).learningNeeds;
  needs = grade(needs,{ subjectId:'science' }).learningNeeds;
  needs = grade(needs,{ subjectId:null, topicId:null }).learningNeeds;
  assert.equal(needs.length,4);
  assert.equal(relevantLearningNeeds(needs,'math','algebra').length,1);
  assert.equal(relevantLearningNeeds(needs,null,null).length,1);
  for (let index = 0; index < 7; index++) needs = grade(needs,{ concept:`Concept ${index}`, questionConcept:`Concept ${index}` }).learningNeeds;
  assert.equal(relevantLearningNeeds(needs,'math','algebra').length,5);
  const deleted = needs.map(need => ({ ...need, deletedAt:now }));
  assert.deepEqual(relevantLearningNeeds(deleted),[]);
});

test('the history bound includes durable tombstones and never prevents an existing need from improving', () => {
  const first = grade([]).learningNeeds[0];
  const needs = Array.from({length:500}, (_,index) => ({...first,id:randomUUID(),conceptKey:`key-${index}`,conceptLabel:`Key ${index}`,deletedAt:index === 0 ? now : null}));
  const bounded = grade(needs,{questionConcept:'New concept'});
  assert.equal(bounded.learningNeeds.length,500);
  assert.equal(bounded.updatedNeed,undefined);
  const improved = grade(bounded.learningNeeds,{questionConcept:'Key 1',feedback:feedback('q1',2,2)});
  assert.equal(improved.updatedNeed?.id,needs[1].id);
  assert.equal(improved.updatedNeed?.needScore,0);
  assert.doesNotThrow(() => snapshotSchema.parse({...emptySnapshot(),learningNeeds:improved.learningNeeds}));
});
