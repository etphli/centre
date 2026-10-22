import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir,mkdtemp,readFile,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createService } from './index';
import { remember,forgetMemory } from './assistant-memory';
import { Store,emptySnapshot } from './store';

// The CLI boundary is a fixture; HTTP routing, tool execution and disk persistence are real.
test('assistant memory survives restarts, reaches a new chat, and can be updated and forgotten',async () => {
  const directory = await mkdtemp(join(tmpdir(),'centre-assistant-memory-'));
  const original = process.env.CENTRE_CODEX_BIN;
  const binary = join(directory,'codex-fixture');
  await writeFile(binary,`#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const crypto = require('node:crypto');
const threads = new Map(), waiting = new Map(), structured = new Set();
let sequence = 100;
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
const finish = (threadId,content) => {
  send({method:'item/completed',params:{threadId,item:{id:'reply',type:'agentMessage',phase:'final_answer',text:structured.has(threadId) ? JSON.stringify({response:{kind:'message',content}}) : content}}});
  send({method:'turn/completed',params:{threadId,turn:{status:'completed'}}});
};
readline.createInterface({input:process.stdin}).on('line',line => {
  const message = JSON.parse(line);
  if (!message.method && waiting.has(message.id)) {
    const {threadId,tool} = waiting.get(message.id); waiting.delete(message.id);
    finish(threadId,message.result.success ? tool+' succeeded' : 'Tool failed'); return;
  }
  if (!message.id) return;
  let result = {};
  if (message.method === 'account/read') result = {account:{id:'fixture'}};
  if (message.method === 'model/list') result = {data:[{model:'gpt-6.1-sol',displayName:'Sol',hidden:false,supportedReasoningEfforts:[{reasoningEffort:'medium'}],defaultReasoningEffort:'medium'}],nextCursor:null};
  if (message.method === 'thread/start' || message.method === 'thread/resume') {
    const id = message.params.threadId || crypto.randomUUID(); threads.set(id,message.params.dynamicTools); result = {thread:{id}};
  }
  send({id:message.id,result});
  if (message.method !== 'turn/start') return;
  const threadId = message.params.threadId, prompt = message.params.input[0].text;
  if (message.params.outputSchema?.properties?.response) structured.add(threadId);
  fs.appendFileSync('prompts.jsonl',JSON.stringify({threadId,prompt})+'\\n');
  if (prompt.includes('Create a complete notes for')) { finish(threadId,JSON.stringify({title:'Personalized notes',content:'Worked examples.',questions:[]})); return; }
  const content = prompt.split('Student message:\\n').at(-1);
  let tool, args;
  if (content.startsWith('Remember')) { tool = 'centre_remember'; args = {key:'learning.examples',content:'I prefer worked examples about astronomy.'}; }
  if (content.startsWith('Update')) { tool = 'centre_remember'; args = {key:'LEARNING.EXAMPLES',content:'I prefer worked examples about music.'}; }
  if (content.startsWith('Invalid')) { tool = 'centre_remember'; args = {key:'',content:'invalid'}; }
  if (content.startsWith('Forget')) {
    tool = 'centre_forget_memory'; args = {id:JSON.parse(fs.readFileSync('state.json','utf8')).assistantMemories[0].id};
  }
  if (!tool) { finish(threadId,'Context received'); return; }
  if (!threads.get(threadId)?.some(value => value.name === tool)) { finish(threadId,'Memory tool unavailable'); return; }
  const id = ++sequence; waiting.set(id,{threadId,tool});
  send({id,method:'item/tool/call',params:{threadId,tool,arguments:args}});
});
`,{mode:0o700});
  process.env.CENTRE_CODEX_BIN = binary;
  let service = await createService({dataDir:directory});
  const request = async (path:string,method = 'GET',body?:unknown) => {
    const response = await fetch(`http://127.0.0.1:${service.port}/api${path}`,{method,headers:{Authorization:`Bearer ${service.token}`,'Content-Type':'application/json'},...(body === undefined ? {} : {body:JSON.stringify(body)})});
    const result = await response.json(); assert.equal(response.status,200,JSON.stringify(result)); return result;
  };
  const newChat = async () => (await request('/chats','POST',{})).id;
  const sendMessage = (id:string,content:string) => request(`/chats/${id}/messages`,'POST',{content,context:{page:'chat'}});
  const disk = async () => JSON.parse(await readFile(join(directory,'state.json'),'utf8'));
  const lastPrompt = async () => JSON.parse((await readFile(join(directory,'prompts.jsonl'),'utf8')).trim().split('\n').at(-1) ?? '{}').prompt;
  const restart = async () => { await service.close(); service = await createService({dataDir:directory}); };
  try {
    const firstChat = await newChat();
    const saved = await sendMessage(firstChat,'Remember my preference for astronomy examples.');
    assert.equal(saved.messages.at(-1).content,'centre_remember succeeded');
    const memory = (await disk()).assistantMemories[0];
    assert.match(memory.content,/astronomy/);
    await restart();
    const secondChat = await newChat(); assert.notEqual(firstChat,secondChat);
    await sendMessage(secondChat,'What examples do I like?');
    assert.match(await lastPrompt(),/I prefer worked examples about astronomy/);
    assert.equal((await request('/state')).assistantMemories[0].id,memory.id);
    await request('/resources/generate','POST',{kind:'notes',subjectId:null,topicId:null,instructions:'Explain addition.'});
    assert.match(await lastPrompt(),/I prefer worked examples about astronomy/);
    assert.equal((await sendMessage(secondChat,'Update my preference to music examples.')).messages.at(-1).content,'centre_remember succeeded');
    assert.equal((await disk()).assistantMemories.length,1);
    assert.equal((await disk()).assistantMemories[0].id,memory.id);
    assert.match((await disk()).assistantMemories[0].content,/music/);
    const edited = await request(`/assistant-memories/${memory.id}`,'PATCH',{content:'I prefer worked examples about painting.'});
    assert.equal(edited.id,memory.id);
    assert.equal(edited.createdAt,memory.createdAt);
    assert.equal(edited.key,memory.key);
    assert.equal((await disk()).assistantMemories.length,1);
    assert.equal((await sendMessage(secondChat,'Invalid memory input.')).messages.at(-1).content,'Tool failed');
    assert.equal((await disk()).assistantMemories.length,1);
    await restart();
    await sendMessage(secondChat,'Recall after another restart.');
    assert.match(await lastPrompt(),/I prefer worked examples about painting/);
    assert.doesNotMatch(await lastPrompt(),/I prefer worked examples about (astronomy|music)/);
    assert.equal((await sendMessage(secondChat,'Forget my examples preference.')).messages.at(-1).content,'centre_forget_memory succeeded');
    await restart();
    await sendMessage(await newChat(),'What do you remember?');
    assert.deepEqual((await disk()).assistantMemories,[]);
    assert.doesNotMatch(await lastPrompt(),/I prefer worked examples about (astronomy|music|painting)/);
  } finally {
    await service.close();
    if (original === undefined) delete process.env.CENTRE_CODEX_BIN; else process.env.CENTRE_CODEX_BIN = original;
    await rm(directory,{recursive:true,force:true});
  }
});

test('legacy snapshots open without losing review memories or preferences',async () => {
  const directory = await mkdtemp(join(tmpdir(),'centre-memory-migration-'));
  try {
    const { assistantMemories:_old,...legacy } = emptySnapshot();
    legacy.settings.nickname = 'Learner';
    legacy.memories.push({id:'review',subjectId:null,topicId:null,resourceId:'resource',question:'Fractions',note:'Practise',createdAt:new Date().toISOString(),nextReviewAt:new Date().toISOString(),resolvedAt:null,learningNeedId:null});
    await writeFile(join(directory,'state.json'),JSON.stringify(legacy));
    const store = await Store.open(directory);
    assert.deepEqual(store.state.assistantMemories,[]);
    await remember(store,{key:'learning.preference',content:'Use pictures.'});
    const reopened = await Store.open(directory);
    assert.equal(reopened.state.assistantMemories.length,1);
    assert.equal(reopened.state.settings.nickname,'Learner');
    assert.deepEqual(reopened.state.memories,legacy.memories);
  } finally { await rm(directory,{recursive:true,force:true}); }
});

test('memory bounds allow updates at capacity and failed disk writes do not report changes',async () => {
  const directory = await mkdtemp(join(tmpdir(),'centre-memory-bounds-'));
  try {
    const store = await Store.open(directory);
    await assert.rejects(remember(store,{key:'blank',content:'   '}));
    await assert.rejects(remember(store,{key:'long',content:'x'.repeat(1001)}));
    for (let index = 0; index < 50; index++) await remember(store,{key:`goal.${index}`,content:`Study goal ${index}`});
    await assert.rejects(remember(store,{key:'overflow',content:'More'}),/memory is full/);
    const updated = await remember(store,{key:'GOAL.0',content:'Updated goal'});
    assert.equal(store.state.assistantMemories.length,50);
    assert.equal(updated.key,'goal.0');
    await mkdir(join(directory,'state.json.tmp'));
    await assert.rejects(remember(store,{key:'goal.0',content:'Failed update'}));
    assert.equal(store.state.assistantMemories[0].content,'Updated goal');
    await assert.rejects(forgetMemory(store,{id:updated.id}));
    assert.equal(store.state.assistantMemories.length,50);
    assert.equal((await Store.open(directory)).state.assistantMemories[0].content,'Updated goal');
    await rm(join(directory,'state.json.tmp'),{recursive:true});
    await forgetMemory(store,{id:updated.id});
    await assert.rejects(forgetMemory(store,{id:updated.id}),/not found/);
    assert.equal((await Store.open(directory)).state.assistantMemories.length,49);
  } finally { await rm(directory,{recursive:true,force:true}); }
});
