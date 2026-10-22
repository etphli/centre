import { z } from 'zod';
import { chatSchema, contextSchema, messageSchema, type Chat, type Message } from './schema';

export const syncedChatSchema = chatSchema.pick({
  id:true, title:true, createdAt:true, updatedAt:true, deletedAt:true,
  pinnedAt:true, folderId:true, sortOrder:true, modelSelection:true, lineage:true,
}).strict();
export const syncedMessageSchema = messageSchema.pick({
  id:true, role:true, content:true, createdAt:true, responseDurationMs:true,
  resourceIds:true, attachmentIds:true,
}).extend({ chatId:z.string(), requestContext:contextSchema.strict().nullable() }).strict();

export function projectChatForSync(chat: Chat): z.infer<typeof syncedChatSchema> {
  return syncedChatSchema.parse({
    id:chat.id, title:chat.title, createdAt:chat.createdAt, updatedAt:chat.updatedAt,
    deletedAt:chat.deletedAt, pinnedAt:chat.pinnedAt, folderId:chat.folderId,
    sortOrder:chat.sortOrder, modelSelection:chat.modelSelection, lineage:chat.lineage,
  });
}

export function projectMessageForSync(message: Message, chatId: string): z.infer<typeof syncedMessageSchema> {
  const context = message.requestContext;
  return syncedMessageSchema.parse({
    id:message.id, chatId, role:message.role, content:message.content,
    createdAt:message.createdAt, responseDurationMs:message.responseDurationMs,
    resourceIds:message.resourceIds, attachmentIds:message.attachmentIds,
    requestContext:context === null ? null : {
      page:context.page, ...(context.subjectId === undefined ? {} : {subjectId:context.subjectId}),
      ...(context.topicId === undefined ? {} : {topicId:context.topicId}),
      ...(context.resourceId === undefined ? {} : {resourceId:context.resourceId}),
    },
  });
}
