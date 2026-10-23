import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { createResourceSchema, snapshotSchema, chatSchema } from '../shared/schema';
import { projectMessageForSync } from '../shared/chat-sync';
import { createService } from './index';
import { createChatBranch } from './chat-branches';
import { applyStudyRecord } from './cloud-projection';

test('guided retry survives restart, preserves format, blocks actions and reuses an already saved resource',async () => {
  const directory = await mkdtemp(join(tmpdir(),'centre-guided-retry-'));
  const originalBinary = process.env.CENTRE_CODEX_BIN;
  const binary = join(directory,'codex-fixture');
  await writeFile(binary,`#!/usr/bin/env node
const fs=require('node:fs'),rl=require('node:readline');
const directory=${JSON.stringify(directory)};
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
let thread=0,waiting=null;
rl.createInterface({input:process.stdin}).on('line',line=>{
  const m=JSON.parse(line);
  if(waiting && m.id===9000 && !m.method){
    fs.writeFileSync(directory+'/tool-result.json',JSON.stringify(m.result));
    const output={title:'Fractions',content:'',questions:Array.from({length:17},(_,i)=>({prompt:'Explain fraction '+i,answer:'One half',explanation:'Divide into equal parts.',responseType:'long_response',choices:[],marks:2,concept:'Fractions'}))};
    send({method:'item/completed',params:{threadId:waiting,item:{id:'answer',type:'agentMessage',phase:'final_answer',text:JSON.stringify(output)}}});
    send({method:'turn/completed',params:{threadId:waiting,turn:{status:'completed'}}});waiting=null;return;
  }
  if(!m.id)return;
  if(m.method==='model/list' && fs.existsSync(directory+'/offline')){send({id:m.id,error:{message:'Fixture Codex is offline'}});return;}
  let result={};
  if(m.method==='account/read')result={account:{id:'fixture'}};
  if(m.method==='model/list')result={data:[{model:'gpt-6.1-sol',displayName:'Sol',supportedReasoningEfforts:[{reasoningEffort:'medium'}],defaultReasoningEffort:'medium'}],nextCursor:null};
  if(m.method==='thread/start')result={thread:{id:'fixture-'+(++thread)}};
  if(m.method==='turn/start'){
    fs.appendFileSync(directory+'/turns.jsonl',JSON.stringify(m.params)+'\\n');
    if(!fs.existsSync(directory+'/failed')){fs.writeFileSync(directory+'/failed','yes');send({id:m.id,error:{message:'Simulated transport failure'}});return;}
  }
  send({id:m.id,result});
  if(m.method==='turn/start'){
    waiting=m.params.threadId;
    send({id:9000,method:'item/tool/call',params:{threadId:waiting,tool:'centre_create_work',arguments:{title:'Must never create this',confirmedByUser:true}}});
  }
});
`,{mode:0o700});
  process.env.CENTRE_CODEX_BIN = binary;
  let service:Awaited<ReturnType<typeof createService>> | undefined;
  try {
    service = await createService({dataDir:directory});
    const call = async (path:string,body?:unknown) => {
      assert.ok(service);
      const response = await fetch(`http://127.0.0.1:${service.port}/api${path}`,{method:body === undefined ? 'GET' : 'POST',headers:{Authorization:`Bearer ${service.token}`,'Content-Type':'application/json'},...(body === undefined ? {} : {body:JSON.stringify(body)})});
      return {status:response.status,body:await response.json()};
    };
    const state = async () => snapshotSchema.parse((await call('/state')).body);
    const settle = async () => {
      for (let i=0;i<200;i++) { const value=await state(); if (!value.activeResponses.length) return value; await setTimeout(20); }
      throw new Error('Guided retry did not finish.');
    };
    const chat = chatSchema.parse((await call('/chats',{})).body);
    const messageId = randomUUID();
    const request = createResourceSchema.parse({kind:'quiz',subjectId:null,topicId:null,questionCount:17,questionTypes:['long_response'],difficulty:'challenging',instructions:'Fractions'});
    assert.equal((await call(`/chats/${chat.id}/messages`,{messageId,content:'Please make practice.',context:{page:'personal-learning'},resourceRequest:request})).status,500);
    await service.close();
    service = await createService({dataDir:directory});
    const saved = (await state()).chats.find(value => value.id === chat.id)?.messages[0]; assert.ok(saved);
    assert.deepEqual(saved.guidedGeneration?.request,request);
    assert.equal('guidedGeneration' in projectMessageForSync(saved,chat.id),false);
    const projected = await state();
    applyStudyRecord(projected,{kind:'message',id:saved.id,schemaVersion:1,version:2,cursor:'2',updatedAt:new Date().toISOString(),deleted:false,data:projectMessageForSync(saved,chat.id)});
    assert.deepEqual(projected.chats.find(value => value.id === chat.id)?.messages[0]?.guidedGeneration,saved.guidedGeneration);
    assert.equal((await call(`/chats/${chat.id}/retry`,{messageId})).status,200);
    const completed = await settle();
    assert.equal(completed.resources.length,1);
    assert.equal(completed.resources[0]?.id,saved.guidedGeneration?.resourceId);
    assert.equal(completed.resources[0]?.questions.length,17);
    assert.deepEqual(completed.resources[0]?.questionTypes,['long_response']);
    const completedChat = completed.chats.find(value => value.id === chat.id); assert.ok(completedChat);
    assert.equal(completedChat.messages.length,2);
    assert.equal(JSON.parse(await readFile(join(directory,'tool-result.json'),'utf8')).success,false);
    const turns = (await readFile(join(directory,'turns.jsonl'),'utf8')).trim().split('\n');
    assert.equal(turns.length,2);
    assert.match(turns[1] ?? '',/Return exactly 17 questions/);
    assert.match(turns[1] ?? '',/long_response/);
    const reply = completedChat.messages[1]; assert.ok(reply);
    const branch = createChatBranch(completedChat,{operation:'regenerate',messageId:reply.id});
    assert.ok(branch.chat.messages.every(message => message.guidedGeneration === undefined));

    // Reproduce a crash after the resource commit but before the reply/link commit.
    await service.close();
    const interrupted = snapshotSchema.parse(JSON.parse(await readFile(join(directory,'state.json'),'utf8')));
    const interruptedChat = interrupted.chats.find(value => value.id === chat.id); assert.ok(interruptedChat);
    interruptedChat.messages = [saved];
    await writeFile(join(directory,'state.json'),JSON.stringify(interrupted));
    await writeFile(join(directory,'offline'),'yes');
    service = await createService({dataDir:directory});
    assert.equal((await call(`/chats/${chat.id}/retry`,{messageId})).status,200);
    const recovered = await settle();
    assert.equal(recovered.resources.length,1);
    assert.equal(recovered.chats.find(value => value.id === chat.id)?.messages.length,2);
    assert.equal(recovered.chats.find(value => value.id === chat.id)?.responseError,null);
    assert.equal((await readFile(join(directory,'turns.jsonl'),'utf8')).trim().split('\n').length,2);
    assert.deepEqual(recovered.chats.find(value => value.id === chat.id)?.messages[0]?.resourceIds,[saved.guidedGeneration?.resourceId]);
  } finally {
    await service?.close();
    if (originalBinary === undefined) delete process.env.CENTRE_CODEX_BIN; else process.env.CENTRE_CODEX_BIN=originalBinary;
    await rm(directory,{recursive:true,force:true});
  }
});
