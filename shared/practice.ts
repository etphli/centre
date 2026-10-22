import { z } from 'zod';

/** Persisted, versioned practice records shared by desktop, Worker, and iOS. */
export const gradeResultSchema = z.object({
  score: z.number(),
  total: z.number(),
  feedback: z.array(z.object({
    questionId: z.string(),
    concept: z.string().trim().max(100).default(''),
    score: z.number(),
    maxScore: z.number(),
    feedback: z.string(),
    needsReview: z.boolean(),
  })),
});
export type GradeResult = z.infer<typeof gradeResultSchema>;

export const attemptSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  revision: z.literal(1).default(1),
  id: z.string().uuid(),
  sourceDraftId: z.string().uuid().nullable().default(null),
  resourceId: z.string(),
  answers: z.record(z.string(), z.string()),
  result: gradeResultSchema,
  createdAt: z.string().datetime(),
}).strict();
export type QuizAttempt = z.infer<typeof attemptSchema>;

export const quizDraftSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().uuid(),
  revision: z.number().int().positive(),
  resourceId: z.string(),
  answers: z.record(z.string().max(64), z.string().max(4000)).default({}),
  currentQuestion: z.number().int().min(0).max(29),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  deletedAt: z.string().datetime().nullable().default(null),
}).strict();
export type QuizDraft = z.infer<typeof quizDraftSchema>;

export const saveQuizDraftSchema = z.object({
  id: z.string().uuid(),
  expectedRevision: z.number().int().positive().nullable(),
  answers: z.record(z.string().max(64), z.string().max(4000)).default({}),
  currentQuestion: z.number().int().min(0).max(29),
}).strict();
export const resetQuizDraftSchema = z.object({
  id: z.string().uuid(),
  expectedRevision: z.number().int().positive(),
}).strict();

const gradeEvidenceSchema = z.object({
  id: z.string().uuid(), source: z.literal('grade'), attemptId: z.string().uuid(),
  resourceId: z.string(), questionId: z.string(), outcome: z.enum(['incorrect', 'partial', 'correct']),
  score: z.number().nonnegative(), maxScore: z.number().positive(), feedback: z.string().max(1000),
  recordedAt: z.string().datetime(),
}).strict();
const reviewEvidenceSchema = z.object({
  id: z.string().uuid(), source: z.literal('review'), memoryId: z.string(), resourceId: z.string(),
  outcome: z.literal('resolved'), feedback: z.string().max(1000), recordedAt: z.string().datetime(),
}).strict();
export const learningEvidenceSchema = z.discriminatedUnion('source', [gradeEvidenceSchema, reviewEvidenceSchema]);
export type LearningEvidence = z.infer<typeof learningEvidenceSchema>;

export const learningNeedSchema = z.object({
  schemaVersion: z.literal(1), id: z.string().uuid(), revision: z.number().int().positive(),
  subjectId: z.string().nullable(), topicId: z.string().nullable(), conceptKey: z.string().min(1).max(120),
  conceptLabel: z.string().trim().min(1).max(100), needScore: z.number().int().min(0).max(10),
  evidence: z.array(learningEvidenceSchema).max(8), createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(), deletedAt: z.string().datetime().nullable().default(null),
}).strict();
export type LearningNeed = z.infer<typeof learningNeedSchema>;

export const gradeSchema = z.object({
  resourceId: z.string(), answers: z.record(z.string().max(64), z.string().max(4000)),
  draftId: z.string().uuid().optional(), expectedDraftRevision: z.number().int().positive().nullable().optional(),
}).strict().superRefine((input, ctx) => {
  if ((input.draftId === undefined) !== (input.expectedDraftRevision === undefined)) {
    ctx.addIssue({ code: 'custom', path: ['draftId'], message: 'A draft ID and its expected revision must be sent together.' });
  }
});

export const MAX_LEARNING_NEEDS = 500;
const MAX_EVIDENCE_PER_NEED = 8;

export function normalizeConceptKey(label: string): string {
  const normalized = label.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim()
    .replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 120);
  return normalized || 'general';
}

type GradeQuestion = { id: string; marks: number; concept?: string };

/** Validates a model or hosted-AI grade against the real quiz and returns canonical totals. */
export function validateGradeResult(questions: readonly GradeQuestion[], candidate: unknown, fallbackConcept = ''): GradeResult {
  const parsed = gradeResultSchema.parse(candidate);
  const questionsById = new Map(questions.map(question => [question.id, question]));
  if (questionsById.size !== questions.length || parsed.feedback.length !== questions.length) {
    throw new Error('The grader must return feedback exactly once for every question.');
  }
  const seen = new Set<string>();
  const feedback = parsed.feedback.map(item => {
    const question = questionsById.get(item.questionId);
    if (!question || seen.has(item.questionId) || item.maxScore !== question.marks
      || item.score < 0 || item.score > item.maxScore) {
      throw new Error('The grader returned invalid marking.');
    }
    seen.add(item.questionId);
    return { ...item, concept: question.concept || item.concept || fallbackConcept };
  });
  if (seen.size !== questions.length) throw new Error('The grader must return feedback exactly once for every question.');
  return { score: feedback.reduce((sum, item) => sum + item.score, 0),
    total: feedback.reduce((sum, item) => sum + item.maxScore, 0), feedback };
}

function outcomeFor(score: number, maxScore: number): 'incorrect' | 'partial' | 'correct' {
  if (score <= 0) return 'incorrect';
  if (score >= maxScore) return 'correct';
  return 'partial';
}

/** Pure, idempotent transition from one validated graded question to bounded learning evidence. */
export function applyGradeEvidence(input: {
  learningNeeds: readonly LearningNeed[];
  subjectId: string | null;
  topicId: string | null;
  resourceId: string;
  questionId: string;
  questionConcept: string;
  concept: string;
  topicName: string;
  feedback: GradeResult['feedback'][number];
  attemptId: string;
  now: string;
  createId: () => string;
}): { learningNeeds: LearningNeed[]; updatedNeed: LearningNeed | undefined } {
  const label = (input.questionConcept || input.concept || input.topicName || input.resourceId).trim().slice(0, 100);
  const conceptKey = normalizeConceptKey(label);
  const index = input.learningNeeds.findIndex(need => !need.deletedAt && need.subjectId === input.subjectId
    && need.topicId === input.topicId && need.conceptKey === conceptKey);
  const existing = index >= 0 ? input.learningNeeds[index] : undefined;
  const outcome = outcomeFor(input.feedback.score, input.feedback.maxScore);
  if (!existing && outcome === 'correct' && !input.feedback.needsReview) {
    return { learningNeeds: [...input.learningNeeds], updatedNeed: undefined };
  }
  if (existing?.evidence.some(evidence => evidence.source === 'grade' && evidence.attemptId === input.attemptId
    && evidence.questionId === input.questionId)) {
    return { learningNeeds: [...input.learningNeeds], updatedNeed: existing };
  }
  const delta = outcome === 'incorrect' ? 2 : outcome === 'partial' || input.feedback.needsReview ? 1 : -2;
  const evidence: LearningEvidence = { id: input.createId(), source: 'grade', attemptId: input.attemptId,
    resourceId: input.resourceId, questionId: input.questionId, outcome, score: input.feedback.score,
    maxScore: input.feedback.maxScore, feedback: input.feedback.feedback.slice(0, 1000), recordedAt: input.now };
  const updated = existing
    ? learningNeedSchema.parse({ ...existing, revision: existing.revision + 1,
      needScore: Math.min(10, Math.max(0, existing.needScore + delta)),
      evidence: [...existing.evidence, evidence].slice(-MAX_EVIDENCE_PER_NEED), updatedAt: input.now, deletedAt: null })
    : undefined;
  if (existing && updated) {
    const learningNeeds = [...input.learningNeeds];
    learningNeeds[index] = updated;
    return { learningNeeds, updatedNeed: updated };
  }
  if (input.learningNeeds.length >= MAX_LEARNING_NEEDS) {
    return { learningNeeds: [...input.learningNeeds], updatedNeed: undefined };
  }
  const created = learningNeedSchema.parse({ schemaVersion: 1, id: input.createId(), revision: 1,
    subjectId: input.subjectId, topicId: input.topicId, conceptKey, conceptLabel: label,
    needScore: Math.min(10, Math.max(0, delta)), evidence: [evidence], createdAt: input.now,
    updatedAt: input.now, deletedAt: null });
  return { learningNeeds: [...input.learningNeeds, created], updatedNeed: created };
}

/** Pure, idempotent transition for a review outcome. */
export function applyReviewEvidence(input: {
  learningNeeds: readonly LearningNeed[]; learningNeedId: string | null; memoryId: string;
  resourceId: string; now: string; createId: () => string;
}): { learningNeeds: LearningNeed[]; updatedNeed: LearningNeed | undefined } {
  const index = input.learningNeeds.findIndex(need => need.id === input.learningNeedId && !need.deletedAt);
  if (index < 0) return { learningNeeds: [...input.learningNeeds], updatedNeed: undefined };
  const need = input.learningNeeds[index];
  if (need.evidence.some(item => item.source === 'review' && item.memoryId === input.memoryId && item.recordedAt === input.now)) {
    return { learningNeeds: [...input.learningNeeds], updatedNeed: need };
  }
  const updated = learningNeedSchema.parse({ ...need, revision: need.revision + 1,
    needScore: Math.max(0, need.needScore - 2), evidence: [...need.evidence, { id: input.createId(),
      source: 'review', memoryId: input.memoryId, resourceId: input.resourceId, outcome: 'resolved',
      feedback: 'Marked resolved in Review.', recordedAt: input.now }].slice(-MAX_EVIDENCE_PER_NEED),
    updatedAt: input.now });
  const learningNeeds = [...input.learningNeeds];
  learningNeeds[index] = updated;
  return { learningNeeds, updatedNeed: updated };
}

export function relevantLearningNeeds(learningNeeds: readonly LearningNeed[], subjectId?: string | null, topicId?: string | null): LearningNeed[] {
  return learningNeeds.filter(need => !need.deletedAt && need.needScore > 0
      && (subjectId === undefined || need.subjectId === subjectId)
      && (topicId === undefined || need.topicId === topicId))
    .sort((left, right) => right.needScore - left.needScore || right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 5);
}
