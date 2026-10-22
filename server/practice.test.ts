import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { assistantMemorySchema, chatSchema, quizDraftSchema, resourceSchema, snapshotSchema } from '../shared/schema';
import { createService } from './index';
import { Store, writeStateFile } from './store';
import { Resources } from './resources';
import { Codex } from './codex';

const now = '2026-10-22T00:00:00.000Z';
function quiz(id: string, topicId = 'algebra') {
  return resourceSchema.parse({ id, subjectId:'math', topicId, title:id, kind:'quiz', createdAt:now, updatedAt:now, content:'', questions:[
    { id:'q1', concept:'Linear equations', prompt:'Solve 2x=8.', answer:'4', marks:2 },
    { id:'q2', concept:'Substitution', prompt:'Evaluate x+1 when x=4.', answer:'5', marks:1 },
  ] });
}
const result = (score = 0) => ({ score, total:3, feedback:[
  { questionId:'q1', concept:'Linear equations', score, maxScore:2, feedback:score === 2 ? 'Correct inverse operations.' : 'Use inverse operations.', needsReview:score < 2 },
  { questionId:'q2', concept:'Substitution', score:1, maxScore:1, feedback:'Correct.', needsReview:false },
] });
async function seed(directory: string) {
  const store = await Store.open(directory);
  store.state.subjects.push({ id:'math', name:'Mathematics', shortName:null, color:'#fff', icon:'book' });
  store.state.topics.push({ id:'algebra', subjectId:'math', name:'Algebra', description:'' },{ id:'geometry', subjectId:'math', name:'Geometry', description:'' });
  store.state.resources.push(quiz('quiz-a'),quiz('quiz-b','geometry'));
  await store.save();
  return store;
}
async function fixture(configure?: (store: Store) => void) {
  const directory = await mkdtemp(join(tmpdir(),'centre-practice-'));
  const store = await seed(directory);
  configure?.(store);
  await store.save();
  const original = process.env.CENTRE_CODEX_BIN;
  const binary = join(directory,'codex-fixture');
  await writeFile(join(directory,'grade.json'),JSON.stringify(result()));
  await writeFile(binary,`#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
let threads = 0;
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
readline.createInterface({input:process.stdin}).on('line',line => {
  const message = JSON.parse(line); if (!message.id) return;
  const params = message.params;
  let result = {};
  if (message.method === 'account/read') result = {account:{id:'fixture'}};
  if (message.method === 'model/list') result = {data:['gpt-6.1-sol','gpt-6-luna'].map(model => ({model,displayName:model,supportedReasoningEfforts:[{reasoningEffort:'medium'}],defaultReasoningEffort:'medium'})),nextCursor:null};
  if (message.method === 'thread/start') result = {thread:{id:'thread-'+(++threads)}};
  send({id:message.id,result});
  if (message.method !== 'turn/start') return;
  fs.appendFileSync('turns.jsonl',JSON.stringify(params)+'\\n');
  const grading = Boolean(params.outputSchema?.properties?.feedback);
  if (grading && fs.existsSync('fail-grade')) {
    send({method:'turn/completed',params:{threadId:params.threadId,turn:{status:'failed',error:{message:'Fixture grading unavailable'}}}});return;
  }
  const text = grading ? fs.readFileSync('grade.json','utf8') : params.outputSchema?.properties?.response
    ? JSON.stringify({response:{kind:'message',content:'Use inverse operations.'}})
    : JSON.stringify({title:'Targeted practice',content:'',practiceFocus:['Linear equations'],questions:[{concept:'Linear equations',responseType:'short_response',choices:[],prompt:'Solve 3x=12.',answer:'4',explanation:'Divide by 3.',marks:2}]});
  setTimeout(() => {
    send({method:'item/completed',params:{threadId:params.threadId,item:{id:'answer',type:'agentMessage',phase:'final_answer',text}}});
    send({method:'turn/completed',params:{threadId:params.threadId,turn:{status:'completed'}}});
  },grading ? 30 : 0);
});
`,{ mode:0o700 });
  process.env.CENTRE_CODEX_BIN = binary;
  let service = await createService({ dataDir:directory });
  return {
    directory, store,
    async request(path: string, method = 'GET', body?: unknown, expected = 200): Promise<unknown> {
      const response = await fetch(`http://127.0.0.1:${service.port}/api${path}`,{ method, headers:{ Authorization:`Bearer ${service.token}`, 'Content-Type':'application/json' }, ...(body === undefined ? {} : {body:JSON.stringify(body)}) });
      const value: unknown = await response.json();
      assert.equal(response.status,expected,JSON.stringify(value));
      return value;
    },
    async restart() { await service.close(); service = await createService({ dataDir:directory }); },
    async turns() {
      return z.array(z.object({ input:z.array(z.object({ text:z.string() })), outputSchema:z.object({ properties:z.record(z.string(),z.unknown()) }).optional() })).parse((await readFile(join(directory,'turns.jsonl'),'utf8')).trim().split('\n').map(line => JSON.parse(line)));
    },
    async close() {
      await service.close();
      if (original === undefined) delete process.env.CENTRE_CODEX_BIN; else process.env.CENTRE_CODEX_BIN = original;
      await rm(directory,{ recursive:true, force:true });
    },
  };
}

test('drafts retain answers and question position across resource switches and service restarts; start-over tombstones only its draft', async () => {
  const app = await fixture();
  try {
    const first = quizDraftSchema.parse(await app.request('/resources/quiz-a/practice-draft','PATCH',{ id:randomUUID(), expectedRevision:null, answers:{q1:'unfinished'}, currentQuestion:1 }));
    assert.deepEqual(await app.request('/resources/quiz-a/practice-draft','PATCH',{ id:first.id, expectedRevision:null, answers:first.answers, currentQuestion:1 }),first,'An unknown save outcome can be safely retried.');
    const other = quizDraftSchema.parse(await app.request('/resources/quiz-b/practice-draft','PATCH',{ id:randomUUID(), expectedRevision:null, answers:{q2:'5'}, currentQuestion:0 }));
    const updated = quizDraftSchema.parse(await app.request('/resources/quiz-a/practice-draft','PATCH',{ id:first.id, expectedRevision:first.revision, answers:{q1:'4',q2:'5'}, currentQuestion:1 }));
    assert.equal(updated.revision,2);
    await app.request('/resources/quiz-a/practice-draft','PATCH',{ id:first.id, expectedRevision:1, answers:{q1:'stale'}, currentQuestion:0 },409);
    await app.request('/resources/quiz-a/practice-draft','PATCH',{ id:first.id, expectedRevision:2, answers:{unknown:'bad'}, currentQuestion:0 },400);
    await app.request('/resources/quiz-a/practice-draft','PATCH',{ id:first.id, expectedRevision:2, answers:{}, currentQuestion:2 },400);
    await app.restart();
    const state = snapshotSchema.parse(await app.request('/state'));
    assert.deepEqual(state.practiceDrafts.find(draft => draft.id === first.id),updated);
    assert.deepEqual(state.practiceDrafts.find(draft => draft.id === other.id),other);
    await app.request('/resources/quiz-a/practice-draft/start-over','POST',{ id:first.id, expectedRevision:1 },409);
    await app.request('/resources/quiz-a/practice-draft/start-over','POST',{ id:first.id, expectedRevision:2 });
    await app.request('/resources/quiz-a/practice-draft/start-over','POST',{ id:first.id, expectedRevision:2 });
    const reopened = await Store.open(app.directory);
    assert.ok(reopened.state.practiceDrafts.find(draft => draft.id === first.id)?.deletedAt);
    assert.deepEqual(reopened.state.practiceDrafts.find(draft => draft.id === other.id),other);
    await app.request('/resources/quiz-a/practice-draft','PATCH',{ id:first.id, expectedRevision:null, answers:{}, currentQuestion:0 },409);
    const replacement = quizDraftSchema.parse(await app.request('/resources/quiz-a/practice-draft','PATCH',{ id:randomUUID(), expectedRevision:null, answers:{}, currentQuestion:0 }));
    assert.notEqual(replacement.id,first.id);
  } finally { await app.close(); }
});

test('disk failures roll back new drafts, saved answers, and start-over in memory and on disk', async () => {
  const directory = await mkdtemp(join(tmpdir(),'centre-practice-disk-'));
  const store = await seed(directory);
  const codex = new Codex(directory,[],async () => undefined);
  const resources = new Resources(store,codex);
  try {
    const input = { id:randomUUID(), expectedRevision:null, answers:{q1:'partial'}, currentQuestion:1 };
    await mkdir(join(directory,'state.json.tmp'));
    await assert.rejects(resources.saveQuizDraft('quiz-a',input),{ status:503 });
    assert.deepEqual(store.state.practiceDrafts,[]);
    assert.deepEqual((await Store.open(directory)).state.practiceDrafts,[]);
    await rm(join(directory,'state.json.tmp'),{ recursive:true });
    const saved = await resources.saveQuizDraft('quiz-a',input);
    await mkdir(join(directory,'state.json.tmp'));
    await assert.rejects(resources.saveQuizDraft('quiz-a',{ ...input, expectedRevision:saved.revision, answers:{q1:'changed'}, currentQuestion:0 }),{ status:503 });
    assert.deepEqual(store.state.practiceDrafts,[saved]);
    await assert.rejects(resources.startOverQuizDraft('quiz-a',{ id:saved.id, expectedRevision:saved.revision }),{ status:503 });
    assert.deepEqual(store.state.practiceDrafts,[saved]);
    assert.deepEqual((await Store.open(directory)).state.practiceDrafts,[saved]);
  } finally { await codex.close(); await rm(directory,{ recursive:true, force:true }); }
});

test('unrelated queued saves cannot publish failed practice changes or lose successful commits', async () => {
  const directory = await mkdtemp(join(tmpdir(),'centre-practice-atomic-'));
  await seed(directory);
  let nextGate: { fail:boolean; signal:() => void; paused:Promise<void> } | undefined;
  let releasePending:() => void = () => {};
  function holdNextWrite(fail:boolean) {
    let signal:() => void = () => {};
    const started = new Promise<void>(resolve => { signal = resolve; });
    const paused = new Promise<void>(resolve => { releasePending = resolve; });
    nextGate = { fail, signal, paused };
    return { started, release:releasePending };
  }
  const store = await Store.open(directory, async (path, content) => {
    const gate = nextGate;
    nextGate = undefined;
    if (gate) {
      gate.signal();
      await gate.paused;
      if (gate.fail) throw Object.assign(new Error('Simulated disk write failure'),{ code:'EIO' });
    }
    await writeStateFile(path,content);
  });
  const codex = new Codex(directory,[],async () => undefined);
  const resources = new Resources(store,codex);
  const input = { id:randomUUID(), expectedRevision:null, answers:{q1:'private draft edit'}, currentQuestion:1 };
  try {
    const failure = holdNextWrite(true);
    const failedDraft = resources.saveQuizDraft('quiz-a',input);
    await failure.started;
    assert.deepEqual(store.state.practiceDrafts,[],'Uncommitted drafts must not be visible to other writers.');
    store.state.settings.nickname = 'Unrelated setting';
    const unrelatedSave = store.save();
    failure.release();
    await assert.rejects(failedDraft,{ status:503 });
    await unrelatedSave;
    const afterFailure = await Store.open(directory);
    assert.deepEqual(afterFailure.state.practiceDrafts,[]);
    assert.equal(afterFailure.state.settings.nickname,'Unrelated setting');

    const success = holdNextWrite(false);
    const pendingDraft = resources.saveQuizDraft('quiz-a',input);
    await success.started;
    store.state.settings.nickname = 'Later setting';
    const laterSave = store.save();
    success.release();
    const saved = await pendingDraft;
    await laterSave;
    const afterSuccess = await Store.open(directory);
    assert.deepEqual(afterSuccess.state.practiceDrafts,[saved]);
    assert.equal(afterSuccess.state.settings.nickname,'Later setting');
  } finally { releasePending(); await codex.close(); await rm(directory,{ recursive:true, force:true }); }
});

test('review resolution and relocation serialize without restoring an old topic', async () => {
  const directory = await mkdtemp(join(tmpdir(),'centre-review-move-'));
  await seed(directory);
  let release:() => void = () => {};
  let signal:() => void = () => {};
  const started = new Promise<void>(resolve => { signal = resolve; });
  const paused = new Promise<void>(resolve => { release = resolve; });
  let hold = false;
  const store = await Store.open(directory, async (path, content) => {
    if (hold) { hold = false; signal(); await paused; }
    await writeStateFile(path,content);
  });
  const codex = new Codex(directory,[],async () => undefined);
  const resources = new Resources(store,codex);
  store.state.memories.push({id:'review',subjectId:'math',topicId:'algebra',resourceId:'quiz-a',question:'Solve',note:'Review',createdAt:now,nextReviewAt:now,resolvedAt:null,learningNeedId:null});
  await store.save();
  try {
    hold = true;
    const resolving = resources.resolveMemory('review');
    await started;
    const moving = resources.relocate('quiz-a',{subjectId:'math',topicId:'geometry'});
    release();
    await Promise.all([resolving,moving]);
    const reopened = await Store.open(directory);
    for (const state of [store.state,reopened.state]) {
      assert.equal(state.resources.find(item => item.id === 'quiz-a')?.topicId,'geometry');
      assert.equal(state.memories[0].topicId,'geometry');
      assert.ok(state.memories[0].resolvedAt);
    }
  } finally { release(); await codex.close(); await rm(directory,{recursive:true,force:true}); }
});

test('failed and invalid marking preserve the durable draft; successful retry is atomic and sourceDraftId is idempotent', async () => {
  const app = await fixture();
  try {
    const answers = {q1:'3',q2:'5'};
    const draft = quizDraftSchema.parse(await app.request('/resources/quiz-a/practice-draft','PATCH',{ id:randomUUID(), expectedRevision:null, answers, currentQuestion:1 }));
    const other = quizDraftSchema.parse(await app.request('/resources/quiz-b/practice-draft','PATCH',{ id:randomUUID(), expectedRevision:null, answers:{q1:'other'}, currentQuestion:0 }));
    const submission = { resourceId:'quiz-a', draftId:draft.id, expectedDraftRevision:draft.revision, answers };
    await app.request('/quiz/grade','POST',{ ...submission, answers:{q1:'unsaved'} },409);
    await writeFile(join(app.directory,'fail-grade'),'');
    await app.request('/quiz/grade','POST',submission,500);
    await rm(join(app.directory,'fail-grade'));
    for (const invalid of ['not JSON',JSON.stringify({ ...result(), feedback:[result().feedback[0]] }),JSON.stringify({ ...result(), feedback:[{ ...result().feedback[0], score:3 },result().feedback[1]] })]) {
      await writeFile(join(app.directory,'grade.json'),invalid);
      await app.request('/quiz/grade','POST',submission,422);
      const persisted = await Store.open(app.directory);
      assert.deepEqual(persisted.state.practiceDrafts,[draft,other]);
      assert.equal(persisted.state.attempts.length,0);
      assert.equal(persisted.state.learningNeeds.length,0);
      assert.equal(persisted.state.resources[0]?.completedAt,null);
    }
    await writeFile(join(app.directory,'grade.json'),JSON.stringify(result()));
    await mkdir(join(app.directory,'state.json.tmp'));
    await app.request('/quiz/grade','POST',submission,503);
    const rolledBack = snapshotSchema.parse(await app.request('/state'));
    assert.deepEqual(rolledBack.practiceDrafts,[draft,other]);
    assert.equal(rolledBack.attempts.length,0);
    assert.equal(rolledBack.learningNeeds.length,0);
    assert.equal(rolledBack.memories.length,0);
    assert.equal(rolledBack.resources[0]?.completedAt,null);
    await rm(join(app.directory,'state.json.tmp'),{ recursive:true });
    const replies = await Promise.all([app.request('/quiz/grade','POST',submission),app.request('/quiz/grade','POST',submission)]);
    assert.deepEqual(replies[0],replies[1]);
    const successful = (await Store.open(app.directory)).state;
    assert.equal(successful.attempts.length,1);
    assert.equal(successful.attempts[0]?.sourceDraftId,draft.id);
    assert.equal(successful.learningNeeds[0]?.evidence.length,1);
    assert.ok(successful.practiceDrafts.find(item => item.id === draft.id)?.deletedAt);
    assert.deepEqual(successful.practiceDrafts.find(item => item.id === other.id),other);
    const gradingCalls = (await app.turns()).filter(turn => turn.outputSchema?.properties.feedback).length;
    await app.restart();
    assert.deepEqual(await app.request('/quiz/grade','POST',submission),replies[0]);
    assert.equal((await app.turns()).filter(turn => turn.outputSchema?.properties.feedback).length,gradingCalls);
    assert.deepEqual((await Store.open(app.directory)).state.attempts,successful.attempts);
    assert.deepEqual((await Store.open(app.directory)).state.learningNeeds,successful.learningNeeds);
    await app.request('/quiz/grade','POST',{ ...submission, answers:{q1:'different'} },409);
    await app.request('/quiz/grade','POST',{ ...submission, resourceId:'quiz-b' },409);
  } finally { await app.close(); }
});

test('learning needs persist separately from 50 personal memories, guide scoped generation and chat, and decrease after correct work or Review', async () => {
  const personal = Array.from({ length:50 },(_,index) => assistantMemorySchema.parse({ id:randomUUID(), key:`preference-${index}`, content:`Personal fact ${index}`, createdAt:now, updatedAt:now }));
  const app = await fixture(store => { store.state.assistantMemories = personal; });
  try {
    const withoutEvidence = resourceSchema.parse(await app.request('/resources/generate','POST',{ kind:'quiz',subjectId:'math',topicId:'algebra',questionCount:1,questionTypes:['short_response'],instructions:'Practise inverse operations.' }));
    assert.deepEqual(withoutEvidence.practiceFocus,[],'A model-provided focus must not invent a history of feedback.');
    const answers = {q1:'3',q2:'5'};
    await app.request('/quiz/grade','POST',{ resourceId:'quiz-a', answers });
    const first = snapshotSchema.parse(await app.request('/state')).learningNeeds[0];
    assert.ok(first);
    await app.request('/quiz/grade','POST',{ resourceId:'quiz-a', answers });
    let state = snapshotSchema.parse(await app.request('/state'));
    assert.equal(state.learningNeeds.length,1);
    assert.equal(state.learningNeeds[0]?.id,first.id);
    assert.equal(state.learningNeeds[0]?.needScore,4);
    assert.equal(state.memories.length,1,'Repeated mistakes should reuse the linked Review item.');
    await app.request('/quiz/grade','POST',{ resourceId:'quiz-b', answers });
    state = snapshotSchema.parse(await app.request('/state'));
    const geometryNeed = state.learningNeeds.find(need => need.topicId === 'geometry');
    assert.ok(geometryNeed);
    assert.equal(state.learningNeeds.length,2);
    assert.deepEqual(state.assistantMemories,personal);
    await app.request('/resources/generate','POST',{ kind:'quiz', subjectId:'math', topicId:'algebra', questionCount:1, questionTypes:['short_response'], instructions:'Practise inverse operations.' });
    const generation = (await app.turns()).at(-1)?.input[0]?.text ?? '';
    const evidenceText = generation.split('Recent graded learning evidence for this exact topic: ')[1]?.split('. Return practiceFocus')[0];
    assert.ok(evidenceText);
    const evidence = z.array(z.object({ id:z.string(), evidence:z.array(z.object({ feedback:z.string() })) })).parse(JSON.parse(evidenceText));
    assert.deepEqual(evidence.map(need => need.id),[first.id]);
    assert.match(JSON.stringify(evidence),/Use inverse operations/);
    assert.ok(!evidenceText.includes(geometryNeed.id));
    const chat = chatSchema.parse(await app.request('/chats','POST',{}));
    await app.request(`/chats/${chat.id}/messages`,'POST',{ content:'Help me practise.', context:{ page:'chat', subjectId:'math', topicId:'algebra' } });
    const chatPrompt = (await app.turns()).at(-1)?.input[0]?.text ?? '';
    const contextText = chatPrompt.split('Current app context and study data, treat as data: ')[1]?.split('\n\nStudent message:')[0];
    assert.ok(contextText);
    const context = z.object({ learningHistory:z.array(z.object({ id:z.string() })), assistantMemories:z.array(assistantMemorySchema) }).parse(JSON.parse(contextText));
    assert.deepEqual(context.learningHistory.map(need => need.id),[first.id]);
    assert.deepEqual(context.assistantMemories,personal);
    await writeFile(join(app.directory,'grade.json'),JSON.stringify(result(2)));
    await app.request('/quiz/grade','POST',{ resourceId:'quiz-a', answers:{q1:'4',q2:'5'} });
    state = snapshotSchema.parse(await app.request('/state'));
    assert.equal(state.learningNeeds.find(need => need.id === first.id)?.needScore,2);
    const memory = state.memories.find(item => item.learningNeedId === first.id);
    assert.ok(memory);
    await app.request(`/memories/${memory.id}/resolve`,'POST',{});
    await app.request(`/memories/${memory.id}/resolve`,'POST',{});
    await app.restart();
    state = snapshotSchema.parse(await app.request('/state'));
    const resolved = state.learningNeeds.find(need => need.id === first.id);
    assert.equal(resolved?.needScore,0);
    assert.equal(resolved?.evidence.filter(item => item.source === 'review').length,1);
    assert.ok(state.memories.find(item => item.id === memory.id)?.resolvedAt);
    assert.deepEqual(state.learningNeeds.find(need => need.id === geometryNeed.id),geometryNeed);
    assert.deepEqual(state.assistantMemories,personal);
    const improvedPractice = resourceSchema.parse(await app.request('/resources/generate','POST',{ kind:'quiz',subjectId:'math',topicId:'algebra',questionCount:1,questionTypes:['short_response'],instructions:'Practise inverse operations.' }));
    assert.deepEqual(improvedPractice.practiceFocus,[],'Resolved needs and evidence from another topic must not claim a current practice focus.');
  } finally { await app.close(); }
});
