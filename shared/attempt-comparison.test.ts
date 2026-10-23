import assert from 'node:assert/strict';
import test from 'node:test';
import { attemptQuestions, attemptSummary, chronologicalAttempts, compareAttempts, normalizedScore, type AttemptRecord } from './attempt-comparison';

function attempt(id: string, answers = { q1: '4', q2: '5' }, scores = [2, 1]): AttemptRecord {
  return { id, resourceId: 'quiz', createdAt: '2026-10-22T00:00:00Z', answers,
    result: { score: scores.reduce((a, b) => a + b, 0), total: 3, feedback: [
      { questionId: 'q1', concept: 'Equations', score: scores[0], maxScore: 2, feedback: 'Saved feedback', needsReview: scores[0] < 2 },
      { questionId: 'q2', concept: 'Substitution', score: scores[1], maxScore: 1, feedback: 'Saved feedback', needsReview: scores[1] < 1 },
    ] } };
}

test('chronology is stable across sync arrival order, equivalent instants and ties without changing history', () => {
  const a = attempt('a'), b = { ...attempt('b'), createdAt: '2026-10-22T11:00:00+11:00' }, c = { ...attempt('c'), createdAt: '2026-10-23T00:00:00Z' };
  const records = [c, b, a], saved = structuredClone(records);
  assert.deepEqual(chronologicalAttempts(records).map(item => item.id), ['a', 'b', 'c']);
  assert.deepEqual(records, saved);
  assert.deepEqual(chronologicalAttempts([]), []);
  const unknownDate = { ...attempt('unknown'), createdAt: 'Date lost in legacy import' };
  assert.deepEqual(chronologicalAttempts([unknownDate, c, a]).map(item => item.id), ['a', 'c', 'unknown']);
});

test('unanswered, incorrect, partial and missing grades remain separate', () => {
  const record = attempt('a', { q1: '  ', q2: 'wrong' }, [0, 0]);
  record.answers.extra = 'Retained without feedback';
  assert.deepEqual(attemptQuestions(record).map(item => item.outcome), ['unanswered', 'incorrect', 'ungraded']);
  assert.deepEqual(attemptSummary(record), { percent: 0, questions: 3, answered: 2, unanswered: 1, correct: 0, partial: 0, incorrect: 1, ungraded: 1 });
  assert.equal(attemptQuestions(attempt('partial', undefined, [1, 1]))[0]?.outcome, 'partial');
});

test('saved question improvements, repeated mistakes and unanswered questions do not conflate', () => {
  const earlier = attempt('old', { q1: '3', q2: 'wrong' }, [0, 0]);
  const later = attempt('new', { q1: '4', q2: '' }, [2, 0]);
  const comparison = compareAttempts(earlier, later);
  assert.equal(comparison?.questions[0]?.change, 'improved');
  assert.equal(comparison?.questions[1]?.change, 'unanswered');
  assert.equal(comparison?.questions[1]?.repeatedMistake, false);
  const repeated = compareAttempts(earlier, attempt('again', { q1: '3', q2: 'other error' }, [1, 0]));
  assert.equal(repeated?.questions[0]?.change, 'improved');
  assert.equal(repeated?.questions[0]?.repeatedMistake, true);
  assert.equal(repeated?.questions[1]?.change, 'repeated-mistake');
  assert.equal(compareAttempts(earlier, { ...later, resourceId: 'unrelated' }), null);
  assert.equal(compareAttempts(earlier, earlier), null);
});

test('different sets, marks and sparse history expose limits instead of claiming improvement', () => {
  const earlier = attempt('old'), later = attempt('new');
  later.result.feedback[0].questionId = 'changed';
  later.answers = { changed: '4', q2: '5' };
  const different = compareAttempts(earlier, later);
  assert.equal(different?.sameQuestionSet, false);
  assert.equal(different?.sharedQuestions, 1);
  assert.equal(different?.percentagePointChange, 0);
  assert.equal(different?.questions.filter(item => item.change === 'not-shared').length, 2);
  const marks = attempt('marks');
  marks.result.feedback[0].maxScore = 4; marks.result.total = 5;
  assert.equal(compareAttempts(earlier, marks)?.questions[0]?.change, 'changed-marking');
  assert.equal(compareAttempts(earlier, marks)?.differentTotal, true);
});

test('invalid totals and ambiguous duplicate feedback are not presented as trustworthy scores', () => {
  for (const total of [0, -1, Infinity, NaN]) assert.equal(normalizedScore(0, total), null);
  assert.equal(normalizedScore(5, 3), null);
  const record = attempt('duplicate');
  record.result.feedback.push(record.result.feedback[0]);
  assert.equal(attemptQuestions(record)[0]?.outcome, 'ungraded');
  assert.equal(compareAttempts(record, { ...record, id: 'other' })?.sameMarking, false);
  const noGrade = { ...attempt('empty'), result: { score: 0, total: 0, feedback: [] }, answers: {} };
  assert.equal(attemptSummary(noGrade).percent, null);
  assert.equal(attemptSummary(noGrade).questions, 0);
});
