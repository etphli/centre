import type { QuizAttempt } from './practice';

export type AttemptRecord = Pick<QuizAttempt, 'id' | 'resourceId' | 'createdAt' | 'answers' | 'result'>;
export type QuestionOutcome = 'unanswered' | 'incorrect' | 'partial' | 'correct' | 'ungraded';
export type AttemptQuestion = {
  id: string;
  answer: string;
  outcome: QuestionOutcome;
  marking: QuizAttempt['result']['feedback'][number] | undefined;
};

export function normalizedScore(score: number, total: number): number | null {
  return Number.isFinite(score) && Number.isFinite(total) && total > 0 && score >= 0 && score <= total
    ? score / total * 100 : null;
}

/** Ascending UTC time, with a stable ID tie-breaker. Never mutates the replica. */
export function chronologicalAttempts<T extends AttemptRecord>(attempts: readonly T[]): T[] {
  return [...attempts].sort((a, b) => {
    const left = Date.parse(a.createdAt), right = Date.parse(b.createdAt);
    const time = Number.isFinite(left) && Number.isFinite(right) ? left - right : a.createdAt.localeCompare(b.createdAt);
    return time || a.id.localeCompare(b.id);
  });
}

/** Saved feedback order, then answers absent from feedback. Current resource content is never evidence. */
export function attemptQuestions(attempt: AttemptRecord): AttemptQuestion[] {
  const ids = [...new Set([...attempt.result.feedback.map(item => item.questionId), ...Object.keys(attempt.answers)])];
  return ids.map(id => {
    const answer = attempt.answers[id] ?? '';
    const matches = attempt.result.feedback.filter(item => item.questionId === id);
    const marking = matches.length === 1 ? matches[0] : undefined;
    const percent = marking ? normalizedScore(marking.score, marking.maxScore) : null;
    const outcome = !answer.trim() ? 'unanswered' : percent === null ? 'ungraded'
      : percent === 100 ? 'correct' : percent === 0 ? 'incorrect' : 'partial';
    return { id, answer, outcome, marking };
  });
}

export function attemptSummary(attempt: AttemptRecord) {
  const questions = attemptQuestions(attempt);
  const count = (outcome: QuestionOutcome) => questions.filter(question => question.outcome === outcome).length;
  return { percent: normalizedScore(attempt.result.score, attempt.result.total), questions: questions.length,
    answered: questions.filter(question => question.answer.trim()).length, unanswered: count('unanswered'),
    correct: count('correct'), partial: count('partial'), incorrect: count('incorrect'), ungraded: count('ungraded') };
}

export type QuestionChange = 'improved' | 'lower' | 'repeated-mistake' | 'same' | 'unanswered' | 'answered-now' | 'changed-marking' | 'not-shared' | 'ungraded';

/** Same-resource saved IDs only. V1 records cannot establish question-text or grader equivalence. */
export function compareAttempts(earlier: AttemptRecord, later: AttemptRecord) {
  if (earlier.resourceId !== later.resourceId || earlier.id === later.id) return null;
  const before = attemptQuestions(earlier), after = attemptQuestions(later);
  const beforeById = new Map(before.map(item => [item.id, item]));
  const afterById = new Map(after.map(item => [item.id, item]));
  const ids = [...new Set([...beforeById.keys(), ...afterById.keys()])];
  const sameQuestionSet = before.length === after.length && before.every(item => afterById.has(item.id));
  const sameMarking = sameQuestionSet && before.every(item => item.marking?.maxScore === afterById.get(item.id)?.marking?.maxScore);
  const left = attemptSummary(earlier), right = attemptSummary(later);
  const questions = ids.map(id => {
    const previous = beforeById.get(id), current = afterById.get(id);
    let change: QuestionChange;
    if (!previous || !current) change = 'not-shared';
    else if (current.outcome === 'unanswered') change = 'unanswered';
    else if (previous.outcome === 'unanswered') change = 'answered-now';
    else if (!previous.marking || !current.marking || previous.outcome === 'ungraded' || current.outcome === 'ungraded') change = 'ungraded';
    else if (previous.marking.maxScore !== current.marking.maxScore) change = 'changed-marking';
    else if (current.marking.score > previous.marking.score) change = 'improved';
    else if (current.marking.score < previous.marking.score) change = 'lower';
    else if (current.outcome !== 'correct') change = 'repeated-mistake';
    else change = 'same';
    const repeatedMistake = Boolean(previous && current && previous.outcome !== 'unanswered' && current.outcome !== 'unanswered'
      && previous.outcome !== 'ungraded' && current.outcome !== 'ungraded'
      && previous.marking?.maxScore === current.marking?.maxScore && previous.outcome !== 'correct' && current.outcome !== 'correct');
    return { id, previous, current, change, repeatedMistake };
  });
  return { sameQuestionSet, sameMarking, differentTotal: earlier.result.total !== later.result.total,
    percentagePointChange: left.percent === null || right.percent === null ? null : right.percent - left.percent,
    sharedQuestions: questions.filter(item => item.previous && item.current).length, questions };
}
