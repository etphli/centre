type ConversationMessage = {
  role: 'user' | 'assistant';
  requestContext: { page: string } | null;
};

export function isQuestionAnswer(message: ConversationMessage): boolean {
  return message.role === 'user' && message.requestContext?.page === 'question-answer';
}

/** Keep popup answers in history while presenting them with the response's reasoning. */
export function projectConversation<T extends ConversationMessage>(messages: readonly T[]) {
  const visible: { message: T; questionAnswers: T[] }[] = [];
  let questionAnswers: T[] = [];
  for (const message of messages) {
    if (isQuestionAnswer(message)) questionAnswers.push(message);
    else {
      visible.push({ message, questionAnswers });
      questionAnswers = [];
    }
  }
  return { visible, trailingQuestionAnswers: questionAnswers };
}
