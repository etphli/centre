import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp,readFile,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { snapshotSchema } from '../shared/schema';
import { createService } from './index';

test('a five-question popup resumes the same Codex turn, persists every answer and cancels cleanly',async () => {
  const directory = await mkdtemp(join(tmpdir(),'centre-question-flow-'));
  const original = process.env.CENTRE_CODEX_BIN;
  const binary = join(directory,'codex-fixture');
  await writeFile(binary,`#!/usr/bin/env node
const readline = require('node:readline');
let thread = 0, sequence = 100;
const waiting = new Map();
const send = value => process.stdout.write(JSON.stringify(value)+'\n');
readline.createInterface({input:process.stdin}).on('line',line => {
  const message = JSON.parse(line);
  if (!message.method && waiting.has(message.id)) {
    const threadId = waiting.get(message.id); waiting.delete(message.id);
    if (!message.result.success) return;
    send({method:'item/completed',params:{threadId,item:{id:'reply',type:'agentMessage',phase:'final_answer',text:JSON.stringify({response:{kind:'message',content:message.result.contentItems[0].text}})}}});
    send({method:'turn/completed',params:{threadId,turn:{status:'completed'}}}); return;
  }
  if (!message.id) return;
  let result = {};
  if (message.method === 'account/read') result = {account:{id:'fixture'}};
  if (message.method === 'model/list') result = {data:[{model:'gpt-6.1-sol',displayName:'Sol',hidden:false,supportedReasoningEfforts:[{reasoningEffort:'medium'}],defaultReasoningEffort:'medium'}],nextCursor:null};
  if (message.method === 'thread/start') result = {thread:{id:'thread-'+(++thread)}};
  send({id:message.id,result});
  if (message.method === 'turn/start') {
    const threadId = message.params.threadId, id = ++sequence;
    waiting.set(id,threadId);
    send({method:'turn/started',params:{threadId,turn:{id:'turn-'+id}}});
    send({method:'item/reasoning/summaryTextDelta',params:{threadId,itemId:'summary',summaryIndex:0,delta:'Checking the quiz format.'}});
    send({id,method:'item/tool/call',params:{threadId,tool:'centre_ask_question',arguments:{questions:[{id:'format',header:'Quiz format',question:'Use five mixed questions?',options:[{label:'Five mixed questions'},{label:'Five short responses'}]},...Array.from({length:4},(_,index) => ({id:'extra'+index,header:'Follow-up',question:'Explain idea '+index,options:[]}))]}}});
  }
  if (message.method === 'turn/interrupt') send({method:'turn/completed',params:{threadId:message.params.threadId,turn:{status:'interrupted'}}});
});
`.replaceAll("+'\n'","+'\\n'"),{mode:0o700});
  process.env.CENTRE_CODEX_BIN = binary;
  const service = await createService({dataDir:directory});
  const request = async (path:string,method = 'GET',body?:unknown) => {
    const response = await fetch(`http://127.0.0.1:${service.port}/api${path}`,{method,headers:{Authorization:`Bearer ${service.token}`,'Content-Type':'application/json'},...(body === undefined ? {} : {body:JSON.stringify(body)})});
    return {status:response.status,body:await response.json()};
  };
  const state = async () => snapshotSchema.parse((await request('/state')).body);
  const waitForQuestion = async () => {
    for (let attempt = 0; attempt < 500; attempt++) { const pending = (await state()).pendingQuestions[0]; if (pending) return pending; await setTimeout(20); }
    throw new Error('Question did not arrive.');
  };
  try {
    const chat = (await request('/chats','POST',{})).body;
    const response = request(`/chats/${chat.id}/messages`,'POST',{content:'Make a five-minute electricity quiz.',context:{page:'chat'}});
    void response.catch(() => undefined);
    const question = await waitForQuestion();
    assert.equal(question.chatId,chat.id); assert.equal(question.questions.length,5);
    const answers = {format:'Five mixed questions',...Object.fromEntries(Array.from({length:4},(_,index) => ['extra'+index,'Explanation '+index]))};
    const running = (await request('/state')).body;
    assert.equal(running.activeResponses?.[0]?.chatId,chat.id,'A fresh renderer must be able to recover the running response');
    const overlap = await request(`/chats/${chat.id}/messages`,'POST',{content:'A follow-up.',context:{page:'chat'}});
    assert.equal(overlap.status,409);
    assert.equal(overlap.body.error,'This conversation already has a response in progress.');
    assert.equal((await state()).chats[0]?.messages.length,1);
    assert.ok((await state()).chats[0]?.activity.some(activity => activity.kind === 'skill' && activity.text === 'Ask questions'));
    assert.equal((await request(`/questions/${question.id}/answer`,'POST',{answers:{wrong:'Yes'}})).status,400);
    assert.equal((await request(`/questions/${question.id}/answer`,'POST',{answers})).status,200);
    const completed = await response;
    assert.deepEqual((await request('/state')).body.activeResponses,[]);
    assert.equal(completed.status,200); assert.match(completed.body.messages.at(-1).content,/Five mixed questions/); assert.match(completed.body.messages.at(-1).content,/Explanation 3/);
    assert.equal((await state()).pendingQuestions.length,0);
    assert.equal((await request(`/questions/${question.id}/answer`,'POST',{answers:{format:'Again'}})).status,409);
    const saved = JSON.parse(await readFile(join(directory,'state.json'),'utf8'));
    assert.deepEqual(saved.pendingQuestions,[]); assert.match(saved.chats[0].messages[1].content,/Use five mixed questions/); assert.match(saved.chats[0].messages[1].content,/Explanation 3/);
    assert.ok(saved.chats[0].messages.at(-1).responseDurationMs >= 0);

    const cancelled = request(`/chats/${chat.id}/messages`,'POST',{content:'Another quiz.',context:{page:'chat'}});
    const next = await waitForQuestion();
    assert.equal((await request(`/chats/${chat.id}/cancel`,'POST',{})).status,200);
    assert.equal((await cancelled).status,409);
    assert.equal((await state()).pendingQuestions.length,0);
    assert.deepEqual((await state()).activeResponses,[]);
    assert.equal((await request(`/questions/${next.id}/answer`,'POST',{answers:{format:'Too late'}})).status,409);
    const afterCancel = request(`/chats/${chat.id}/messages`,'POST',{content:'Try once more.',context:{page:'chat'}});
    void afterCancel.catch(() => undefined);
    const retryQuestion = await waitForQuestion();
    assert.equal((await request(`/questions/${retryQuestion.id}/answer`,'POST',{answers:{...answers,format:'Five short responses'}})).status,200);
    assert.equal((await afterCancel).status,200);
    assert.deepEqual((await state()).activeResponses,[]);
  } finally {
    await service.close();
    if (original === undefined) delete process.env.CENTRE_CODEX_BIN; else process.env.CENTRE_CODEX_BIN = original;
    await rm(directory,{recursive:true,force:true});
  }
});
