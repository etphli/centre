import assert from 'node:assert/strict';
import test from 'node:test';
import { projectConversation } from './conversation';
import { messageSchema } from './schema';
import { projectMessageForSync, syncedMessageSchema } from './chat-sync';

const message = (id:string,role:'user'|'assistant',page='chat') => messageSchema.parse({id,role,content:id,createdAt:'2026-10-28T10:00:00Z',requestContext:{page}});

test('popup answers survive sync and appear once in response reasoning, without altering ordinary prompts',() => {
  const records = [message('prompt','user'),message('question\nanswer','user','question-answer'),message('next question\nnext answer','user','question-answer'),message('reply','assistant')];
  const synced = records.map(item => syncedMessageSchema.parse(JSON.parse(JSON.stringify(projectMessageForSync(item,'chat')))));
  const projected = projectConversation(synced);
  assert.deepEqual(projected.visible.map(item => item.message.content),['prompt','reply']);
  assert.deepEqual(projected.visible[1]?.questionAnswers.map(item => item.content),['question\nanswer','next question\nnext answer']);
  assert.deepEqual(projected.trailingQuestionAnswers,[]);
  assert.equal(records.length,4,'Projection must preserve backend history.');
});

test('pending and failed replies retain answers, and untagged or assistant messages are never hidden',() => {
  const prompt = message('prompt','user');
  const answer = message('answer','user','question-answer');
  const pending = projectConversation([prompt,answer]);
  assert.deepEqual(pending.visible.map(item => item.message.id),['prompt']);
  assert.deepEqual(pending.trailingQuestionAnswers,[answer]);
  const next = message('new request','user');
  const assistant = message('assistant','assistant','question-answer');
  const recovered = projectConversation([prompt,answer,next,assistant]);
  assert.deepEqual(recovered.visible.map(item => item.message.id),['prompt','new request','assistant']);
  assert.deepEqual(recovered.visible[1]?.questionAnswers,[answer]);
});
