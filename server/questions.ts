import { randomUUID } from 'node:crypto';
import { askQuestionSchema, questionAnswersSchema, type PendingQuestion } from '../shared/schema';
import { HttpError } from './errors';

type Answers = ReturnType<typeof questionAnswersSchema.parse>['answers'];
type WaitingQuestion = { request:PendingQuestion; resolve:(answers:Answers) => void; reject:(error:Error) => void; submitting:boolean };

// Requests belong to a running turn, so keep them out of the persistent store.
export class Questions {
  private readonly waiting = new Map<string,WaitingQuestion>();
  list() { return [...this.waiting.values()].map(value => value.request); }
  ask(chatId:string, input:unknown):Promise<Answers> {
    const parsed = askQuestionSchema.parse(input);
    if (this.list().some(request => request.chatId === chatId)) throw new HttpError(409,'This chat already has a question waiting.');
    const request = { ...parsed,id:randomUUID(),chatId,createdAt:new Date().toISOString() };
    return new Promise((resolve,reject) => this.waiting.set(request.id,{ request,resolve,reject,submitting:false }));
  }
  async answer(id:string, input:unknown, save:(request:PendingQuestion, answers:Answers) => Promise<void>) {
    const pending = this.waiting.get(id);
    if (!pending) throw new HttpError(409,'This question is no longer waiting for an answer.');
    if (pending.submitting) throw new HttpError(409,'This answer is already being saved.');
    const { answers } = questionAnswersSchema.parse(input);
    const ids = pending.request.questions.map(question => question.id);
    if (ids.length !== Object.keys(answers).length || ids.some(id => !Object.hasOwn(answers,id))) throw new HttpError(400,'Answer each question exactly once.');
    pending.submitting = true;
    try {
      await save(pending.request,answers);
      if (this.waiting.get(id) !== pending) throw new HttpError(409,'This question was cancelled.');
      this.waiting.delete(id);
      pending.resolve(answers);
    } finally { pending.submitting = false; }
  }
  cancel(chatId:string) {
    for (const [id,pending] of this.waiting) if (pending.request.chatId === chatId) {
      this.waiting.delete(id);
      pending.reject(new HttpError(409,'The question was cancelled. Stop this response without taking the proposed action.'));
    }
  }
  close() { for (const pending of this.list()) this.cancel(pending.chatId); }
}
