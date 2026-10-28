import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { snapshotSchema } from '../shared/schema';
import { createService } from './index';

test('five questions open a popup even when the model finishes without calling the question tool',async () => {
  const directory = await mkdtemp(join(tmpdir(),'centre-question-routing-'));
  const original = process.env.CENTRE_CODEX_BIN;
  const binary = join(directory,'codex-fixture');
  await writeFile(binary,`#!/usr/bin/env node
const readline = require('node:readline');
let turns = 0, failAfterAnswer = false;
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
readline.createInterface({input:process.stdin}).on('line',line => {
  const message = JSON.parse(line); if(!message.id)return;
  let result = {};
  if(message.method === 'account/read')result = {account:{id:'fixture'}};
  if(message.method === 'model/list')result = {data:[{model:'gpt-6.1-sol',displayName:'Sol',supportedReasoningEfforts:[{reasoningEffort:'medium'}],defaultReasoningEffort:'medium'}],nextCursor:null};
  if(message.method === 'thread/start')result = {thread:{id:'thread-1'}};
  send({id:message.id,result});
  if(message.method === 'turn/start'){
    const threadId = message.params.threadId;turns++;
    const structured = Boolean(message.params.outputSchema?.properties?.response);
    const answered = message.params.input[0].text.includes('The student answered your popup.');
    const prompt = message.params.input[0].text;
    if (prompt.includes('Student message:\\nfail after popup')) failAfterAnswer = true;
    if (answered && failAfterAnswer) {
      failAfterAnswer = false;
      send({method:'turn/completed',params:{threadId,turn:{status:'failed',error:{message:'Fixture failed after answer'}}}}); return;
    }
    const recovered = prompt.includes('Retained conversation') && prompt.includes('question-answer') && prompt.includes('Saved choice');
    const response = recovered ? {kind:'message',content:'Recovered Saved choice.'} : answered ? {kind:'message',content:'You chose Yes.'} : {kind:'questions',questions:[{id:'blue',header:'Colour',question:'Do you like blue?',options:[{label:'Yes'},{label:'No'}]},...Array.from({length:4},(_,index) => ({id:'extra'+index,header:'Follow-up',question:'Explain idea '+index,options:[]}))]};
    const text = structured ? JSON.stringify({response}) : 'Do you like blue?';
    send({method:'item/completed',params:{threadId,item:{id:'answer-'+turns,type:'agentMessage',phase:'final_answer',text}}});
    send({method:'turn/completed',params:{threadId,turn:{status:'completed'}}});
  }
});
`,{mode:0o700});
  process.env.CENTRE_CODEX_BIN = binary;
  const service = await createService({dataDir:directory});
  const request = async (path:string,method = 'GET',body?:unknown) => {
    const response = await fetch(`http://127.0.0.1:${service.port}/api${path}`,{method,headers:{Authorization:`Bearer ${service.token}`,'Content-Type':'application/json'},...(body === undefined ? {} : {body:JSON.stringify(body)})});
    return {status:response.status,body:await response.json()};
  };
  let completion:ReturnType<typeof request>|undefined;
  try {
    const chat = (await request('/chats','POST',{})).body;
    let ended = false;
    completion = request(`/chats/${chat.id}/messages`,'POST',{content:'Ask me a question as a test, like do you like blue.',context:{page:'chat'}}).then(result => {ended = true;return result;});
    void completion.catch(() => undefined);
    let pending;
    for(let attempt = 0;attempt < 500;attempt++) {
      pending = snapshotSchema.parse((await request('/state')).body).pendingQuestions[0];
      if(pending || ended)break;
      await setTimeout(20);
    }
    assert.ok(pending,'The question must open a popup rather than finish as an inline chat message.');
    assert.equal(ended,false);
    assert.equal(pending.questions[0]?.question,'Do you like blue?'); assert.equal(pending.questions.length,5);
    assert.equal((await request(`/questions/${pending.id}/answer`,'POST',{answers:{blue:'Yes',...Object.fromEntries(Array.from({length:4},(_,index) => ['extra'+index,'Explanation '+index]))}})).status,200);
    const result = await completion;
    assert.equal(result.status,200);assert.equal(result.body.messages.at(-1).content,'You chose Yes.');
    assert.equal(result.body.messages.length,3);
    assert.equal(result.body.messages[1].requestContext.page,'question-answer');
    assert.equal(snapshotSchema.parse((await request('/state')).body).pendingQuestions.length,0);
    const failedChat = (await request('/chats','POST',{})).body;
    const failedReply = request(`/chats/${failedChat.id}/messages`,'POST',{content:'fail after popup',context:{page:'chat'}});
    void failedReply.catch(() => undefined);
    for(let attempt = 0;attempt < 500;attempt++) {
      pending = snapshotSchema.parse((await request('/state')).body).pendingQuestions.find(item => item.chatId === failedChat.id);
      if(pending)break;
      await setTimeout(20);
    }
    assert.ok(pending);
    await request(`/questions/${pending.id}/answer`,'POST',{answers:Object.fromEntries(pending.questions.map(item => [item.id,'Saved choice']))});
    assert.ok((await failedReply).status >= 400);
    const failedHistory = snapshotSchema.parse((await request('/state')).body).chats.find(item => item.id === failedChat.id)!;
    assert.equal((await request(`/chats/${failedChat.id}/retry`,'POST',{messageId:failedHistory.messages[0]!.id})).status,200,'Retry targets the original prompt, not its hidden clarification.');
    for(let attempt = 0;attempt < 500;attempt++) {
      const recovered = snapshotSchema.parse((await request('/state')).body).chats.find(item => item.id === failedChat.id)!;
      if(recovered.messages.at(-1)?.role === 'assistant') {
        assert.equal(recovered.messages.at(-1)?.content,'Recovered Saved choice.');
        break;
      }
      if(attempt === 499) assert.fail('Retry did not recover the saved popup answer.');
      await setTimeout(20);
    }
    completion = request(`/chats/${chat.id}/messages`,'POST',{content:'Ask another popup question.',context:{page:'chat'}});
    void completion.catch(() => undefined);
    for(let attempt = 0;attempt < 500;attempt++) {
      pending = snapshotSchema.parse((await request('/state')).body).pendingQuestions[0];
      if(pending)break;
      await setTimeout(20);
    }
    assert.ok(pending);
    assert.equal((await request(`/chats/${chat.id}/messages`,'POST',{content:'Conflicting message',context:{page:'chat'}})).status,409);
    assert.equal((await request(`/chats/${chat.id}/cancel`,'POST',{})).status,200);
    assert.equal((await completion).status,409);
    assert.equal(snapshotSchema.parse((await request('/state')).body).pendingQuestions.length,0);
    assert.equal((await request(`/questions/${pending.id}/answer`,'POST',{answers:{blue:'Too late'}})).status,409);
  } finally {
    await service.close();await completion?.catch(() => undefined);
    if(original === undefined)delete process.env.CENTRE_CODEX_BIN;else process.env.CENTRE_CODEX_BIN = original;
    await rm(directory,{recursive:true,force:true});
  }
});
