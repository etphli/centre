import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { z } from 'zod';
import { modelSchema } from '../shared/schema';
import { createService } from './index';
import { Store } from './store';

test('catalog validation and saved choices drive chat, resource and grading protocol calls',async () => {
  const directory = await mkdtemp(join(tmpdir(),'centre-model-settings-'));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input,init) => {
    const url = input instanceof Request ? input.url : input.toString();
    if (url.startsWith('https://curriculum.nsw.edu.au/')) return new Response('<html><title>Official test evidence</title><main>Stage 5 MA5-TEST-01 This test response is retrieved curriculum evidence used only to verify prompt context and is not a real syllabus outcome.</main></html>',{headers:{'content-type':'text/html'}});
    return originalFetch(input,init);
  };
  const original = process.env.CENTRE_CODEX_BIN; const binary = join(directory,'codex-fixture');
  await writeFile(binary,`#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
let threads = 0;
const model = (id,efforts) => ({id,model:id,displayName:id,hidden:false,supportedReasoningEfforts:efforts.map(reasoningEffort=>({reasoningEffort})),defaultReasoningEffort:'medium'});
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
readline.createInterface({input:process.stdin}).on('line',line => {
  const message = JSON.parse(line); if (!message.id) return;
  fs.appendFileSync('calls.jsonl',JSON.stringify(message)+'\\n');
  let result = {};
  if (message.method === 'account/read') result = {account:{id:'fixture'}};
  if (message.method === 'model/list') result = message.params.cursor ? {data:[model('gpt-6-luna',['low','medium'])],nextCursor:null} : {data:[model('gpt-6.1-sol',['medium','high','ultra'])],nextCursor:'page-two'};
  if (message.method === 'thread/start') result = {thread:{id:'thread-'+(++threads)}};
  send({id:message.id,result});
  if (message.method === 'turn/start') {
    const params = message.params;
    const grading = Boolean(params.outputSchema?.properties?.feedback);
    const prompt = params.input?.[0]?.text ?? '';
    const test = prompt.includes('Create a complete test');
    const text = params.outputSchema ? JSON.stringify(grading ? {score:1,total:1,feedback:[{questionId:'q-one',score:1,maxScore:1,feedback:'Correct.',needsReview:false}]} : test ? {title:'Timed test',content:'',questions:[{responseType:'short_response',choices:[],prompt:'Solve $2x=8$.',answer:'$x=4$.',explanation:'Divide by 2.',marks:1}]} : {title:'Selected model notes',content:'Study equations.',questions:[]}) : 'Fixture response';
    const complete = () => {
      send({method:'item/completed',params:{threadId:params.threadId,item:{id:'answer',type:'agentMessage',phase:'final_answer',text}}});
      send({method:'turn/completed',params:{threadId:params.threadId,turn:{status:'completed'}}});
    };
    setTimeout(complete,params.input[0].text.includes('hold this response') ? 200 : 0);
  }
});
`,{mode:0o700});
  process.env.CENTRE_CODEX_BIN = binary;
  const store = await Store.open(directory);
  store.state.subjects.push({id:'math',name:'Year10Maths',shortName:null,color:'#fff',icon:'book'});
  store.state.topics.push({id:'algebra',subjectId:'math',name:'Algebra',description:''});
  store.state.resources.push({id:'quiz',subjectId:'math',topicId:'algebra',title:'Quiz',kind:'quiz',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),completedAt:null,content:'',questions:[{id:'q-one',responseType:'short_response',choices:[],prompt:'1+1',answer:'2',explanation:'Addition.',marks:1}],questionTypes:['multiple_choice','short_response','long_response'],testLength:null,durationMinutes:null});
  await store.save();
  let service = await createService({dataDir:directory});
  const request = async (path: string,method = 'GET',body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${service.port}${path}`,{method,headers:{Authorization:`Bearer ${service.token}`,...(body === undefined ? {} : {'Content-Type':'application/json'})},...(body === undefined ? {} : {body:JSON.stringify(body)})});
    return {status:response.status,body:await response.json()};
  };
  const calls = async () => z.array(z.object({method:z.string(),params:z.record(z.string(),z.unknown())})).parse((await readFile(join(directory,'calls.jsonl'),'utf8')).trim().split('\n').map(line => JSON.parse(line)));
  try {
    const models = z.array(modelSchema).parse((await request('/api/models')).body.models);
    assert.equal(models.length,2); assert.deepEqual(models[0]?.reasoningEfforts,['medium','high','ultra']);
    const skills = z.array(z.object({id:z.string()})).parse((await request('/api/skills')).body.skills); assert.ok(skills.some(skill => skill.id === 'how'));
    assert.equal((await request('/api/settings','PATCH',{chatModel:'missing'})).status,400);
    assert.equal((await request('/api/settings','PATCH',{reasoningEffort:'none'})).status,400);
    assert.equal((await request('/api/settings','PATCH',{gradingModel:'missing'})).status,400);
    assert.equal((await request('/api/settings','PATCH',{gradingModel:'gpt-6.1-sol',gradingReasoningEffort:'low'})).status,400);
    assert.equal((await request('/api/state')).body.settings.chatModel,'gpt-6.1-sol');
    assert.equal((await request('/api/settings','PATCH',{chatModel:'gpt-6-luna',reasoningEffort:'low',nickname:'Ethan',responseStyle:'concise',studentYearLevel:9,defaultQuizQuestions:6,defaultTestLengthMode:'time',defaultTestMinutes:30,defaultDifficulty:'challenging'})).status,200);
    const chat = (await request('/api/chats','POST',{})).body;
    assert.equal((await request(`/api/chats/${chat.id}/messages`,'POST',{content:'How do equations work?',context:{page:'chat',subjectId:'math'}})).status,200);
    assert.equal((await request('/api/settings','PATCH',{chatModel:'gpt-6.1-sol',reasoningEffort:'high'})).status,200);
    assert.equal((await request(`/api/chats/${chat.id}/messages`,'POST',{content:'Second turn',context:{page:'chat'}})).status,200);
    const turns = (await calls()).filter(call => call.method === 'turn/start');
    assert.deepEqual(turns.map(call => [call.params.model,call.params.effort]),[['gpt-6-luna','low'],['gpt-6.1-sol','high']]);
    assert.equal(turns[0]?.params.threadId,turns[1]?.params.threadId);
    const promptText = (input: unknown) => z.array(z.object({text:z.string()})).parse(input)[0]?.text ?? '';
    const chatPrompt = promptText(turns[0]?.params.input);
    assert.match(chatPrompt,/"id":"unslop"/); assert.match(chatPrompt,/"id":"how"/); assert.match(chatPrompt,/Centre runtime adaptation/);
    assert.match(chatPrompt,/"nickname":"Ethan"/); assert.match(chatPrompt,/"responseStyle":"concise"/); assert.match(chatPrompt,/"yearLevel":10/); assert.match(chatPrompt,/MA5-TEST-01/);
    assert.equal((await request('/api/resources/generate','POST',{kind:'notes',subjectId:'math',topicId:'algebra',instructions:'Explain linear equations.'})).status,200);
    const generation = (await calls()).filter(call => call.method === 'turn/start').at(-1);
    assert.equal(generation?.params.model,'gpt-6.1-sol'); assert.equal(generation?.params.effort,'high');
    const generationPrompt = promptText(generation?.params.input); assert.match(generationPrompt,/"id":"unslop"/); assert.match(generationPrompt,/"id":"teach"/);
    assert.match(generationPrompt,/"yearLevel":10/); assert.match(generationPrompt,/"nickname":"Ethan"/); assert.match(generationPrompt,/Difficulty: challenging/); assert.match(generationPrompt,/Create study notes; no assessment fields are needed/); assert.doesNotMatch(generationPrompt,/selected response types|with 6 questions/);
    const timedTest = await request('/api/resources/generate','POST',{kind:'test',subjectId:'math',topicId:'algebra',instructions:'A short algebra test.'});
    assert.equal(timedTest.status,200); assert.equal(timedTest.body.durationMinutes,30); assert.deepEqual(timedTest.body.testLength,{mode:'time',minutes:30}); assert.equal(timedTest.body.questions.length,1);
    const testGeneration = (await calls()).filter(call => call.method === 'turn/start').at(-1);
    const testPrompt = promptText(testGeneration?.params.input); assert.match(testPrompt,/Create a 30-minute test/); assert.match(testPrompt,/there is no fixed question count/); assert.doesNotMatch(testPrompt,/exactly 6 questions/);
    assert.equal((await request('/api/settings','PATCH',{defaultTestLengthMode:'questions',defaultTestQuestions:1})).status,200);
    const questionCountTest = await request('/api/resources/generate','POST',{kind:'test',subjectId:'math',topicId:'algebra',instructions:'A one-question algebra test.'});
    assert.equal(questionCountTest.status,200); assert.equal(questionCountTest.body.durationMinutes,null); assert.deepEqual(questionCountTest.body.testLength,{mode:'questions',questionCount:1}); assert.equal(questionCountTest.body.questions.length,1);
    const questionCountPrompt = promptText((await calls()).filter(call => call.method === 'turn/start').at(-1)?.params.input); assert.match(questionCountPrompt,/Create a test with exactly 1 question/);
    assert.equal((await request('/api/settings','PATCH',{gradingModel:'gpt-6.1-sol',gradingReasoningEffort:'high'})).status,200);
    assert.equal((await request('/api/quiz/grade','POST',{resourceId:'quiz',answers:{'q-one':'2'}})).status,200);
    const grading = (await calls()).filter(call => call.method === 'turn/start').at(-1);
    assert.equal(grading?.params.model,'gpt-6.1-sol'); assert.equal(grading?.params.effort,'high');
    assert.match(promptText(grading?.params.input),/"id":"unslop"/);
    assert.match(promptText(grading?.params.input),/"yearLevel":10/);
    const pending = request(`/api/chats/${chat.id}/messages`,'POST',{content:'hold this response',context:{page:'chat'}});
    for (let attempt = 0; attempt < 50; attempt++) { if ((await request('/api/state')).body.chats[0]?.messages.at(-1)?.content === 'hold this response') break; await setTimeout(5); }
    assert.equal((await request(`/api/chats/${chat.id}/archive`,'POST',{})).status,409);
    assert.equal((await pending).status,200);
    assert.equal((await request(`/api/chats/${chat.id}/model`,'PATCH',{model:'gpt-6-luna',effort:'low'})).status,200);
    assert.equal((await request(`/api/chats/${chat.id}/messages`,'POST',{content:'Use my chat choice',context:{page:'chat'}})).status,200);
    const scopedTurn = (await calls()).filter(call => call.method === 'turn/start').at(-1);
    assert.equal(scopedTurn?.params.model,'gpt-6-luna'); assert.equal(scopedTurn?.params.effort,'low');
    const newChat = (await request('/api/chats','POST',{})).body;
    assert.equal((await request(`/api/chats/${newChat.id}/messages`,'POST',{content:'Use the default',context:{page:'chat'}})).status,200);
    const defaultTurn = (await calls()).filter(call => call.method === 'turn/start').at(-1);
    assert.equal(defaultTurn?.params.model,'gpt-6.1-sol'); assert.equal(defaultTurn?.params.effort,'high');
    assert.equal((await request('/api/state')).body.settings.chatModel,'gpt-6.1-sol');
    assert.equal((await request(`/api/chats/${chat.id}/model`,'PATCH',{model:'retired-model',effort:'medium'})).status,400);
    const saved = await Store.open(directory); assert.equal(saved.state.settings.chatModel,'gpt-6.1-sol'); assert.equal(saved.state.settings.reasoningEffort,'high'); assert.equal(saved.state.settings.gradingModel,'gpt-6.1-sol'); assert.equal(saved.state.settings.gradingReasoningEffort,'high');
    await service.close();
    saved.state.settings.chatModel = 'retired-model'; await saved.save();
    service = await createService({dataDir:directory});
    const unavailable = await request(`/api/chats/${newChat.id}/messages`,'POST',{content:'Keep this request for retry.',context:{page:'chat'}});
    assert.equal(unavailable.status,400); assert.match(unavailable.body.error,/no longer in the Codex model catalog/);
    assert.equal((await request('/api/state')).body.chats[0]?.messages.at(-1)?.content,'Keep this request for retry.');
  } finally {
    await service.close(); if (original === undefined) delete process.env.CENTRE_CODEX_BIN; else process.env.CENTRE_CODEX_BIN = original;
    globalThis.fetch = originalFetch;
    await rm(directory,{recursive:true,force:true});
  }
});
