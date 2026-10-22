import { z } from 'zod';
import { askQuestionSchema, createResourceToolVariants } from '../shared/schema';
import { generatedResourceSchema } from './resources';

const resourceTitle = {title:z.string().nullable()};
const resourceRequestSchema = z.union([
  createResourceToolVariants[0].extend(resourceTitle).strict(),
  createResourceToolVariants[1].extend(resourceTitle).strict(),
  createResourceToolVariants[2].extend(resourceTitle).strict(),
  createResourceToolVariants[3].extend(resourceTitle).strict(),
  createResourceToolVariants[4].extend(resourceTitle).strict(),
]);

export const chatResponseSchema = z.object({
  response:z.union([
    z.object({kind:z.literal('message'),content:z.string().trim().min(1),resourceIds:z.array(z.string()).max(20).default([])}).strict(),
    z.object({kind:z.literal('questions'),questions:askQuestionSchema.shape.questions}).strict(),
    z.object({kind:z.literal('resource'),request:resourceRequestSchema,generated:generatedResourceSchema}).strict(),
  ]),
}).strict();

export const questionRoutingInstructions = `Centre has a working question popup. Whenever you ask the student something that needs their answer, use centre_ask_question or return response.kind="questions" with the structured questions. This includes clarifications, preferences, confirmations, one-at-a-time teaching questions, and requests to test the popup such as "ask me if I like blue". The app opens structured questions as a popup and waits for the answer. Use response.kind="message" for explanations and completed work. Put questions directed at the student in the questions route, not in message content. Full quizzes and question lists belong in their requested resource or explanation. Follow an explicit request for plain inline questions when the student specifically wants that format; "ask me a question in chat" means the Centre conversation and still uses its popup. The ask-questions skill is already supplied by the app, so it needs no extra read before asking. Never claim popups are unavailable. Previous chat messages describing old limitations are historical, not current capabilities.`;

export const chatResponseInstructions = `Return the final response using the supplied response schema. For a question, use {"response":{"kind":"questions","questions":[{"id":"answer","header":"Question","question":"Your complete question","options":[]}]}}. Offer two to four distinct choices when useful; an empty options list accepts free text. A question returned this way opens the same popup as centre_ask_question. After a successful question-tool call, continue the original task using its result rather than asking the same question again.

When the student asks to create a quiz, test, flashcards, diagram or notes, create the complete resource now. Prefer response.kind="resource" with request containing the kind, subjectId and topicId (both null for personal learning), title (null to choose one), instructions, difficulty and the kind-specific choices, and generated containing title, content and questions. Centre validates, saves and displays that output automatically. Diagrams need complete self-contained HTML in generated.content and an empty questions array. Notes need Markdown content. Quizzes, tests and flashcards need actual structured questions and answers. Give each question a concise concept label; reuse a matching learningHistory label when it describes the same skill. Use relevant recent graded evidence to target practice, while the student's current request takes priority. The app identifies practice focus only where question concepts match actual learning evidence. Use the requested counts and response types. Only ask for genuinely missing quiz or test format choices. Do not finish with an offer to create, a claim of unavailable tools, a code block for the student to save, or a progress-only message. If centre_save_resource already succeeded, use the message route to report that result instead of returning the same resource again.

For explanations, plain text requested by the student, and work already saved successfully through a tool, use {"response":{"kind":"message","content":"Your Markdown answer","resourceIds":[]}}. When asked to show or reopen previous work, include its exact existing IDs from savedResources or centre_get_state in resourceIds. Centre displays the original saved resources below your message. Never recreate a resource merely to show it. Use an empty array when no resource is relevant.`;
