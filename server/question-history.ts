import type { Chat } from '../shared/schema';

/** Turn checkpoints identify popup answers inserted after the actual student prompt. */
export function markLegacyQuestionAnswers(chat: Chat): boolean {
  let changed = false;
  for (let index = 0; index < chat.messages.length; index++) {
    const reply = chat.messages[index]!;
    if (reply.role !== 'assistant') continue;
    const promptId = reply.codexTurns[0]?.promptMessageId;
    if (!promptId) continue;
    const promptIndex = chat.messages.findIndex(message => message.id === promptId && message.role === 'user');
    if (promptIndex < 0 || promptIndex >= index) continue;
    const between = chat.messages.slice(promptIndex + 1,index);
    if (between.some(message => message.role !== 'user')) continue;
    for (const message of between) {
      const prompt = chat.messages[promptIndex]!;
      for (const resourceId of message.resourceIds) {
        if (!prompt.resourceIds.includes(resourceId)) { prompt.resourceIds.push(resourceId); changed = true; }
      }
      if (message.requestContext?.page === 'question-answer') continue;
      message.requestContext = { ...message.requestContext,page:'question-answer' };
      changed = true;
    }
  }
  return changed;
}
