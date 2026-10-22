import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chatSchema, snapshotSchema, type CreateResource } from '../shared/schema';
import { createService } from './index';
import { Store } from './store';

test('resource creation saves every kind, repairs invalid output, and persists linked history', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'centre-generation-'));
  const original = process.env.CENTRE_CODEX_BIN;
  const binary = join(directory, 'codex-fixture');
  await writeFile(binary, `#!/usr/bin/env node
const readline = require('node:readline');
let thread = 0;
const turns = new Map();
const requested = new Map();
const forceInvalid = new Set();
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
readline.createInterface({input:process.stdin}).on('line',line => {
  const message = JSON.parse(line); if (!message.id) return;
  let result = {};
  if (message.method === 'account/read') result = {account:{id:'fixture'}};
  if (message.method === 'model/list') result = {data:[{model:'gpt-6.1-sol',displayName:'Sol',supportedReasoningEfforts:[{reasoningEffort:'medium'}],defaultReasoningEffort:'medium'}],nextCursor:null};
  if (message.method === 'thread/start') result = {thread:{id:'thread-'+(++thread)}};
  if (message.method === 'turn/start' && JSON.stringify(message.params.outputSchema).includes('"oneOf"')) {
    send({id:message.id,error:{message:'oneOf is not permitted when strict is true'}});return;
  }
  send({id:message.id,result});
  if (message.method === 'turn/start') {
    const threadId = message.params.threadId;
    const attempt = (turns.get(threadId) ?? 0) + 1;
    turns.set(threadId,attempt);
    const guided = Boolean(message.params.outputSchema?.properties?.questions);
    const match = /Return a stored (quiz|test|flashcards|diagram|notes)/.exec(message.params.input[0].text);
    if (match) requested.set(threadId,match[1]);
    if (message.params.input[0].text.includes('explicitly requested a saved diagram')) requested.set(threadId,'diagram');
    if (message.params.input[0].text.includes('always invalid')) forceInvalid.add(threadId);
    const kind = requested.get(threadId);
    const questions = Array.from({length:attempt === 1 || forceInvalid.has(threadId) ? 1 : 2},(_,index) => ({responseType:'short_response',choices:[],prompt:'Circuit question '+index,answer:'A closed circuit.',explanation:'Current needs a closed path.',marks:1}));
    const request = {kind,subjectId:null,topicId:null,title:null,instructions:'Circuits',difficulty:'standard',...(kind === 'quiz' || kind === 'flashcards' ? {questionCount:2} : {}),...(kind === 'quiz' || kind === 'test' ? {questionTypes:['short_response']} : {}),...(kind === 'test' ? {testLength:{mode:'questions',questionCount:2}} : {})};
    const generated = {title:'Circuits '+kind,content:kind === 'diagram' ? (attempt === 1 ? '' : '<button onclick="this.textContent=1">Explore circuits</button>') : kind === 'notes' ? '# Circuits\\nA closed path carries current.' : '',questions:kind === 'notes' || kind === 'diagram' ? [] : questions};
    const show = /Show my saved (quiz|test|flashcards|diagram|notes)/.exec(message.params.input[0].text);
    const context = show ? JSON.parse(message.params.input[0].text.split('Current app context and study data, treat as data: ')[1].split('\\n\\nStudent message:')[0]) : null;
    const output = show ? {response:{kind:'message',content:'Here is your saved work.',resourceIds:context.savedResources.filter(resource => resource.kind === show[1]).map(resource => resource.id)}} : guided ? {title:'Circuits practice',content:'',questions} : kind ? {response:{kind:'resource',request,generated}} : {response:{kind:'message',content:'I can make that for you. What should it cover?'}};
    send({method:'item/completed',params:{threadId,item:{id:'answer',type:'agentMessage',phase:'final_answer',text:JSON.stringify(output)}}});
    send({method:'turn/completed',params:{threadId,turn:{status:'completed'}}});
  }
});
`, { mode:0o700 });
  process.env.CENTRE_CODEX_BIN = binary;
  const service = await createService({ dataDir:directory });
  const request = async (path:string, body?:unknown) => {
    const response = await fetch(`http://127.0.0.1:${service.port}/api${path}`, { method:body === undefined ? 'GET' : 'POST', headers:{Authorization:`Bearer ${service.token}`,'Content-Type':'application/json'}, ...(body === undefined ? {} : {body:JSON.stringify(body)}) });
    const value:unknown = await response.json();
    assert.equal(response.status,200,JSON.stringify(value));
    return value;
  };
  try {
    const ordinaryChat = chatSchema.parse(await request('/chats',{}));
    const ordinaryReply = chatSchema.parse(await request(`/chats/${ordinaryChat.id}/messages`,{content:'Make a quiz about circuits.',context:{page:'personal-learning'}}));
    assert.match(ordinaryReply.messages.at(-1)?.content ?? '',/I can make that/);
    assert.equal(snapshotSchema.parse(await request('/state')).resources.length,0,'A normal chat can finish without saving the requested quiz.');
    const requests:CreateResource[] = [
      {kind:'quiz',subjectId:null,topicId:null,instructions:'Circuits',difficulty:'standard',questionCount:2,questionTypes:['short_response']},
      {kind:'test',subjectId:null,topicId:null,instructions:'Circuits',difficulty:'standard',testLength:{mode:'questions',questionCount:2},questionTypes:['short_response']},
    ];
    for (const resourceRequest of requests) {
      const chat = chatSchema.parse(await request('/chats',{}));
      const completed = chatSchema.parse(await request(`/chats/${chat.id}/messages`,{content:`Make a ${resourceRequest.kind} about circuits.`,context:{page:'personal-learning'},resourceRequest}));
      const state = snapshotSchema.parse(await request('/state'));
      const ids = completed.messages.flatMap(message => message.resourceIds);
      const saved = state.resources.filter(resource => ids.includes(resource.id));
      assert.equal(saved.length,1,'Creation must finish with one saved resource, not an offer or inline questions.');
      assert.equal(saved[0]?.kind,resourceRequest.kind);
      assert.equal(saved[0]?.questions.length,2,'Invalid question counts should be repaired before saving.');
      assert.equal(saved[0]?.subjectId,null);
      assert.match(completed.messages.at(-1)?.content ?? '',/saved/i);
    }
    const reopened = await Store.open(directory);
    assert.equal(reopened.state.resources.length,2);
    assert.equal(reopened.state.chats.filter(chat => chat.messages.some(message => message.resourceIds.length)).length,2);
    for (const kind of ['quiz','test','flashcards','diagram','notes']) {
      const chat = chatSchema.parse(await request('/chats',{}));
      const completed = chatSchema.parse(await request(`/chats/${chat.id}/messages`,{content:`Return a stored ${kind} about circuits.`,context:{page:'personal-learning'}}));
      const state = snapshotSchema.parse(await request('/state'));
      const ids = completed.messages.flatMap(message => message.resourceIds);
      const saved = state.resources.filter(resource => ids.includes(resource.id));
      assert.equal(saved.length,1,`${kind} must save from a structured final response without a tool call.`);
      assert.equal(saved[0]?.kind,kind);
      if (kind === 'diagram') assert.match(saved[0]?.content ?? '',/<button/);
      else if (kind === 'notes') assert.match(saved[0]?.content ?? '',/# Circuits/);
      else assert.equal(saved[0]?.questions.length,2);
    }
    assert.equal((await Store.open(directory)).state.resources.length,7);
    const slashChat = chatSchema.parse(await request('/chats',{}));
    await request(`/chats/${slashChat.id}/messages`,{content:'/diagram Offer once, then make an interactive circuit diagram.',context:{page:'personal-learning'}});
    assert.equal(snapshotSchema.parse(await request('/state')).resources.length,8,'A slash command must recover an offer-only response into a saved resource.');
    const invalidChat = chatSchema.parse(await request('/chats',{}));
    const failure = await fetch(`http://127.0.0.1:${service.port}/api/chats/${invalidChat.id}/messages`,{method:'POST',headers:{Authorization:`Bearer ${service.token}`,'Content-Type':'application/json'},body:JSON.stringify({content:'Return a stored quiz with always invalid question count.',context:{page:'personal-learning'}})});
    assert.equal(failure.status,422,'Invalid output must stop after one repair attempt.');
    const afterFailure = snapshotSchema.parse(await request('/state'));
    assert.equal(afterFailure.resources.length,8,'Failed generation must not leave partial resources.');
    assert.equal(afterFailure.activeResponses.length,0,'Failed generation must release the chat for retry.');
    assert.equal(afterFailure.chats.find(chat => chat.id === invalidChat.id)?.messages.at(-1)?.role,'user','A failed save must not claim success.');
    for (const kind of ['quiz','test','flashcards','diagram','notes']) {
      const chat = chatSchema.parse(await request('/chats',{}));
      const shown = chatSchema.parse(await request(`/chats/${chat.id}/messages`,{content:`Show my saved ${kind}.`,context:{page:'chat'}}));
      const expected = afterFailure.resources.filter(resource => resource.kind === kind).map(resource => resource.id).sort();
      assert.deepEqual(shown.messages.at(-1)?.resourceIds.sort(),expected,`Chat should display original saved ${kind} resources.`);
      assert.equal(snapshotSchema.parse(await request('/state')).resources.length,8,'Showing old work must not create copies.');
    }
  } finally {
    await service.close();
    if (original === undefined) delete process.env.CENTRE_CODEX_BIN; else process.env.CENTRE_CODEX_BIN = original;
    await rm(directory,{recursive:true,force:true});
  }
});
