import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store, writeStateFile, type StateWriter } from './store';
import { Credentials } from './credentials';
import { Codex } from './codex';
import { Resources } from './resources';
import { createService } from './index';
import { snapshotSchema, preferencesSchema } from '../shared/schema';

function gate() {
  let release = () => {};
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
async function fixture(t: TestContext, writer: StateWriter = writeStateFile) {
  t.mock.method(Credentials.prototype,'get',async () => '');
  t.mock.method(Credentials.prototype,'set',async () => { throw new Error('Test must not write credentials'); });
  t.mock.method(Codex.prototype,'ready',async () => {});
  t.mock.method(Codex.prototype,'close',async () => {});
  const directory = await mkdtemp(join(tmpdir(),'centre-settings-backend-'));
  const open = Store.open;
  let serviceStore: Store | undefined;
  t.mock.method(Store,'open',async (dir: string) => { serviceStore = await open.call(Store,dir,writer); return serviceStore; });
  const service = await createService({dataDir:directory});
  t.after(async () => { await service.close(); await rm(directory,{recursive:true,force:true}); });
  const request = async (path: string, body?: unknown, method = body === undefined ? 'GET' : 'PATCH') => {
    const r = await fetch(`http://127.0.0.1:${service.port}/api/${path}`,{method,headers:{Authorization:`Bearer ${service.token}`,'Content-Type':'application/json'},...(body === undefined ? {} : {body:JSON.stringify(body)})});
    return {status:r.status,body:await r.json()};
  };
  return {request,disk:async () => (await open.call(Store,directory)).state,store:() => { assert.ok(serviceStore); return serviceStore; }};
}

test('settings serialize delayed validation, retain supplied keys and recover after rejected validation',async t => {
  const f = await fixture(t);
  assert.equal((await f.request('settings',{nickname:'Saved',textSize:'large',defaultQuizQuestions:19})).status,200);
  const entered = gate(), resume = gate();
  t.mock.method(Codex.prototype,'validateSelection',async () => { entered.release(); await resume.promise; });
  const first = f.request('settings',{chatModel:'fixture-model'});
  await entered.promise;
  const second = f.request('settings',{textSize:'small'});
  resume.release();
  assert.equal((await first).status,200);
  assert.equal((await second).status,200);
  let state = await f.disk();
  assert.equal(state.settings.textSize,'small');
  assert.equal(state.settings.nickname,'Saved');
  assert.equal(state.settings.defaultQuizQuestions,19);
  t.mock.method(Codex.prototype,'validateSelection',async () => { throw new Error('Rejected selection'); });
  assert.equal((await f.request('settings',{chatModel:'rejected',nickname:'Rejected'})).status,500);
  assert.equal((await f.request('settings',{density:'comfortable'})).status,200);
  state = await f.disk();
  assert.equal(state.settings.chatModel,'fixture-model');
  assert.equal(state.settings.nickname,'Saved');
  assert.equal((await f.request('settings',{futureSetting:true})).status,400);
});

test('failed settings disk write leaves memory and future saves unchanged',async t => {
  let fail = false;
  const f = await fixture(t,async (directory,content) => {
    if (fail) { fail = false; throw new Error('Injected disk writer failure'); }
    await writeStateFile(directory,content);
  });
  await f.request('settings',{nickname:'Saved'});
  fail = true;
  assert.equal((await f.request('settings',{nickname:'Rejected',textSize:'large'})).status,500);
  const memory = snapshotSchema.parse((await f.request('state')).body);
  assert.equal(memory.settings.nickname,'Saved');
  assert.equal(memory.settings.textSize,'standard');
  assert.equal((await f.disk()).settings.nickname,'Saved');
  assert.equal((await f.request('settings',{density:'comfortable'})).status,200);
  assert.equal((await f.disk()).settings.nickname,'Saved');
});

test('flashcard service defaults honor fixed and auto modes, explicit overrides and preference reset',async t => {
  const f = await fixture(t);
  const captured: unknown[] = [];
  t.mock.method(Resources.prototype,'generate',async (input: unknown) => { captured.push(input); return {captured:true}; });
  await f.request('settings',{defaultFlashcardCountMode:'fixed',defaultFlashcardCount:13,googleClientId:'fixture.invalid'});
  const generate = (extra = {}) => f.request('resources/generate',{kind:'flashcards',subjectId:null,topicId:null,...extra},'POST');
  assert.equal((await generate()).status,200);
  assert.equal((await generate({questionCount:17})).status,200);
  assert.equal((await generate({questionCount:'auto'})).status,200);
  await f.request('settings',{defaultFlashcardCountMode:'auto'});
  assert.equal((await generate()).status,200);
  assert.deepEqual(captured.map(value => objectCount(value)),[13,17,'auto','auto']);
  await f.request('settings',preferencesSchema.parse({}));
  assert.equal((await f.disk()).settings.googleClientId,'fixture.invalid');
  assert.equal((await f.disk()).settings.defaultFlashcardCount,8);
});
function objectCount(value: unknown) {
  assert.ok(value && typeof value === 'object' && 'questionCount' in value);
  return value.questionCount;
}


test('settings atomic commit re-prepares against concurrent legacy state changes',async t => {
  let duringWrite = () => {};
  const f = await fixture(t,async (directory,content) => {
    await writeStateFile(directory,content);
    duringWrite();
  });
  await f.request('settings',{nickname:'Saved'});
  duringWrite = () => {
    duringWrite = () => {};
    f.store().state.settings.readingFont = 'serif';
    f.store().state.settings.account = {name:'Synthetic',email:'fixture@example.invalid'};
  };
  assert.equal((await f.request('settings',{textSize:'large'})).status,200);
  const disk = await f.disk();
  assert.equal(disk.settings.readingFont,'serif');
  assert.equal(disk.settings.textSize,'large');
  assert.deepEqual(disk.settings.account,{name:'Synthetic',email:'fixture@example.invalid'});
  assert.deepEqual(f.store().state.settings,disk.settings);
});

test('synthetic credentials expose partial external writes without rolling back newer state',async t => {
  let fail = false;
  const f = await fixture(t,async (directory,content) => {
    if (fail) { fail = false; throw new Error('Injected disk failure after credential write'); }
    await writeStateFile(directory,content);
  });
  const credentials = new Map<string,string>();
  t.mock.method(Credentials.prototype,'set',async (key: string, value: string) => {
    if (key === 'googleClientSecret') throw new Error('Synthetic second credential failure');
    credentials.set(key,value);
  });
  await f.request('settings',{nickname:'Saved'});
  assert.equal((await f.request('settings',{organatoApiKey:'synthetic-one',googleClientSecret:'synthetic-two',nickname:'Rejected'})).status,500);
  assert.equal(credentials.get('organatoApiKey'),'synthetic-one');
  assert.equal(f.store().state.settings.nickname,'Saved');
  fail = true;
  assert.equal((await f.request('settings',{organatoApiKey:'synthetic-three',nickname:'Rejected'})).status,500);
  assert.equal(credentials.get('organatoApiKey'),'synthetic-three');
  assert.equal((await f.disk()).settings.nickname,'Saved');
  assert.equal((await f.request('settings',{density:'comfortable'})).status,200);
  assert.equal((await f.disk()).settings.nickname,'Saved');
});
