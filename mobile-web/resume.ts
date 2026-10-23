import type { Resource } from '../shared/schema';
import type { QuizDraft } from '../shared/practice';

export function latestUnfinishedQuiz(resources: readonly Resource[], drafts: readonly QuizDraft[]) {
  const available = new Map(resources.filter(resource => !resource.deletedAt && (resource.kind === 'quiz' || resource.kind === 'test')).map(resource => [resource.id, resource]));
  return drafts.filter(draft => !draft.deletedAt).flatMap(draft => {
    const resource = available.get(draft.resourceId);
    if (!resource) return [];
    const answered = resource.questions.filter(question => draft.answers[question.id]?.trim()).length;
    return answered ? [{ resource, draft, answered }] : [];
  }).sort((a, b) => Date.parse(b.draft.updatedAt) - Date.parse(a.draft.updatedAt) || a.draft.id.localeCompare(b.draft.id))[0] ?? null;
}
