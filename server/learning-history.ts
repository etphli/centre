import { randomUUID } from 'node:crypto';
import type { GradeResult, LearningNeed, Resource, Snapshot } from '../shared/schema';
import { applyGradeEvidence, applyReviewEvidence, relevantLearningNeeds as selectRelevantLearningNeeds } from '../shared/practice';

export { normalizeConceptKey } from '../shared/practice';

export function updateLearningNeedFromGrade(input: {
  state: Snapshot;
  resource: Resource;
  question: Resource['questions'][number];
  feedback: GradeResult['feedback'][number];
  attemptId: string;
  topicName: string;
  now: string;
}): LearningNeed | undefined {
  const transition = applyGradeEvidence({ learningNeeds: input.state.learningNeeds,
    subjectId: input.resource.subjectId, topicId: input.resource.topicId, resourceId: input.resource.id,
    questionId: input.question.id, questionConcept: input.question.concept, concept: input.feedback.concept,
    topicName: input.topicName, feedback: input.feedback, attemptId: input.attemptId, now: input.now,
    createId: randomUUID });
  input.state.learningNeeds = transition.learningNeeds;
  return transition.updatedNeed;
}

export function recordReviewResolution(input: {
  state: Snapshot;
  memoryId: string;
  learningNeedId: string | null;
  resourceId: string;
  now: string;
}): void {
  const transition = applyReviewEvidence({ learningNeeds: input.state.learningNeeds,
    memoryId: input.memoryId, learningNeedId: input.learningNeedId, resourceId: input.resourceId,
    now: input.now, createId: randomUUID });
  input.state.learningNeeds = transition.learningNeeds;
}

export function relevantLearningNeeds(state: Snapshot, subjectId?: string | null, topicId?: string | null): LearningNeed[] {
  return selectRelevantLearningNeeds(state.learningNeeds, subjectId, topicId);
}
