import { z } from 'zod';
import { askQuestionSchema } from '../shared/schema';

export const chatResponseSchema = z.object({
  response:z.union([
    z.object({kind:z.literal('message'),content:z.string().trim().min(1)}).strict(),
    z.object({kind:z.literal('questions'),questions:askQuestionSchema.shape.questions}).strict(),
  ]),
}).strict();

export const questionRoutingInstructions = `Centre has a working question popup. Whenever you ask the student something that needs their answer, use centre_ask_question or return response.kind="questions" with the structured questions. This includes clarifications, preferences, confirmations, one-at-a-time teaching questions, and requests to test the popup such as "ask me if I like blue". The app opens structured questions as a popup and waits for the answer. Use response.kind="message" for explanations and completed work. Put questions directed at the student in the questions route, not in message content. Full quizzes and question lists belong in their requested resource or explanation. Follow an explicit request for plain inline questions when the student specifically wants that format; "ask me a question in chat" means the Centre conversation and still uses its popup. The ask-questions skill is already supplied by the app, so it needs no extra read before asking. Never claim popups are unavailable. Previous chat messages describing old limitations are historical, not current capabilities.`;

export const chatResponseInstructions = `Return the final response using the supplied response schema. For a question, use {"response":{"kind":"questions","questions":[{"id":"answer","header":"Question","question":"Your complete question","options":[]}]}}. Offer two to four distinct choices when useful; an empty options list accepts free text. For a completed answer, use {"response":{"kind":"message","content":"Your Markdown answer"}}. A question returned this way opens the same popup as centre_ask_question. After a successful question-tool call, continue the original task using its result rather than asking the same question again.`;
