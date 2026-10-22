import { z } from "zod";
import {
  topicSchema,
  resourceSchema,
  chatFolderSchema,
  attemptSchema,
  memorySchema,
  assistantMemorySchema,
  preferencesSchema,
  attachmentSchema,
  calendarEventSchema,
} from "./schema";
import { studySessionSchema, weeklyStudyGoalSchema } from "./study-log";
import {
  quizDraftSchema,
  attemptSchema as practiceAttemptSchema,
  learningNeedSchema,
} from "./practice";
import { interactiveResourceProgressSchema } from "./checklist-progress";
import { syncedChatSchema, syncedMessageSchema } from "./chat-sync";
export { syncedChatSchema, syncedMessageSchema } from "./chat-sync";
export const cloudAttachmentSchema = attachmentSchema
  .extend({ sha256: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
const { connectedFile: _connectedFile, ...portableResourceShape } =
  resourceSchema.shape;
const portableResourceSchema = z
  .object(portableResourceShape)
  .strict()
  .transform((value) => resourceSchema.parse(value));
export const cloudEntitySchemas: Record<string, z.ZodType> = {
  topic: topicSchema.strict(),
  resource: portableResourceSchema,
  chat: syncedChatSchema,
  message: syncedMessageSchema,
  chatFolder: chatFolderSchema.strict(),
  attempt: attemptSchema.strict(),
  reviewMemory: memorySchema.strict(),
  learnerMemory: assistantMemorySchema.strict(),
  preferences: preferencesSchema.strict(),
  interactiveProgress: interactiveResourceProgressSchema,
  studySession: studySessionSchema,
  studyGoal: weeklyStudyGoalSchema,
  "practice.draft": quizDraftSchema,
  "practice.attempt": practiceAttemptSchema,
  "practice.learningNeed": learningNeedSchema,
  calendarEvent: calendarEventSchema,
  attachment: cloudAttachmentSchema,
};
export const CLOUD_ENTITY_KINDS = Object.keys(cloudEntitySchemas);
export function parseCloudEntity(
  kind: string,
  data: unknown,
): Record<string, unknown> {
  const schema = cloudEntitySchemas[kind];
  if (!schema) throw new Error("Unsupported entity kind.");
  return z.record(z.string(), z.unknown()).parse(schema.parse(data));
}
