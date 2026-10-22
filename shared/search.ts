import { z } from 'zod';

export const MAX_SEARCH_QUERY_LENGTH = 160;
export const MAX_SEARCH_RESULTS = 40;
export const MAX_SEARCH_SNIPPET_LENGTH = 280;

export const searchTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('resource'), resourceId: z.string().min(1).max(200), questionId: z.string().min(1).max(200).optional() }).strict(),
  z.object({ kind: z.literal('chat'), chatId: z.string().min(1).max(200), messageId: z.string().min(1).max(200).optional() }).strict(),
  z.object({ kind: z.literal('subject'), subjectId: z.string().min(1).max(200) }).strict(),
  z.object({ kind: z.literal('topic'), subjectId: z.string().min(1).max(200), topicId: z.string().min(1).max(200) }).strict(),
  z.object({ kind: z.literal('calendar') }).strict(),
]);

export const searchHighlightSchema = z.tuple([z.number().int().nonnegative(), z.number().int().positive()]).refine(([start, end]) => end > start);

export const searchResultSchema = z.object({
  id: z.string().min(1).max(600),
  kind: z.enum(['chat', 'message', 'resource', 'question', 'subject', 'topic', 'event', 'assignment', 'attachment']),
  label: z.string().min(1).max(300),
  sourceLabel: z.string().min(1).max(100),
  contextLabel: z.string().max(300).optional(),
  snippet: z.string().max(MAX_SEARCH_SNIPPET_LENGTH),
  highlights: z.array(searchHighlightSchema).max(24),
  target: searchTargetSchema,
}).strict();

export const searchResultsSchema = z.array(searchResultSchema).max(MAX_SEARCH_RESULTS);
export const searchQuerySchema = z.string().trim().max(MAX_SEARCH_QUERY_LENGTH);

export type SearchResult = z.infer<typeof searchResultSchema>;
export type SearchTarget = z.infer<typeof searchTargetSchema>;
