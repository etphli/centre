import { z } from 'zod';

export const checklistItemIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
export const explicitChecklistItemIdSchema = checklistItemIdSchema.refine(id => !/^legacy-[1-9]\d*$/.test(id), 'The legacy item ID namespace is reserved.');
export const checklistDocumentRevisionSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const checklistItemIdsSchema = z.array(checklistItemIdSchema).max(100).refine(ids => new Set(ids).size === ids.length, 'Checklist item IDs must be unique.');

export const interactiveResourceProgressSchema = z.object({
  schemaVersion:z.literal(1),
  id:z.string().uuid(),
  revision:z.number().int().positive(),
  resourceId:z.string().min(1).max(200),
  documentRevision:checklistDocumentRevisionSchema,
  checkedItemIds:checklistItemIdsSchema.refine(ids => [...ids].sort().every((id,index) => id === ids[index]), 'Checked checklist item IDs must be sorted.'),
  createdAt:z.string().datetime(),
  updatedAt:z.string().datetime(),
  deletedAt:z.string().datetime().nullable().default(null),
}).strict();

export type InteractiveResourceProgress = z.infer<typeof interactiveResourceProgressSchema>;

export async function interactiveResourceProgressId(resourceId:string, documentRevision:string):Promise<string> {
  z.string().min(1).max(200).parse(resourceId);
  checklistDocumentRevisionSchema.parse(documentRevision);
  const input = new TextEncoder().encode(`centre:interactiveProgress:v1\0${resourceId}\0${documentRevision}`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256',input)).slice(0,16);
  digest[6] = (digest[6] & 0x0f) | 0x80;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = [...digest].map(byte => byte.toString(16).padStart(2,'0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

export function validateInteractiveResourceProgress(value: unknown): InteractiveResourceProgress {
  return interactiveResourceProgressSchema.parse(value);
}

export type InteractiveResourceProgressMerge =
  | { kind:'same'; value:InteractiveResourceProgress }
  | { kind:'local'; value:InteractiveResourceProgress }
  | { kind:'incoming'; value:InteractiveResourceProgress }
  | { kind:'conflict'; reason:'record-identity'|'document-revision'|'equal-revision'; local:InteractiveResourceProgress; incoming:InteractiveResourceProgress };

/**
 * Merge two validated entity records without timestamp-based last-write-wins.
 * Domain revision orders edits; concurrent edits at the same revision remain
 * an explicit conflict for the sync client to resolve.
 */
export function mergeInteractiveResourceProgress(localValue: unknown, incomingValue: unknown): InteractiveResourceProgressMerge {
  const local = validateInteractiveResourceProgress(localValue);
  const incoming = validateInteractiveResourceProgress(incomingValue);
  if (local.id !== incoming.id || local.resourceId !== incoming.resourceId) {
    return { kind:'conflict', reason:'record-identity', local, incoming };
  }
  if (local.documentRevision !== incoming.documentRevision) {
    return { kind:'conflict', reason:'document-revision', local, incoming };
  }
  if (local.revision > incoming.revision) return { kind:'local', value:local };
  if (incoming.revision > local.revision) return { kind:'incoming', value:incoming };

  const sameCheckedItems = local.checkedItemIds.length === incoming.checkedItemIds.length
    && local.checkedItemIds.every((itemId,index) => itemId === incoming.checkedItemIds[index]);
  if (!sameCheckedItems || local.deletedAt !== incoming.deletedAt) {
    return { kind:'conflict', reason:'equal-revision', local, incoming };
  }
  return { kind:'same', value:local };
}

export const checklistProgressUpdateSchema = z.object({
  documentRevision: checklistDocumentRevisionSchema,
  itemId: checklistItemIdSchema,
  checked: z.boolean(),
}).strict();

export const diagramPreviewSchema = z.object({
  url: z.string().url(),
  documentRevision: checklistDocumentRevisionSchema,
  itemIds: checklistItemIdsSchema,
  checkedItemIds: checklistItemIdsSchema,
  hasProgress: z.boolean(),
}).strict();

const readyMessageSchema = z.object({
  type: z.literal('centre:checklist-ready'),
  resourceId: z.string().min(1).max(200),
  documentRevision: checklistDocumentRevisionSchema,
}).strict();

const changeMessageSchema = z.object({
  type: z.literal('centre:checklist-change'),
  resourceId: z.string().min(1).max(200),
  documentRevision: checklistDocumentRevisionSchema,
  itemId: checklistItemIdSchema,
  checked: z.boolean(),
}).strict();

export type ChecklistBridgeMessage =
  | { type: 'centre:checklist-ready'; resourceId: string; documentRevision: string }
  | { type: 'centre:checklist-change'; resourceId: string; documentRevision: string; itemId: string; checked: boolean };

export type AcceptedChecklistBridgeMessage =
  | { type: 'ready' }
  | { type: 'change'; itemId: string; checked: boolean };

export const MAX_CHECKLIST_BRIDGE_MESSAGE_BYTES = 2048;

function boundedMessageSize(value: unknown): number | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    const fields = Object.values(value);
    if (fields.length > 8 || fields.some(field => typeof field === 'object' && field !== null)) return null;
    if (fields.some(field => typeof field === 'string' && field.length > MAX_CHECKLIST_BRIDGE_MESSAGE_BYTES)) return null;
    const serialized = JSON.stringify(value);
    return serialized === undefined ? null : new TextEncoder().encode(serialized).byteLength;
  } catch {
    return null;
  }
}

export function validateChecklistBridgeMessage(
  source: unknown,
  expectedSource: unknown,
  value: unknown,
  expectedResourceId: string,
  expectedDocumentRevision: string,
  allowedItemIds: ReadonlySet<string>,
): AcceptedChecklistBridgeMessage | null {
  if (!expectedSource || source !== expectedSource) return null;
  const byteLength = boundedMessageSize(value);
  if (byteLength === null || byteLength > MAX_CHECKLIST_BRIDGE_MESSAGE_BYTES) return null;

  const ready = readyMessageSchema.safeParse(value);
  if (ready.success) {
    return ready.data.resourceId === expectedResourceId && ready.data.documentRevision === expectedDocumentRevision
      ? { type: 'ready' }
      : null;
  }

  const change = changeMessageSchema.safeParse(value);
  if (!change.success || change.data.resourceId !== expectedResourceId || change.data.documentRevision !== expectedDocumentRevision || !allowedItemIds.has(change.data.itemId)) return null;
  return { type: 'change', itemId: change.data.itemId, checked: change.data.checked };
}
