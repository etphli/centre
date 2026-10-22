import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { z } from 'zod';
import { chatSchema, resourceSchema, snapshotSchema } from '../shared/schema';
import { createService } from './index';
import { createChatBranch } from './chat-branches';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(),'centre-branches-'));
  const original = process.env.CENTRE_CODEX_BIN;
  const binary = join(directory,'codex-fixture');
  await writeFile(binary,`#!/usr/bin/env node
const fs = require('node:fs'), readline = require('node:readline');
const directory = ${JSON.stringify(directory)};
let thread = 0, turn = 0, failed = fs.existsSync(directory+'/failed-once');
const waiting = new Map();
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
const complete = (threadId,text) => {
  send({method:'item/completed',params:{threadId,item:{id:'reply',type:'agentMessage',phase:'final_answer',text:JSON.stringify({response:{kind:'message',content:text}})}}});
  send({method:'turn/completed',params:{threadId,turn:{status:'completed'}}});
};
readline.createInterface({input:process.stdin}).on('line',line => {
  const message = JSON.parse(line);
  fs.appendFileSync(directory+'/calls.jsonl',line+'\\n');
  if (!message.method && waiting.has(message.id)) {
    const threadId = waiting.get(message.id); waiting.delete(message.id);
    complete(threadId,'Tool success: '+message.result.success); return;
  }
  if (!message.id) return;
  if (message.method === 'thread/fork' && fs.existsSync(directory+'/fail-fork')) {
    send({id:message.id,error:{message:'Fork unavailable'}}); return;
  }
  let result = {};
  if (message.method === 'account/read') result = {account:{id:'fixture'}};
  if (message.method === 'model/list') result = {data:['gpt-6.1-sol','gpt-6-luna'].map(model => ({model,displayName:model,hidden:false,supportedReasoningEfforts:[{reasoningEffort:'medium'},{reasoningEffort:'high'}],defaultReasoningEffort:'medium'})),nextCursor:null};
  if (['thread/start','thread/fork'].includes(message.method)) result = {thread:{id:'thread-'+process.pid+'-'+(++thread)}};
  if (message.method === 'thread/resume') result = {thread:{id:message.params.threadId}};
  send({id:message.id,result});
  if (message.method === 'turn/start') {
    const threadId = message.params.threadId, prompt = message.params.input[0].text;
    send({method:'turn/started',params:{threadId,turn:{id:'turn-'+(++turn)}}});
    if (prompt.endsWith('fail then retry') && !failed) {
      failed = true; fs.writeFileSync(directory+'/failed-once','yes'); send({method:'turn/completed',params:{threadId,turn:{status:'failed',error:{message:'Fixture failed'}}}}); return;
    }
    if (prompt.endsWith('fail then retry')) {
      const id = 1000+turn; waiting.set(id,threadId);
      send({id,method:'item/tool/call',params:{threadId,tool:'centre_update_work',arguments:{id:'remote-work',title:'UNAUTHORIZED',confirmedByUser:true}}}); return;
    }
    if (prompt.endsWith('ask fixture question')) {
      const id = 1000+turn; waiting.set(id,threadId);
      send({id,method:'item/tool/call',params:{threadId,tool:'centre_ask_question',arguments:{questions:[{id:'choice',header:'Choice',question:'Choose?',options:[{label:'Yes'},{label:'No'}]}]}}}); return;
    }
    setTimeout(() => complete(threadId,'Reply '+turn),prompt.endsWith('hold fixture reply') ? 400 : 100);
  }
  if (message.method === 'turn/interrupt') send({method:'turn/completed',params:{threadId:message.params.threadId,turn:{status:'interrupted'}}});
});
`,{mode:0o700});
  process.env.CENTRE_CODEX_BIN = binary;
  let service = await createService({dataDir:directory});
  const request = async (path:string, method = 'GET', body?:unknown) => {
    const response = await fetch(`http://127.0.0.1:${service.port}/api${path}`,{method,headers:{Authorization:`Bearer ${service.token}`,'Content-Type':'application/json'},...(body === undefined ? {} : {body:JSON.stringify(body)})});
    return {status:response.status,body:await response.json()};
  };
  const state = async () => snapshotSchema.parse((await request('/state')).body);
  const chat = async (id:string) => { const value = (await state()).chats.find(chat => chat.id === id); assert.ok(value); return value; };
  const wait = async (predicate: (snapshot:Awaited<ReturnType<typeof state>>) => boolean) => {
    for (let attempt = 0; attempt < 150; attempt++) { if (predicate(await state())) return; await setTimeout(20); }
    throw new Error('Fixture state did not settle');
  };
  const settled = async (id:string) => { await wait(snapshot => !snapshot.activeResponses.some(response => response.chatId === id)); return chat(id); };
  const calls = async () => z.array(z.object({method:z.string().optional(),params:z.record(z.string(),z.unknown()).optional(),result:z.unknown().optional()})).parse((await readFile(join(directory,'calls.jsonl'),'utf8')).trim().split('\n').map(line => JSON.parse(line)));
  const create = async () => chatSchema.parse((await request('/chats','POST',{})).body);
  const send = async (id:string,content:string) => request(`/chats/${id}/messages`,'POST',{content,context:{page:'chat'}});
  return {directory,request,state,chat,wait,settled,calls,create,send,
    restart:async (edit?: (snapshot:z.infer<typeof snapshotSchema>) => void) => {
      await service.close();
      if (edit) {
        const snapshot = snapshotSchema.parse(JSON.parse(await readFile(join(directory,'state.json'),'utf8')));
        edit(snapshot);
        await writeFile(join(directory,'state.json'),JSON.stringify(snapshot));
      }
      service = await createService({dataDir:directory});
    },
    close:async () => { await service.close(); if (original === undefined) delete process.env.CENTRE_CODEX_BIN; else process.env.CENTRE_CODEX_BIN = original; await rm(directory,{recursive:true,force:true}); },
  };
}

const promptText = (value:unknown) => z.array(z.object({text:z.string()})).parse(value)[0]?.text ?? '';

test('early edit forks before its turn, preserves the parent and persists independent lineage',async () => {
  const f = await fixture();
  try {
    const parent = await f.create();
    assert.equal((await f.request(`/chats/${parent.id}/model`,'PATCH',{model:'gpt-6-luna',effort:'high'})).status,200);
    assert.equal((await f.send(parent.id,'first prompt')).status,200);
    assert.equal((await f.send(parent.id,'later prompt')).status,200);
    const original = await f.chat(parent.id);
    const first = original.messages[0], reply = original.messages[1]; assert.ok(first); assert.ok(reply);
    assert.deepEqual(reply.codexTurns,[{turnId:'turn-1',promptMessageId:first.id}]);
    const response = await f.request(`/chats/${parent.id}/branch`,'POST',{operation:'edit',messageId:first.id,content:'edited prompt'});
    assert.equal(response.status,200);
    const child = chatSchema.parse(response.body);
    assert.equal(child.messages.length,1); assert.equal(child.messages[0]?.content,'edited prompt');
    assert.equal(child.title,'Edited: edited prompt');
    assert.ok((await f.state()).activeResponses.some(response => response.chatId === child.id));
    const completed = await f.settled(child.id);
    assert.equal(completed.messages.length,2); assert.deepEqual(await f.chat(parent.id),original);
    assert.deepEqual(completed.modelSelection,{model:'gpt-6-luna',effort:'high'});
    assert.deepEqual(completed.lineage,{schemaVersion:1,kind:'branch',operation:'edit',parentChatId:parent.id,sourceMessageId:first.id,checkpointMessageId:null,promptMessageId:completed.messages[0]?.id});
    const fork = (await f.calls()).find(call => call.method === 'thread/fork');
    assert.equal(fork?.params?.beforeTurnId,'turn-1'); assert.equal(fork?.params?.lastTurnId,undefined);
    assert.equal(fork?.params?.model,'gpt-6-luna');
    assert.notEqual(completed.codexThreadId,original.codexThreadId);
    assert.notEqual(completed.messages[0]?.id,first.id);
    await f.restart(); assert.deepEqual(await f.chat(child.id),completed); assert.deepEqual(await f.chat(parent.id),original);
  } finally { await f.close(); }
});

test('regenerate and continue select exact checkpoints; rejected targets create no chats',async () => {
  const f = await fixture();
  try {
    const parent = await f.create(); await f.send(parent.id,'first prompt'); await f.send(parent.id,'later prompt');
    const original = await f.chat(parent.id), user = original.messages[0], assistant = original.messages[1]; assert.ok(user); assert.ok(assistant);
    const foreign = await f.create(); await f.send(foreign.id,'foreign prompt');
    const foreignMessage = (await f.chat(foreign.id)).messages[0]; assert.ok(foreignMessage);
    for (const input of [{operation:'edit',messageId:assistant.id,content:'wrong role'},{operation:'regenerate',messageId:user.id},{operation:'edit',messageId:foreignMessage.id,content:'foreign'},{operation:'continue',messageId:'missing'}]) {
      const response = await f.request(`/chats/${parent.id}/branch`,'POST',input); assert.ok([400,404].includes(response.status));
    }
    assert.equal((await f.state()).chats.length,2);
    const regenerated = chatSchema.parse((await f.request(`/chats/${parent.id}/branch`,'POST',{operation:'regenerate',messageId:assistant.id})).body);
    assert.equal((await f.settled(regenerated.id)).messages.length,2);
    assert.equal(regenerated.title,`Alternate: ${assistant.content}`);
    const continued = chatSchema.parse((await f.request(`/chats/${parent.id}/branch`,'POST',{operation:'continue',messageId:user.id})).body);
    assert.equal(continued.title,`Branch: ${user.content}`);
    assert.deepEqual(continued.messages.map(message => message.content),original.messages.slice(0,2).map(message => message.content));
    assert.equal((await f.state()).activeResponses.some(response => response.chatId === continued.id),false);
    const forks = (await f.calls()).filter(call => call.method === 'thread/fork');
    assert.equal(forks[0]?.params?.beforeTurnId,'turn-1'); assert.equal(forks[1]?.params?.lastTurnId,'turn-1');
    assert.equal(forks[1]?.params?.beforeTurnId,undefined); assert.deepEqual(await f.chat(parent.id),original);
  } finally { await f.close(); }
});

test('fork failure supplies only retained history and original request context',async () => {
  const f = await fixture();
  try {
    const parent = await f.create(); await f.send(parent.id,'retained first'); await f.send(parent.id,'replace second'); await f.send(parent.id,'excluded third');
    const original = await f.chat(parent.id), target = original.messages[2]; assert.ok(target);
    await writeFile(join(f.directory,'fail-fork'),'yes');
    const child = chatSchema.parse((await f.request(`/chats/${parent.id}/branch`,'POST',{operation:'edit',messageId:target.id,content:'new second'})).body);
    await f.settled(child.id);
    const last = (await f.calls()).filter(call => call.method === 'turn/start').at(-1);
    const prompt = promptText(last?.params?.input);
    assert.match(prompt,/Retained conversation/); assert.match(prompt,/retained first/); assert.match(prompt,/"requestContext":\{"page":"chat"/);
    assert.match(prompt,/Student message:\nnew second/); assert.doesNotMatch(prompt,/replace second|excluded third/);
    assert.deepEqual(await f.chat(parent.id),original);
  } finally { await f.close(); }
});

test('active and clarification responses prevent branching; retry reuses a saved prompt and rejects mutation tools',async () => {
  const f = await fixture();
  try {
    const parent = await f.create(); await f.send(parent.id,'first prompt');
    const target = (await f.chat(parent.id)).messages[0]; assert.ok(target);
    const held = f.send(parent.id,'hold fixture reply');
    await f.wait(snapshot => snapshot.activeResponses.some(response => response.chatId === parent.id));
    assert.equal((await f.request(`/chats/${parent.id}/branch`,'POST',{operation:'edit',messageId:target.id,content:'blocked'})).status,409);
    await held;
    const pending = f.send(parent.id,'ask fixture question');
    await f.wait(snapshot => snapshot.pendingQuestions.length > 0);
    assert.equal((await f.request(`/chats/${parent.id}/branch`,'POST',{operation:'continue',messageId:target.id})).status,409);
    await f.request(`/chats/${parent.id}/cancel`,'POST',{}); await pending;
    const failed = await f.create(); assert.equal((await f.send(failed.id,'fail then retry')).status,500);
    const saved = await f.chat(failed.id), prompt = saved.messages[0]; assert.ok(prompt); assert.equal(saved.messages.length,1);
    assert.equal((await f.request(`/chats/${failed.id}/retry`,'POST',{messageId:target.id})).status,409);
    assert.equal((await f.request(`/chats/${failed.id}/retry`,'POST',{messageId:prompt.id})).status,200);
    const completed = await f.settled(failed.id);
    assert.equal(completed.messages.length,2); assert.equal(completed.messages[0]?.id,prompt.id); assert.equal(completed.messages[1]?.content,'Tool success: false');
    const calls = await f.calls();
    const denial = calls.find(call => !call.method && JSON.stringify(call.result).includes('alternate reply cannot repeat'));
    assert.ok(denial,'The tool call must be rejected by the alternate-response guard before a handler runs');
    assert.equal((await f.request(`/chats/${failed.id}/retry`,'POST',{messageId:prompt.id})).status,409);
  } finally { await f.close(); }
});

test('editing the first seeded continuation retains ancestors when its provider fork succeeds',async () => {
  const f = await fixture();
  try {
    const parent = await f.create(); await f.send(parent.id,'ancestor prompt');
    const checkpoint = (await f.chat(parent.id)).messages[1]; assert.ok(checkpoint);
    await writeFile(join(f.directory,'fail-fork'),'yes');
    const fallback = chatSchema.parse((await f.request(`/chats/${parent.id}/branch`,'POST',{operation:'continue',messageId:checkpoint.id})).body);
    assert.equal(fallback.codexThreadId,null);
    assert.equal((await f.send(fallback.id,'first newly seeded prompt')).status,200);
    const seeded = await f.chat(fallback.id), selected = seeded.messages[2]; assert.ok(selected);
    const seededTurn = seeded.messages[3]?.codexTurns[0]; assert.ok(seededTurn);
    await rm(join(f.directory,'fail-fork'));
    const response = await f.request(`/chats/${fallback.id}/branch`,'POST',{operation:'edit',messageId:selected.id,content:'edited first seeded prompt'});
    assert.equal(response.status,200);
    const child = chatSchema.parse(response.body); await f.settled(child.id);
    const calls = await f.calls(), fork = calls.filter(call => call.method === 'thread/fork').at(-1);
    assert.equal(fork?.params?.beforeTurnId,seededTurn.turnId);
    const prompt = promptText(calls.filter(call => call.method === 'turn/start').at(-1)?.params?.input);
    assert.match(prompt,/Retained conversation/);
    assert.match(prompt,/ancestor prompt/);
    assert.match(prompt,/Student message:\nedited first seeded prompt/);
    assert.doesNotMatch(prompt,/first newly seeded prompt/);
    assert.deepEqual(await f.chat(fallback.id),seeded);
  } finally { await f.close(); }
});

test('failed and cancelled replies detach provider state before a normal subsequent message',async () => {
  const f = await fixture();
  try {
    const failed = await f.create();
    assert.equal((await f.send(failed.id,'fail then retry')).status,500);
    const failedRun = (await f.calls()).filter(call => call.method === 'turn/start').at(-1);
    assert.equal((await f.chat(failed.id)).codexThreadId,null);
    assert.equal((await f.send(failed.id,'normal message after failure')).status,200);
    const recoveredRun = (await f.calls()).filter(call => call.method === 'turn/start').at(-1);
    assert.notEqual(recoveredRun?.params?.threadId,failedRun?.params?.threadId);
    assert.match(promptText(recoveredRun?.params?.input),/fail then retry/);

    const cancelled = await f.create(); await f.send(cancelled.id,'retained before cancellation');
    const pending = f.send(cancelled.id,'hold fixture reply');
    let interruptedThread: unknown;
    for (let attempt = 0; attempt < 150; attempt++) {
      const run = (await f.calls()).filter(call => call.method === 'turn/start').at(-1);
      if (promptText(run?.params?.input).endsWith('hold fixture reply')) { interruptedThread = run?.params?.threadId; break; }
      await setTimeout(10);
    }
    assert.equal(typeof interruptedThread,'string');
    assert.equal((await f.request(`/chats/${cancelled.id}/cancel`,'POST',{})).status,200);
    assert.equal((await pending).status,409);
    assert.equal((await f.chat(cancelled.id)).codexThreadId,null);
    assert.equal((await f.send(cancelled.id,'normal message after cancellation')).status,200);
    const last = (await f.calls()).filter(call => call.method === 'turn/start').at(-1);
    assert.notEqual(last?.params?.threadId,interruptedThread);
    assert.match(promptText(last?.params?.input),/retained before cancellation/);
    assert.match(promptText(last?.params?.input),/hold fixture reply/);
  } finally { await f.close(); }
});

test('fallback seeds referenced resource and ancestor attachment contents using the inherited chat model',async () => {
  const f = await fixture();
  try {
    const parent = await f.create();
    assert.equal((await f.request(`/chats/${parent.id}/model`,'PATCH',{model:'gpt-6-luna',effort:'high'})).status,200);
    const attachment = z.object({id:z.string()}).parse((await f.request('/attachments','POST',{name:'ancestor.txt',mimeType:'text/plain',data:Buffer.from('ANCESTOR ATTACHMENT CONTENT').toString('base64')})).body);
    const now = new Date().toISOString();
    await f.restart(snapshot => {
      snapshot.resources.push(resourceSchema.parse({id:'historical-resource',title:'Historical document',kind:'notes',subjectId:null,topicId:null,createdAt:now,updatedAt:now,content:'HISTORICAL RESOURCE BODY'}));
    });
    assert.equal((await f.request(`/chats/${parent.id}/messages`,'POST',{content:'Explain the original source',context:{page:'resource',resourceId:'historical-resource'},attachmentIds:[attachment.id]})).status,200);
    await f.send(parent.id,'selected later prompt'); await f.send(parent.id,'excluded future prompt');
    const original = await f.chat(parent.id), selected = original.messages[2]; assert.ok(selected);
    await writeFile(join(f.directory,'fail-fork'),'yes');
    const child = chatSchema.parse((await f.request(`/chats/${parent.id}/branch`,'POST',{operation:'edit',messageId:selected.id,content:'alternate later prompt'})).body);
    await f.settled(child.id);
    const last = (await f.calls()).filter(call => call.method === 'turn/start').at(-1);
    const prompt = promptText(last?.params?.input);
    assert.match(prompt,/HISTORICAL RESOURCE BODY/);
    assert.match(prompt,/ANCESTOR ATTACHMENT CONTENT/);
    assert.doesNotMatch(prompt,/excluded future prompt|selected later prompt/);
    assert.equal(last?.params?.model,'gpt-6-luna'); assert.equal(last?.params?.effort,'high');
    assert.deepEqual((await f.chat(child.id)).messages[0]?.attachmentIds,[attachment.id]);
    assert.deepEqual(await f.chat(parent.id),original);
  } finally { await f.close(); }
});

test('restart detaches a dangling provider turn and retry keeps the original saved prompt ID',async () => {
  const f = await fixture();
  try {
    const parent = await f.create(); await f.send(parent.id,'ancestor before restart');
    assert.equal((await f.send(parent.id,'fail then retry')).status,500);
    const dangling = await f.chat(parent.id), prompt = dangling.messages.at(-1); assert.ok(prompt);
    await f.restart(snapshot => {
      const chat = snapshot.chats.find(chat => chat.id === parent.id); assert.ok(chat);
      chat.codexThreadId = 'stale-provider-thread'; chat.responseError = null;
    });
    const recovered = await f.chat(parent.id);
    assert.equal(recovered.codexThreadId,null);
    assert.match(recovered.responseError ?? '',/did not finish/);
    assert.equal(recovered.messages.at(-1)?.id,prompt.id);
    assert.equal((await f.request(`/chats/${parent.id}/retry`,'POST',{messageId:prompt.id})).status,200);
    const settled = await f.settled(parent.id);
    assert.equal(settled.messages.filter(message => message.id === prompt.id).length,1);
    assert.equal(settled.messages.length,dangling.messages.length + 1);
    assert.equal(settled.messages.at(-1)?.content,'Tool success: false');
    const last = (await f.calls()).filter(call => call.method === 'turn/start').at(-1);
    assert.notEqual(last?.params?.threadId,'stale-provider-thread');
    assert.match(promptText(last?.params?.input),/ancestor before restart/);
    assert.match(promptText(last?.params?.input),/Student message:\nfail then retry/);
    assert.equal((await f.calls()).some(call => call.method === 'thread/resume' && call.params?.threadId === 'stale-provider-thread'),false);
  } finally { await f.close(); }
});

test('client-assigned prompt IDs reject duplicate and foreign sends while retry retains the saved UUID',async () => {
  const f = await fixture();
  try {
    const parent = await f.create();
    const messageId = 'c5b578cf-b992-426a-8368-ece438521f85';
    const request = {messageId,content:'Client identified prompt',context:{page:'chat'}};
    assert.equal((await f.request(`/chats/${parent.id}/messages`,'POST',request)).status,200);
    const saved = await f.chat(parent.id);
    assert.equal(saved.messages[0]?.id,messageId);
    const foreign = await f.create();
    const originalForeign = await f.chat(foreign.id);
    const providerCalls = (await f.calls()).filter(call => call.method?.startsWith('thread/') || call.method === 'turn/start');
    assert.equal((await f.request(`/chats/${parent.id}/messages`,'POST',request)).status,409);
    assert.equal((await f.request(`/chats/${foreign.id}/messages`,'POST',{...request,content:'Different content reusing the same ID'})).status,409);
    assert.deepEqual(await f.chat(parent.id),saved);
    assert.deepEqual(await f.chat(foreign.id),originalForeign);
    assert.deepEqual((await f.calls()).filter(call => call.method?.startsWith('thread/') || call.method === 'turn/start'),providerCalls);

    const failed = await f.create();
    const failedId = '4fccf1d6-e645-424b-a324-fb2e41df3f69';
    const failedRequest = {messageId:failedId,content:'fail then retry',context:{page:'chat'}};
    assert.equal((await f.request(`/chats/${failed.id}/messages`,'POST',failedRequest)).status,500);
    const unanswered = await f.chat(failed.id);
    assert.equal(unanswered.messages.length,1);
    assert.equal(unanswered.messages[0]?.id,failedId);
    const callsBeforeDuplicate = (await f.calls()).filter(call => call.method?.startsWith('thread/') || call.method === 'turn/start');
    assert.equal((await f.request(`/chats/${failed.id}/messages`,'POST',failedRequest)).status,409);
    assert.deepEqual(await f.chat(failed.id),unanswered);
    assert.deepEqual((await f.calls()).filter(call => call.method?.startsWith('thread/') || call.method === 'turn/start'),callsBeforeDuplicate);
    assert.equal((await f.request(`/chats/${failed.id}/retry`,'POST',{messageId:failedId})).status,200);
    const completed = await f.settled(failed.id);
    assert.equal(completed.messages.length,2);
    assert.equal(completed.messages[0]?.id,failedId);
    assert.equal(completed.messages.filter(message => message.id === failedId).length,1);
    assert.equal(completed.messages[1]?.content,'Tool success: false');
  } finally { await f.close(); }
});

test('branch titles distinguish edits, normalize selected excerpts and bound resource-only fallbacks',() => {
  const now = '2026-10-22T00:00:00.000Z';
  const parent = chatSchema.parse({id:'title-parent',title:'Original source chat',createdAt:now,updatedAt:now,messages:[
    {id:'title-user',role:'user',content:'Original \n user prompt',createdAt:now},
    {id:'title-assistant',role:'assistant',content:'Original \n assistant response',createdAt:now},
  ]});
  const first = createChatBranch(parent,{operation:'edit',messageId:'title-user',content:'  First \n alternate\tidea  '}).chat;
  const second = createChatBranch(parent,{operation:'edit',messageId:'title-user',content:'Second alternate idea'}).chat;
  assert.equal(first.title,'Edited: First alternate idea');
  assert.equal(second.title,'Edited: Second alternate idea');
  assert.notEqual(first.title,second.title);
  assert.equal(createChatBranch(parent,{operation:'continue',messageId:'title-user'}).chat.title,'Branch: Original user prompt');
  assert.equal(createChatBranch(parent,{operation:'regenerate',messageId:'title-assistant'}).chat.title,'Alternate: Original assistant response');
  const long = createChatBranch(parent,{operation:'edit',messageId:'title-user',content:'x'.repeat(500)}).chat;
  assert.equal(long.title,`Edited: ${'x'.repeat(60)}`);
  const assistant = parent.messages[1]; assert.ok(assistant);
  assistant.content = ''; assistant.resourceIds = ['resource-only'];
  parent.title = '  Resource \n source '+ 'y'.repeat(250);
  const resourceOnly = createChatBranch(parent,{operation:'continue',messageId:'title-assistant'}).chat;
  assert.equal(resourceOnly.title,`Branch: ${parent.title.replace(/\s+/g,' ').trim().slice(0,60)}`);
  assert.ok(resourceOnly.title.length <= 200);
});
