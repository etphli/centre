import assert from 'node:assert/strict';
import test from 'node:test';
import { askQuestionSchema } from '../shared/schema';
import { Questions } from './questions';

const input = {questions:[{id:'format',header:'Quiz format',question:'How should the quiz work?',options:[{label:'Mixed',description:'Multiple choice and short response'},{label:'Short response'}]}]};

test('question requests wait for validated answers and resolve once after saving',async () => {
  const questions = new Questions();
  const pending = questions.ask('chat-a',input);
  const request = questions.list()[0]; assert.ok(request);
  await assert.rejects(questions.answer(request.id,{answers:{wrong:'Mixed'}},async () => {}),/Answer each/);
  await assert.rejects(questions.answer(request.id,{answers:{format:' '}},async () => {}));
  assert.throws(() => questions.ask('chat-a',input),/already has a question/);
  await assert.rejects(questions.answer(request.id,{answers:{format:'Mixed'}},async () => { throw new Error('Disk unavailable'); }),/Disk unavailable/);
  assert.equal(questions.list().length,1);
  let saved = false;
  await questions.answer(request.id,{answers:{format:'My own format'}},async (value,answers) => {
    assert.equal(value.chatId,'chat-a'); assert.equal(answers.format,'My own format'); saved = true;
  });
  assert.equal(saved,true); assert.deepEqual(await pending,{format:'My own format'});
  assert.equal(questions.list().length,0);
  await assert.rejects(questions.answer(request.id,{answers:{format:'Mixed'}},async () => {}),/no longer waiting/);
});

test('cancelling a question affects only its chat and shutdown clears all waiters',async () => {
  const questions = new Questions();
  const first = assert.rejects(questions.ask('chat-a',input),/cancelled/);
  const second = assert.rejects(questions.ask('chat-b',input),/cancelled/);
  questions.cancel('chat-a'); await first;
  assert.deepEqual(questions.list().map(request => request.chatId),['chat-b']);
  questions.close(); await second; assert.deepEqual(questions.list(),[]);
});

test('question schemas reject ambiguous choices and accept free text and bounded batches',() => {
  assert.equal(askQuestionSchema.safeParse({questions:[]}).success,false);
  assert.equal(askQuestionSchema.safeParse({questions:[...input.questions,...input.questions]}).success,false);
  assert.equal(askQuestionSchema.safeParse({questions:[{...input.questions[0],options:[{label:'Only choice'}]}]}).success,false);
  assert.equal(askQuestionSchema.safeParse({questions:[{...input.questions[0],options:[{label:'Same'},{label:'Same'}]}]}).success,false);
  assert.equal(askQuestionSchema.safeParse({questions:[{...input.questions[0],options:[]}]}).success,true);
});
