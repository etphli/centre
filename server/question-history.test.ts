import assert from 'node:assert/strict';
import test from 'node:test';
import { chatSchema } from '../shared/schema';
import { markLegacyQuestionAnswers } from './question-history';
import { projectConversation } from '../shared/conversation';

test('completed legacy popups are tagged only when local turn checkpoints prove their origin',() => {
  const chat = chatSchema.parse({id:'chat',title:'Chat',createdAt:'now',updatedAt:'now',messages:[
    {id:'abandoned',role:'user',content:'Earlier cancelled prompt',createdAt:'now'},
    {id:'prompt',role:'user',content:'Original prompt',createdAt:'now'},
    {id:'answer',role:'user',content:'Which format?\nAll three types',createdAt:'now'},
    {id:'reply',role:'assistant',content:'Ready',createdAt:'now',codexTurns:[{turnId:'local-turn',promptMessageId:'prompt'}]},
    {id:'ordinary',role:'user',content:'Another question?\nYes',createdAt:'now'},
  ]});
  assert.equal(markLegacyQuestionAnswers(chat),true);
  assert.deepEqual(projectConversation(chat.messages).visible.map(item => item.message.id),['abandoned','prompt','reply','ordinary']);
  assert.equal(chat.messages[2]?.content,'Which format?\nAll three types');
  assert.equal(markLegacyQuestionAnswers(chat),false,'Migration is idempotent.');
});
