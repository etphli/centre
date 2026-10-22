import { createHash } from 'node:crypto';
import { checklistProgressUpdateSchema, interactiveResourceProgressId, interactiveResourceProgressSchema, type InteractiveResourceProgress } from '../shared/checklist-progress';
import type { Resource } from '../shared/schema';
import type { Store } from './store';
import { prepareChecklistContent } from './diagram';
import { HttpError, requireFound } from './errors';

export function checklistDocumentRevision(content:string) {
  return createHash('sha256').update(content).digest('hex');
}

export function checklistPreview(store:Store, resource:Resource) {
  const documentRevision = checklistDocumentRevision(resource.content);
  const prepared = prepareChecklistContent(resource.content);
  const progress = store.state.interactiveResourceProgress.find(item => item.resourceId === resource.id && item.documentRevision === documentRevision && !item.deletedAt);
  return {
    documentRevision,
    itemIds:prepared.itemIds,
    checkedItemIds:progress?.checkedItemIds.filter(id => prepared.itemIds.includes(id)) ?? prepared.checkedItemIds,
    hasProgress:progress !== undefined,
  };
}

export async function updateChecklistProgress(store:Store, resourceId:string, value:unknown):Promise<{ok:true}> {
  const input = checklistProgressUpdateSchema.parse(value);
  const id = await interactiveResourceProgressId(resourceId,input.documentRevision);
  await store.update('interactiveResourceProgress',progress => {
    const resource = requireFound(store.state.resources.find(item => item.id === resourceId && !item.deletedAt),'Resource');
    if (resource.kind !== 'diagram') throw new HttpError(400,'Checklist progress is available only for interactive diagrams.');
    const documentRevision = checklistDocumentRevision(resource.content);
    if (input.documentRevision !== documentRevision) throw new HttpError(409,'This checklist changed. Reload the resource before saving progress.');
    const prepared = prepareChecklistContent(resource.content);
    if (!prepared.itemIds.includes(input.itemId)) throw new HttpError(400,'This checklist item is not part of the current resource.');
    const existing = progress.find(item => item.resourceId === resourceId && item.documentRevision === documentRevision && !item.deletedAt);
    const baseline = existing?.checkedItemIds.filter(itemId => prepared.itemIds.includes(itemId)) ?? prepared.checkedItemIds;
    const checked = new Set(baseline);
    if (input.checked) checked.add(input.itemId); else checked.delete(input.itemId);
    const checkedItemIds = [...checked].sort();
    const originalCheckedItemIds = [...baseline].sort();
    if (checkedItemIds.length === originalCheckedItemIds.length && checkedItemIds.every((itemId,index) => itemId === originalCheckedItemIds[index])) return undefined;
    const now = new Date().toISOString();
    const next:InteractiveResourceProgress = interactiveResourceProgressSchema.parse({
      schemaVersion:1,
      id:existing?.id ?? id,
      revision:(existing?.revision ?? 0) + 1,
      resourceId,
      documentRevision,
      checkedItemIds,
      createdAt:existing?.createdAt ?? now,
      updatedAt:now,
      deletedAt:null,
    });
    return existing ? progress.map(item => item === existing ? next : item) : [...progress,next];
  });
  return {ok:true};
}
