import { connectedFileSchema } from './connected-files';
import { connectorStatusSchema } from './connectors';
import { z } from 'zod';
import { Temporal } from '@js-temporal/polyfill';

export const resourceKindSchema = z.enum(['quiz', 'test', 'flashcards', 'diagram', 'notes']);
export type ResourceKind = z.infer<typeof resourceKindSchema>;
export const responseTypeValues = ['multiple_choice', 'short_response', 'long_response'] as const;
export const responseTypeSchema = z.enum(responseTypeValues);
export type ResponseType = z.infer<typeof responseTypeSchema>;
export const allResponseTypes: ResponseType[] = [...responseTypeValues];
export const responseTypesSchema = z.array(responseTypeSchema).min(1).refine(values => new Set(values).size === values.length, 'Choose each response type at most once.');
export const testLengthSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('time'), minutes: z.number().int().min(5).max(180) }),
  z.object({ mode: z.literal('questions'), questionCount: z.number().int().min(1).max(30) }),
]);
export type TestLength = z.infer<typeof testLengthSchema>;
export const subjectSchema = z.object({ id: z.string(), name: z.string(), shortName: z.string().nullable(), color: z.string(), icon: z.string().default('book') });
export const topicSchema = z.object({ id: z.string(), subjectId: z.string(), name: z.string(), description: z.string().default('') });
export const questionSchema = z.object({ id: z.string(), responseType: responseTypeSchema.default('short_response'), choices: z.array(z.string().min(1)).max(6).default([]), prompt: z.string(), answer: z.string(), explanation: z.string().default(''), marks: z.number().int().positive().default(1) });
const generatedQuestionBaseSchema = questionSchema.omit({ id: true });
export const generatedQuestionSchema = z.discriminatedUnion('responseType', [
  generatedQuestionBaseSchema.safeExtend({ responseType: z.literal('multiple_choice'), choices: z.array(z.string().min(1)).min(2).max(6) }).refine(question => question.choices.includes(question.answer), { path: ['answer'], message: 'The answer must exactly match one of the choices.' }),
  generatedQuestionBaseSchema.safeExtend({ responseType: z.literal('short_response'), choices: z.array(z.string()).max(0).default([]) }),
  generatedQuestionBaseSchema.safeExtend({ responseType: z.literal('long_response'), choices: z.array(z.string()).max(0).default([]) }),
]);
export const resourceSchema = z.object({ connectedFile:connectedFileSchema.nullable().optional(), deletedAt:z.string().nullable().optional(), id: z.string(), subjectId: z.string().nullable(), topicId: z.string().nullable(), title: z.string(), kind: resourceKindSchema, createdAt: z.string(), updatedAt: z.string(), content: z.string(), questions: z.array(questionSchema).default([]), questionTypes: responseTypesSchema.default([...allResponseTypes]), testLength: testLengthSchema.nullable().default(null), durationMinutes: z.number().int().min(5).max(180).nullable().default(null), completedAt: z.string().nullable().default(null) }).superRefine((resource, ctx) => {
  resource.questions.forEach((question, index) => {
    if (question.responseType === 'multiple_choice') {
      if (question.choices.length < 2) ctx.addIssue({ code: 'custom', path: ['questions', index, 'choices'], message: 'Multiple-choice questions need at least two choices.' });
      if (!question.choices.includes(question.answer)) ctx.addIssue({ code: 'custom', path: ['questions', index, 'answer'], message: 'The answer must exactly match one of the choices.' });
    } else if (question.choices.length > 0) {
      ctx.addIssue({ code: 'custom', path: ['questions', index, 'choices'], message: 'Only multiple-choice questions can include choices.' });
    }
  });
});
export const attachmentSchema = z.object({ id:z.string().uuid(), name:z.string().min(1).max(200), mimeType:z.string().min(1).max(200), size:z.number().int().positive().max(20 * 1024 * 1024) });
export type Attachment = z.infer<typeof attachmentSchema>;
export const activitySchema = z.object({ id:z.string().min(1).max(200), kind:z.enum(['summary','tool','update','skill']), text:z.string().max(20_000), state:z.enum(['working','done','error']) });
export type Activity = z.infer<typeof activitySchema>;
export const clarificationQuestionSchema = z.object({
  id:z.string().regex(/^[a-zA-Z0-9_-]+$/).max(64),
  header:z.string().trim().min(1).max(60),
  question:z.string().trim().min(1).max(1000),
  options:z.array(z.object({ label:z.string().trim().min(1).max(200), description:z.string().max(500).default('') }).strict()).max(4).default([])
    .refine(options => options.length !== 1 && new Set(options.map(option => option.label)).size === options.length, 'Use two to four distinct choices, or no choices.'),
}).strict();
export const askQuestionSchema = z.object({ questions:z.array(clarificationQuestionSchema).min(1).refine(questions => new Set(questions.map(question => question.id)).size === questions.length, 'Question IDs must be unique.') }).strict();
export const pendingQuestionSchema = askQuestionSchema.extend({ id:z.string().uuid(),chatId:z.string(),createdAt:z.string() });
export type PendingQuestion = z.infer<typeof pendingQuestionSchema>;
export const questionAnswersSchema = z.object({ answers:z.record(z.string().max(64),z.string().trim().min(1).max(4000)).refine(answers => Object.keys(answers).length >= 1) }).strict();
export const messageSchema = z.object({ responseDurationMs:z.number().nonnegative().nullable().default(null), id: z.string(), role: z.enum(['user', 'assistant']), content: z.string(), createdAt: z.string(), resourceIds:z.array(z.string()).default([]), attachmentIds:z.array(z.string().uuid()).max(5).default([]), activity:z.array(activitySchema).max(60).default([]) });
export const modelSelectionSchema = z.object({ model:z.string().min(1).max(200),effort:z.enum(['none','low','medium','high','xhigh','max','ultra']) }).strict();
export type ModelSelection = z.infer<typeof modelSelectionSchema>;
export const chatSchema = z.object({ modelSelection:modelSelectionSchema.nullable().default(null), id: z.string(), title: z.string(), createdAt: z.string(), updatedAt: z.string(), deletedAt: z.string().nullable().default(null), codexThreadId: z.string().nullable().default(null), pinnedAt: z.string().nullable().default(null), folderId: z.string().nullable().default(null), sortOrder: z.number().int().default(0), activity:z.array(activitySchema).max(60).default([]), messages: z.array(messageSchema) });
export const chatFolderSchema = z.object({ id: z.string(), name: z.string(), sortOrder: z.number().int().default(0), collapsed: z.boolean().default(false) });
export const eventSchema = z.object({
  schemaVersion:z.literal(1).default(1), id:z.string(), revision:z.number().int().positive().default(1),
  createdAt:z.iso.datetime().nullable().default(null), updatedAt:z.iso.datetime().nullable().default(null), deletedAt:z.iso.datetime().nullable().default(null),
  origin:z.enum(['centre','organato']).default('organato'), kind:z.enum(['session','deadline']).default('deadline'),
  title:z.string(), date:z.iso.date(), time:z.string().nullable().default(null), startAt:z.iso.datetime().nullable().default(null),
  plannedDurationMinutes:z.number().int().min(5).max(720).nullable().default(null),
  subjectId:z.string().nullable().default(null), notes:z.string().default(''), completedAt:z.string().nullable().default(null),
  organatoId:z.string().nullable().default(null), organatoVersion:z.number().int().positive().nullable().default(null),
  timeZone:z.string().default('Australia/Sydney')
});
/** Canonical Centre-owned planned calendar record. Imported Organato items are projections, not cloud records. */
export const calendarEventSchema = eventSchema.extend({
  id:z.string().uuid(), origin:z.literal('centre'), title:z.string().trim().min(1).max(200),
  schemaVersion:z.literal(1), revision:z.number().int().positive(),
  createdAt:z.iso.datetime(), updatedAt:z.iso.datetime(), completedAt:z.iso.datetime().nullable(),
  time:z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).nullable(), notes:z.string().max(20000),
  timeZone:z.string().max(100).refine(value => { try { new Intl.DateTimeFormat('en',{timeZone:value}); return true; } catch { return false; } },'Choose a valid IANA time zone.'),
}).strict().superRefine((event,context) => {
  if (event.kind === 'session' && (!event.time || !event.startAt || !event.plannedDurationMinutes)) context.addIssue({code:'custom',path:['time'],message:'A planned session needs a start time, instant and planned duration.'});
  if (event.kind === 'deadline' && event.plannedDurationMinutes !== null) context.addIssue({code:'custom',path:['plannedDurationMinutes'],message:'A deadline has no planned study duration.'});
  if (event.kind === 'deadline' && (event.time || event.startAt)) context.addIssue({code:'custom',path:['time'],message:'A Centre deadline is an all-day date.'});
  if (event.kind === 'session' && event.time && event.startAt) {
    try {
      const expected = Temporal.PlainDate.from(event.date).toPlainDateTime(Temporal.PlainTime.from(event.time)).toZonedDateTime(event.timeZone,{disambiguation:'reject'}).toInstant();
      if (!expected.equals(Temporal.Instant.from(event.startAt))) context.addIssue({code:'custom',path:['startAt'],message:'The start instant must match the date, time and time zone.'});
    } catch { context.addIssue({code:'custom',path:['time'],message:'Choose a valid, unambiguous local start time.'}); }
  }
});
export type CalendarEvent = z.infer<typeof calendarEventSchema>;
export const assignmentSchema = z.object({ id: z.string(), title: z.string(), kind: z.enum(['work', 'todo']), subjectId: z.string().nullable(), dueDate: z.string().nullable(), status: z.string(), version: z.number() });
export const memorySchema = z.object({ id: z.string(), subjectId: z.string().nullable(), topicId: z.string().nullable(), resourceId: z.string(), question: z.string(), note: z.string(), createdAt: z.string(), nextReviewAt: z.string(), resolvedAt: z.string().nullable().default(null) });
export const rememberInputSchema = z.object({ key:z.string().trim().min(1).max(80),content:z.string().trim().min(1).max(1000) }).strict();
export const assistantMemorySchema = rememberInputSchema.extend({ id:z.string().uuid(),createdAt:z.string().datetime(),updatedAt:z.string().datetime() });
export const accountSchema = z.object({ name: z.string(), email: z.string(), picture: z.string().optional() });
export const gradeResultSchema = z.object({ score: z.number(), total: z.number(), feedback: z.array(z.object({ questionId: z.string(), score: z.number(), maxScore: z.number(), feedback: z.string(), needsReview: z.boolean() })) });
export const attemptSchema = z.object({ id: z.string(), resourceId: z.string(), answers: z.record(z.string(), z.string()), result: gradeResultSchema, createdAt: z.string() });
export const reasoningEffortSchema = z.enum(['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
export const modelSchema = z.object({ id: z.string(), name: z.string(), reasoningEfforts: z.array(reasoningEffortSchema), defaultReasoningEffort: reasoningEffortSchema });
export const preferencesSchema = z.object({ nickname: z.string().trim().max(60).default(''), theme: z.enum(['dark', 'light', 'midnight', 'system']).default('dark'), density: z.enum(['compact', 'comfortable']).default('compact'), textSize: z.enum(['small', 'standard', 'large']).default('standard'), studentYearLevel: z.number().int().min(7).max(12).default(9), timeZone: z.string().max(100).refine(value => { try { new Intl.DateTimeFormat('en',{timeZone:value}); return true; } catch { return false; } },'Choose a valid IANA time zone.').default('Australia/Sydney'), responseStyle: z.enum(['concise', 'balanced', 'detailed']).default('balanced'), defaultQuizQuestions: z.number().int().min(1).max(30).default(8), defaultTestLengthMode: z.enum(['time', 'questions']).default('time'), defaultTestMinutes: z.number().int().min(5).max(180).default(45), defaultTestQuestions: z.number().int().min(1).max(30).default(10), defaultQuizQuestionTypes: responseTypesSchema.default([...allResponseTypes]), defaultTestQuestionTypes: responseTypesSchema.default([...allResponseTypes]), defaultDifficulty: z.enum(['gentle', 'standard', 'challenging']).default('standard') });
export const settingsSchema = z.object({ connectors: z.array(connectorStatusSchema).default([]), organatoBaseUrl: z.string().default('https://organato.vercel.app/api/v1'), organatoConnected: z.boolean().default(false), googleClientId: z.string().default(''), account: accountSchema.nullable().default(null), chatModel: z.string().min(1).default('gpt-6.1-sol'), reasoningEffort: reasoningEffortSchema.default('medium'), gradingModel: z.string().min(1).default('gpt-6-luna'), gradingReasoningEffort: reasoningEffortSchema.default('medium'), ...preferencesSchema.shape });
export const snapshotSchema = z.object({ activeResponses:z.array(z.object({chatId:z.string(),startedAt:z.number().nonnegative(),status:z.enum(['working','stopping'])})).default([]), pendingQuestions:z.array(pendingQuestionSchema).default([]), subjects: z.array(subjectSchema), topics: z.array(topicSchema), resources: z.array(resourceSchema), chats: z.array(chatSchema), chatFolders: z.array(chatFolderSchema).default([]), events: z.array(eventSchema), memories: z.array(memorySchema), assistantMemories:z.array(assistantMemorySchema).max(50).default([]), assignments: z.array(assignmentSchema), attempts: z.array(attemptSchema).default([]), settings: settingsSchema, codex: z.object({ available: z.boolean(), authenticated: z.boolean(), message: z.string() }), lastSyncedAt: z.string().nullable(), syncError: z.string().nullable().default(null) });
export const contextSchema = z.object({ page: z.string(), subjectId: z.string().optional(), topicId: z.string().optional(), resourceId: z.string().optional() });
export const resourceLocationSchema = z.object({subjectId:z.string().min(1).nullable(),topicId:z.string().min(1).nullable()}).strict().refine(location => (location.subjectId === null) === (location.topicId === null), 'Choose a subject and topic together, or personal learning.');
const createResourceBaseShape = { subjectId: z.string().min(1).nullable(), topicId: z.string().min(1).nullable(), title: z.string().optional(), instructions: z.string().default(''), difficulty: z.enum(['gentle', 'standard', 'challenging']).default('standard') };
const createResourceToolBaseShape = createResourceBaseShape;
export const flashcardCountSchema = z.union([z.literal('auto'), z.number().int().min(1).max(30)]);
export const createResourceVariants = [
  z.object({ kind: z.literal('quiz'), ...createResourceBaseShape, questionCount: z.number().int().min(1).max(30).default(8), questionTypes: responseTypesSchema.default([...allResponseTypes]) }),
  z.object({ kind: z.literal('test'), ...createResourceBaseShape, testLength: testLengthSchema.default({ mode: 'time', minutes: 45 }), questionTypes: responseTypesSchema.default([...allResponseTypes]) }),
  z.object({ kind: z.literal('flashcards'), ...createResourceBaseShape, questionCount: flashcardCountSchema.default('auto') }),
  z.object({ kind: z.literal('diagram'), ...createResourceBaseShape }),
  z.object({ kind: z.literal('notes'), ...createResourceBaseShape }),
] as const;
export const createResourceSchema = z.discriminatedUnion('kind', createResourceVariants);
export const createResourceToolVariants = [
  z.object({ kind: z.literal('quiz'), ...createResourceToolBaseShape, questionCount: z.number().int().min(1).max(30), questionTypes: responseTypesSchema }),
  z.object({ kind: z.literal('test'), ...createResourceToolBaseShape, testLength: testLengthSchema, questionTypes: responseTypesSchema }),
  z.object({ kind: z.literal('flashcards'), ...createResourceToolBaseShape, questionCount: flashcardCountSchema }),
  z.object({ kind: z.literal('diagram'), ...createResourceToolBaseShape }),
  z.object({ kind: z.literal('notes'), ...createResourceToolBaseShape }),
] as const;
export const feedbackSchema = z.object({ resourceId: z.string(), notes: z.string().max(20000).default(''), questionIds: z.array(z.string()).default([]), confident: z.boolean().default(false) });
export const gradeSchema = z.object({ resourceId: z.string(), answers: z.record(z.string(), z.string()) });
export type Subject = z.infer<typeof subjectSchema>;
export type Topic = z.infer<typeof topicSchema>;
export type Resource = z.infer<typeof resourceSchema>;
export type Chat = z.infer<typeof chatSchema>;
export type ChatFolder = z.infer<typeof chatFolderSchema>;
export type StudyEvent = z.infer<typeof eventSchema>;
export type Assignment = z.infer<typeof assignmentSchema>;
export type StudyMemory = z.infer<typeof memorySchema>;
export type Snapshot = z.infer<typeof snapshotSchema>;
export type PageContext = z.infer<typeof contextSchema>;
export type CreateResource = z.infer<typeof createResourceSchema>;
export type GradeResult = z.infer<typeof gradeResultSchema>;
