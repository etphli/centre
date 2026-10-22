import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createService, saveResourceInput } from './index';
import { Store } from './store';
import { generatedResourceSchema, paperTemplate, Resources } from './resources';
import { Codex } from './codex';
import { resourceSchema, snapshotSchema, type Resource } from '../shared/schema';

const originalBinary = process.env.CENTRE_CODEX_BIN;
process.env.CENTRE_CODEX_BIN = '/centre-test/no-codex-binary';
const seedResource: Resource = resourceSchema.parse({ id:'quiz-one',subjectId:'math',topicId:'algebra',title:'Algebra practice',kind:'quiz',createdAt:'2026-10-20T00:00:00.000Z',updatedAt:'2026-10-20T00:00:00.000Z',content:'',questions:[{ id:'q-one',responseType:'short_response',choices:[],prompt:'Solve 2x = 8',answer:'4',explanation:'Divide by 2.',marks:2 }],questionTypes:['multiple_choice','short_response','long_response'],testLength:null,durationMinutes:null,completedAt:null });
async function fixture(extraResources: Resource[] = []) {
  const directory = await mkdtemp(join(tmpdir(),'centre-api-test-'));
  const store = await Store.open(directory); store.state.subjects.push({ id:'math',name:'Mathematics',shortName:'Maths',color:'#c44',icon:'book' }); store.state.topics.push({ id:'algebra',subjectId:'math',name:'Algebra',description:'' }); store.state.resources.push(structuredClone(seedResource),...extraResources); await store.save();
  const service = await createService({ dataDir:directory });
  const request = async (path: string, method = 'GET', body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${service.port}${path}`,{ method,headers:{ Authorization:`Bearer ${service.token}`,...(body === undefined ? {} : { 'Content-Type':'application/json' }) },...(body === undefined ? {} : { body:JSON.stringify(body) }) });
    return { status:response.status, body:await response.json() };
  };
  return { directory,store,service,request,cleanup:async () => { await service.close(); await rm(directory,{ recursive:true,force:true }); } };
}

test('conditional state polling skips unchanged data and returns fresh data after a write',async () => {
  const f = await fixture();
  try {
    const deadline = Date.now() + 5000;
    while ((await f.request('/api/state')).body.codex.message === 'Connecting to Codex CLI…') {
      assert.ok(Date.now() < deadline,'The missing Codex binary should finish its connection attempt');
      await new Promise(resolve => setTimeout(resolve,10));
    }
    const url = `http://127.0.0.1:${f.service.port}/api/state/poll`;
    const headers = { Authorization:`Bearer ${f.service.token}` };
    const initial = await fetch(url,{ headers });
    assert.equal(initial.status,200);
    snapshotSchema.parse(await initial.json());
    const etag = initial.headers.get('etag');
    assert.ok(etag);
    const unchanged = await fetch(url,{ headers:{ ...headers,'If-None-Match':etag } });
    assert.equal(unchanged.status,304);
    assert.equal(await unchanged.text(),'');
    assert.equal((await fetch(url,{ headers:{ 'If-None-Match':etag } })).status,401);
    await f.request('/api/chats','POST',{ title:'A new chat' });
    const changed = await fetch(url,{ headers:{ ...headers,'If-None-Match':etag } });
    assert.equal(changed.status,200);
    assert.notEqual(changed.headers.get('etag'),etag);
    assert.equal(snapshotSchema.parse(await changed.json()).chats[0]?.title,'A new chat');
    const full = await fetch(url.replace('/poll',''),{ headers:{ ...headers,'If-None-Match':changed.headers.get('etag') ?? '' } });
    assert.equal(full.status,200);
    assert.equal(snapshotSchema.parse(await full.json()).chats.length,1);
  } finally { await f.cleanup(); }
});

test('a failed state save cannot leave a conversation permanently busy',async () => {
  const f = await fixture();
  try {
    const chat = (await f.request('/api/chats','POST',{})).body;
    const temporary = join(f.directory,'state.json.tmp');
    await mkdir(temporary);
    const send = () => f.request(`/api/chats/${chat.id}/messages`,'POST',{content:'Hello',context:{page:'chat'}});
    assert.equal((await send()).status,500);
    await rm(temporary,{recursive:true});
    const retry = await send();
    assert.notEqual(retry.body.error,'This conversation already has a response in progress.');
    assert.equal((await f.request('/api/state')).body.chats[0].messages.length,2);
  } finally { await f.cleanup(); }
});

test('API enforces tokens, validates relationships and persists resources and study memory',async () => {
  const f = await fixture();
  try {
    assert.equal((await fetch(`http://127.0.0.1:${f.service.port}/api/state`)).status,401);
    const initial = await f.request('/api/state'); snapshotSchema.parse(initial.body); assert.equal(initial.body.chats.length,0);
    assert.equal((await f.request('/api/topics','POST',{ subjectId:'missing',name:'Topic' })).status,404);
    const topic = await f.request('/api/topics','POST',{ subjectId:'math',name:'Functions' }); assert.equal(topic.status,200);
    const again = await f.request('/api/topics','POST',{ subjectId:'math',name:'functions' }); assert.equal(again.body.id,topic.body.id);
    assert.equal((await f.request('/api/events','POST',{ title:'Study',date:'2026-02-30' })).status,400);
    assert.equal((await f.request('/api/resources/quiz-one/feedback','POST',{ notes:'I forgot how to isolate x.',questionIds:['foreign'] })).status,400);
    assert.equal((await f.request('/api/state')).body.memories.length,0);
    assert.equal((await f.request('/api/resources/quiz-one/feedback','POST',{ notes:'I forgot how to isolate x.',questionIds:['q-one'] })).status,200);
    const state = (await f.request('/api/state')).body; assert.equal(state.memories.length,1); assert.equal(state.memories[0].question,'Solve 2x = 8'); assert.ok(state.resources[0].completedAt);
    await f.request(`/api/memories/${state.memories[0].id}/resolve`,'POST',{});
    const exported = await f.request('/api/resources/quiz-one/export'); assert.equal(exported.body.mimeType,'application/json'); assert.equal(JSON.parse(exported.body.content).questions[0].answer,'4');
    await f.request('/api/resources/quiz-one/feedback','POST',{ notes:'',questionIds:[],confident:true });
    assert.equal((await f.request('/api/state')).body.memories.length,1);
    assert.equal((await f.request('/api/resources/quiz-one/feedback','POST',{ notes:'',questionIds:[] })).status,400);
    const disk = JSON.parse(await readFile(join(f.directory,'state.json'),'utf8')); assert.equal(disk.events.length,0); assert.ok(disk.memories[0].resolvedAt); assert.equal((await stat(join(f.directory,'state.json'))).mode & 0o777,0o600);
    const reopened = await Store.open(f.directory); assert.equal(reopened.state.topics.length,2); assert.equal(reopened.state.memories.length,1);
    assert.equal((await f.request('/api/settings','PATCH',{ chatModel:'' })).status,400);
    assert.equal((await f.request('/api/settings','PATCH',{ organatoBaseUrl:'http://remote.example/api/v1' })).status,400);
    assert.equal((await f.request('/api/auth/google/start','POST',{})).status,400);
    await f.request('/api/settings','PATCH',{ googleClientId:'fixture.apps.googleusercontent.com' });
    const login = await f.request('/api/auth/google/start','POST',{}); assert.equal(login.status,200);
    const authorization = new URL(login.body.url); assert.equal(authorization.hostname,'accounts.google.com'); assert.equal(authorization.searchParams.get('code_challenge_method'),'S256'); assert.ok(authorization.searchParams.get('code_challenge'));
    const callback = new URL(authorization.searchParams.get('redirect_uri') ?? ''); callback.searchParams.set('state','wrong'); callback.searchParams.set('code','fake');
    assert.equal((await fetch(callback)).status,400); assert.equal((await f.request('/api/state')).body.settings.account,null);
    assert.equal((await f.request('/api/auth/google/logout','POST',{})).status,200);
  } finally { await f.cleanup(); }
});

test('resource relocation validates relationships and moves associated review notes',async () => {
  const f = await fixture();
  try {
    const topic = await f.request('/api/topics','POST',{subjectId:'math',name:'Pythagoras'});
    await f.request('/api/resources/quiz-one/feedback','POST',{notes:'Review this.',questionIds:['q-one']});
    assert.equal((await f.request('/api/resources/quiz-one/location','PATCH',{subjectId:'missing',topicId:topic.body.id})).status,404);
    assert.equal((await f.request('/api/resources/quiz-one/location','PATCH',{subjectId:'math',topicId:'missing'})).status,404);
    const moved = await f.request('/api/resources/quiz-one/location','PATCH',{subjectId:'math',topicId:topic.body.id});
    assert.equal(moved.status,200);assert.equal(moved.body.topicId,topic.body.id);
    const state = (await f.request('/api/state')).body;assert.equal(state.memories[0].topicId,topic.body.id);
    const reopened = await Store.open(f.directory);assert.equal(reopened.state.resources[0]?.topicId,topic.body.id);
  } finally { await f.cleanup(); }
});

test('AI failure is honest and retains the student message for retry',async () => {
  const f = await fixture();
  try {
    const chat = await f.request('/api/chats','POST',{});
    const response = await f.request(`/api/chats/${chat.body.id}/messages`,'POST',{ content:'Help me factor x squared.',context:{ page:'chat',subjectId:'math' } });
    assert.equal(response.status,500); assert.match(response.body.error,/Codex CLI|Codex is not|Codex/);
    const persisted = (await f.request('/api/state')).body.chats[0]; assert.equal(persisted.messages.length,1); assert.equal(persisted.messages[0].role,'user');
  } finally { await f.cleanup(); }
});

test('profile preferences validate, persist and survive unrelated settings patches',async () => {
  const f = await fixture();
  try {
    const initial = (await f.request('/api/state')).body.settings;
    assert.equal(initial.studentYearLevel,9); assert.equal(initial.timeZone,'Australia/Sydney'); assert.equal(initial.defaultTestLengthMode,'time'); assert.equal(initial.defaultTestQuestions,10);
    const preferences = { nickname:'Ethan',theme:'midnight',density:'comfortable',textSize:'large',studentYearLevel:9,timeZone:'Australia/Sydney',responseStyle:'concise',defaultQuizQuestions:6,defaultTestLengthMode:'questions',defaultTestMinutes:35,defaultTestQuestions:12,defaultQuizQuestionTypes:['multiple_choice','short_response'] as const,defaultTestQuestionTypes:['short_response','long_response'] as const,defaultDifficulty:'challenging' };
    const saved = await f.request('/api/settings','PATCH',preferences); assert.equal(saved.status,200);
    for (const [key,value] of Object.entries(preferences)) Array.isArray(value) ? assert.deepEqual(saved.body[key],value) : assert.equal(saved.body[key],value);
    await f.request('/api/settings','PATCH',{ googleClientId:'fixture.apps.googleusercontent.com' });
    const settings = (await f.request('/api/state')).body.settings;
    for (const [key,value] of Object.entries(preferences)) Array.isArray(value) ? assert.deepEqual(settings[key],value) : assert.equal(settings[key],value);
    const disk = await Store.open(f.directory); assert.equal(disk.state.settings.nickname,'Ethan'); assert.equal(disk.state.settings.defaultTestMinutes,35);
    assert.equal((await f.request('/api/settings','PATCH',{ studentYearLevel:13 })).status,400);
    assert.equal((await f.request('/api/settings','PATCH',{ defaultQuizQuestions:31 })).status,400);
    assert.equal((await f.request('/api/settings','PATCH',{ defaultTestMinutes:181 })).status,400);
    assert.equal((await f.request('/api/settings','PATCH',{ defaultTestQuestions:31 })).status,400);
    assert.equal((await f.request('/api/settings','PATCH',{ defaultTestLengthMode:'count' })).status,400);
    assert.equal((await f.request('/api/settings','PATCH',{ defaultQuizQuestionTypes:[] })).status,400);
    assert.equal((await f.request('/api/settings','PATCH',{ responseStyle:'unbounded' })).status,400);
    assert.equal((await f.request('/api/settings','PATCH',{ timeZone:'not-a-timezone' })).status,400);
    assert.equal((await f.request('/api/settings','PATCH',{ greetingMode:'custom' })).status,400);
    assert.equal((await f.request('/api/state')).body.settings.nickname,'Ethan');
  } finally { await f.cleanup(); }
});

test('archived chats disappear from snapshots, remain on disk and can be restored after a restart',async () => {
  const f = await fixture(); let restarted: Awaited<ReturnType<typeof createService>> | undefined;
  try {
    const chat = await f.request('/api/chats','POST',{ title:'Keep my history' });
    assert.equal(chat.body.deletedAt,null);
    await f.request(`/api/chats/${chat.body.id}/messages`,'POST',{ content:'Preserve this study question.',context:{ page:'chat' } });
    assert.equal((await f.request(`/api/chats/${chat.body.id}/archive`,'POST',{})).status,200);
    assert.equal((await f.request('/api/state')).body.chats.length,0);
    const disk = await Store.open(f.directory); assert.equal(disk.state.chats[0]?.id,chat.body.id); assert.ok(disk.state.chats[0]?.deletedAt); assert.equal(disk.state.chats[0]?.messages[0]?.content,'Preserve this study question.');
    assert.equal((await f.request(`/api/chats/${chat.body.id}/messages`,'POST',{ content:'Archived',context:{ page:'chat' } })).status,404);
    await f.service.close();
    restarted = await createService({ dataDir:f.directory });
    const request = async (path: string,method = 'GET') => {
      const response = await fetch(`http://127.0.0.1:${restarted?.port}${path}`,{ method,headers:{Authorization:`Bearer ${restarted?.token}`,...(method === 'POST' ? {'Content-Type':'application/json'} : {})},...(method === 'POST' ? {body:'{}'} : {}) });
      assert.equal(response.status,200); return response.json();
    };
    assert.equal((await request('/api/state')).chats.length,0);
    const restored = await request(`/api/chats/${chat.body.id}/restore`,'POST'); assert.equal(restored.id,chat.body.id); assert.equal(restored.deletedAt,null); assert.equal(restored.messages[0]?.content,'Preserve this study question.');
    assert.equal((await request('/api/state')).chats[0].title,'Keep my history');
    assert.equal((await Store.open(f.directory)).state.chats[0]?.deletedAt,null);
  } finally {
    if (restarted) await restarted.close(); else await f.service.close();
    await rm(f.directory,{recursive:true,force:true});
  }
});

test('diagram preview capabilities are artifact-specific, read-only and isolated from bearer authentication',async () => {
  const diagram = { ...seedResource,id:'diagram-one',kind:'diagram',content:'<button onclick="this.textContent=\'Explored\'">Explore</button>',questions:[],durationMinutes:null } satisfies Resource;
  const f = await fixture([diagram,{ ...diagram,id:'diagram-two' }]);
  try {
    const origin = `http://127.0.0.1:${f.service.port}`;
    assert.equal((await fetch(`${origin}/api/resources/diagram-one/preview`)).status,401);
    assert.equal((await f.request('/api/resources/quiz-one/preview')).status,400);
    assert.equal((await f.request('/api/resources/missing/preview')).status,404);
    const preview = await f.request('/api/resources/diagram-one/preview');
    assert.equal(preview.status,200); const url = new URL(preview.body.url);
    assert.equal(url.origin,origin); assert.match(url.searchParams.get('revision') ?? '',/^[a-f0-9]{64}$/); assert.ok(!url.href.includes(f.service.token));
    const response = await fetch(url);
    assert.equal(response.status,200); assert.match(response.headers.get('content-type') ?? '',/^text\/html/);
    const html = await response.text();assert.match(html,/Explored/);assert.match(html,/centre:diagram-size/);assert.match(html,/centre:theme/);assert.match(html,/sandbox="allow-scripts"/);assert.match(html,/frame-src 'none'/);
    const light = new URL(url);light.searchParams.set('theme','light');assert.match(await (await fetch(light)).text(),/--centre-bg:#f9f9f7/);
    const csp = response.headers.get('content-security-policy') ?? '';
    for (const directive of ["default-src 'none'","script-src 'unsafe-inline'","style-src 'unsafe-inline'","img-src data:","connect-src 'none'","base-uri 'none'","form-action 'none'"]) assert.ok(csp.includes(directive));
    assert.equal(response.headers.get('cache-control'),'no-store'); assert.equal(response.headers.get('referrer-policy'),'no-referrer');
    assert.equal((await fetch(url,{ method:'POST' })).status,405);
    assert.equal((await fetch(url.href.replace('/diagram-one/','/diagram-two/'))).status,403);
    const altered = new URL(url); altered.pathname = `${url.pathname.slice(0,-1)}${url.pathname.endsWith('A') ? 'B' : 'A'}`;
    assert.equal((await fetch(altered)).status,403);
    assert.equal((await fetch(`${origin}/api/state`)).status,401);
    assert.equal((await f.request('/api/state')).body.resources.length,3);
  } finally { await f.cleanup(); }
});

test('Organato paginates reads, maps subjects and work, and never retries a rejected write',async () => {
  let writes = 0; const pages: string[] = []; const original = process.env.ORGANATO_API_KEY; process.env.ORGANATO_API_KEY = 'org_fixture_key';
  const upstream = createServer((request,response) => {
    assert.equal(request.headers.authorization,'Bearer org_fixture_key'); response.setHeader('Content-Type','application/json');
    if (request.method === 'POST') { writes++; response.writeHead(500).end(JSON.stringify({ error:'Write failed; inspect before retrying.' })); return; }
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname.endsWith('/subjects')) { response.end(JSON.stringify({ subjects:[{ id:'math',displayName:'Advanced mathematics',shortName:'Maths',colour:'#c67b5c',active:true }] })); return; }
    pages.push(url.searchParams.get('cursor') ?? 'first'); const next = url.searchParams.has('cursor');
    response.end(JSON.stringify({ items:[{ id:next ? 'two':'one',displayName:next ? 'Revise':'Assignment',kind:next ? 'todo':'work',subjectId:'math',dueDateLocal:'2026-10-24',dueAt:null,workingStatus:'not_started',version:1 }],nextCursor:next ? null:'cursor-one' }));
  });
  await new Promise<void>(resolve => upstream.listen(0,'127.0.0.1',resolve)); const address = upstream.address(); assert.ok(address && typeof address !== 'string');
  const f = await fixture();
  try {
    await f.request('/api/settings','PATCH',{ organatoBaseUrl:`http://127.0.0.1:${address.port}/api/v1` });
    const result = await f.request('/api/organato/sync','POST',{}); assert.equal(result.status,200); assert.equal(result.body.assignments.length,2); assert.equal(result.body.subjects[0].name,'Advanced mathematics'); assert.deepEqual(pages,['first','cursor-one']);
    assert.equal(result.body.settings.organatoConnected,true); assert.ok(result.body.lastSyncedAt);
    const rejected = await f.request('/api/organato/items','POST',{ kind:'todo',displayName:'Revise algebra' }); assert.equal(rejected.status,500); assert.equal(writes,1); assert.match(rejected.body.error,/Write failed/);
    assert.ok(!(await readFile(join(f.directory,'state.json'),'utf8')).includes('org_fixture_key'));
  } finally { await f.cleanup(); upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); if (original === undefined) delete process.env.ORGANATO_API_KEY; else process.env.ORGANATO_API_KEY = original; }
});

test('resource boundary creates tests by time or count and accepts only kind-specific inputs',async () => {
  const directory = await mkdtemp(join(tmpdir(),'centre-resource-test-')); const store = await Store.open(directory);
  store.state.subjects.push({ id:'math',name:'Maths & science',shortName:null,color:'#fff',icon:'book' }); store.state.topics.push({ id:'algebra',subjectId:'math',name:'Algebra',description:'' });
  const codex = new Codex(directory,[],async () => undefined); const resources = new Resources(store,codex);
  const input = { kind:'test',subjectId:'math',topicId:'algebra',instructions:'',questionTypes:['multiple_choice','short_response'],testLength:{mode:'time',minutes:25},difficulty:'standard' } satisfies Parameters<Resources['saveGenerated']>[0];
  try {
    const resource = await resources.saveGenerated(input,{ title:'A & B',content:'',questions:[{ responseType:'multiple_choice',choices:['$x=3$.','$x=4$.'],prompt:'Find $x$ if $2x=8$.',answer:'$x=4$.',explanation:'Divide both sides by 2.',marks:2 },{ responseType:'short_response',choices:[],prompt:'Explain the inverse operation.',answer:'Division by 2.',explanation:'Undo multiplication.',marks:1 }] });
    assert.match(resource.content,/\\documentclass\[11pt,a4paper\]/); assert.match(resource.content,/Maths \\& science/); assert.match(resource.content,/A \\& B/); assert.match(resource.content,/Duration: 25 minutes/); assert.match(resource.content,/Part A: Multiple choice/); assert.match(resource.content,/Part B: Short response/); assert.match(resource.content,/label=\\Alph\*\./); assert.match(resource.content,/\\item \$x=3\$\./); assert.match(resource.content,/Answers and marking guidance/); assert.equal(resource.durationMinutes,25); assert.deepEqual(resource.testLength,{mode:'time',minutes:25}); assert.ok(resources.export(resource.id).filename.endsWith('.tex'));
    assert.equal(paperTemplate('A & B','Maths & science',resource.questions,input.testLength,'Algebra'),resource.content);
    assert.match(paperTemplate('Legacy','Maths',resource.questions),/Duration: 45 minutes/);
    for (const prompt of ['\\input{/etc/passwd}','\\^^69nput{../../private.txt}','\\InputIfFileExists{../../private.txt}{}{}','\\write18{bad}','\\begin{document}bad\\end{document}','\\begin{aligned}x=4']) await assert.rejects(resources.saveGenerated(input,{ title:'Unsafe',content:'',questions:[{ responseType:'short_response',choices:[],prompt,answer:'x',marks:1 }] }),/unsupported LaTeX|unclosed LaTeX/);
    await assert.rejects(resources.saveGenerated(input,{ title:'Unselected',content:'',questions:[{ responseType:'long_response',choices:[],prompt:'Explain.',answer:'Because.',marks:1 }] }),/only the selected response types/);
    await assert.rejects(resources.saveGenerated(input,{ title:'Bad choice',content:'',questions:[{ responseType:'multiple_choice',choices:['A','B'],prompt:'Choose.',answer:'C',marks:1 }] }),/exactly match/);
    const questionModeInput = { ...input,testLength:{mode:'questions',questionCount:2} } satisfies Parameters<Resources['saveGenerated']>[0];
    const questionMode = await resources.saveGenerated(questionModeInput,{ title:'Question count test',content:'',questions:[{ responseType:'short_response',choices:[],prompt:'One.',answer:'Answer.',marks:1 },{ responseType:'multiple_choice',choices:['A','B'],prompt:'Choose.',answer:'A',marks:1 }] });
    assert.match(questionMode.content,/Question count: 2/); assert.equal(questionMode.durationMinutes,null); assert.deepEqual(questionMode.testLength,{mode:'questions',questionCount:2});
    await assert.rejects(resources.saveGenerated(questionModeInput,{ title:'Wrong count',content:'',questions:[{ responseType:'short_response',choices:[],prompt:'One.',answer:'Answer.',marks:1 }] }),/Expected 2 questions/);
    const quizInput = { kind:'quiz',subjectId:'math',topicId:'algebra',instructions:'',questionCount:2,questionTypes:['multiple_choice','short_response'],difficulty:'standard' } satisfies Parameters<Resources['saveGenerated']>[0];
    await assert.rejects(resources.saveGenerated(quizInput,{ title:'Wrong count',content:'',questions:[{ responseType:'short_response',choices:[],prompt:'One.',answer:'Answer.',marks:1 }] }),/Expected 2 questions/);
    const quiz = await resources.saveGenerated(quizInput,{ title:'Mixed quiz',content:'',questions:[{ responseType:'multiple_choice',choices:['$2$','$3$'],prompt:'What is $1+1$?',answer:'$2$',marks:1 },{ responseType:'short_response',choices:[],prompt:'Why?',answer:'Addition.',marks:1 }] });
    assert.equal(quiz.durationMinutes,null); assert.equal(quiz.testLength,null); assert.deepEqual(quiz.questionTypes,['multiple_choice','short_response']); assert.equal(quiz.questions[0]?.choices[0],'$2$');
    const diagramInput = { kind:'diagram',subjectId:'math',topicId:'algebra',instructions:'',difficulty:'standard' } satisfies Parameters<Resources['saveGenerated']>[0];
    const toolDiagram = saveResourceInput.parse({ ...diagramInput,generated:{ title:'Tool diagram',content:'<svg></svg>',questions:[] } });
    assert.equal(toolDiagram.kind,'diagram'); assert.equal('questionCount' in toolDiagram,false); assert.equal('questionTypes' in toolDiagram,false); assert.equal('testLength' in toolDiagram,false);
    assert.throws(() => saveResourceInput.parse({ kind:'quiz',subjectId:'math',topicId:'algebra',generated:{ title:'Missing format',content:'',questions:[] } }),/questionCount|questionTypes/);
    const toolSchema = z.record(z.string(),z.unknown()).parse(z.toJSONSchema(saveResourceInput));
    const branches = z.array(z.record(z.string(),z.unknown())).parse(toolSchema['oneOf']);
    const branch = (kind: string) => branches.find(value => {
      const properties = z.record(z.string(),z.unknown()).parse(value['properties']);
      return z.record(z.string(),z.unknown()).parse(properties['kind'])['const'] === kind;
    });
    const diagramBranch = branch('diagram'); assert.ok(diagramBranch);
    const diagramProperties = z.record(z.string(),z.unknown()).parse(diagramBranch['properties']);
    for (const field of ['questionCount','questionTypes','testLength']) assert.equal(field in diagramProperties,false);
    const quizBranch = branch('quiz'); assert.ok(quizBranch); assert.deepEqual(z.array(z.string()).parse(quizBranch['required']).filter(field => ['questionCount','questionTypes'].includes(field)).sort(),['questionCount','questionTypes']);
    const testBranch = branch('test'); assert.ok(testBranch); assert.deepEqual(z.array(z.string()).parse(testBranch['required']).filter(field => ['testLength','questionTypes'].includes(field)).sort(),['questionTypes','testLength']);
    const diagram = await resources.saveGenerated(diagramInput,{ title:'Interactive graph',content:'<button onclick="this.textContent=\'Done\'">Explore</button>',questions:[] }); assert.match(diagram.content,/connect-src 'none'/); assert.match(diagram.content,/onclick/);
    await assert.rejects(resources.saveGenerated({ ...input,topicId:'missing' },{ title:'x',content:'',questions:[] }),/Topic not found/);
  } finally { await codex.close(); await rm(directory,{ recursive:true,force:true }); }
});

test('generated structured output requires response type and multiple-choice options',() => {
  const asRecord = (value: unknown) => z.record(z.string(),z.unknown()).parse(value);
  const root = asRecord(z.toJSONSchema(generatedResourceSchema));
  const rootProperties = asRecord(root['properties']);
  const questions = asRecord(asRecord(rootProperties['questions'])['items']);
  const alternatives = z.array(z.record(z.string(),z.unknown())).parse(questions['oneOf']);
  const multipleChoice = alternatives.find(question => asRecord(asRecord(question['properties'])['responseType'])['const'] === 'multiple_choice');
  assert.ok(multipleChoice);
  const required = z.array(z.string()).parse(multipleChoice['required']);
  const multipleChoiceProperties = asRecord(multipleChoice['properties']);
  const choices = z.object({ type:z.literal('array'), minItems:z.number(), maxItems:z.number() }).parse(multipleChoiceProperties['choices']);
  assert.ok(required.includes('responseType'));
  assert.ok(required.includes('choices'));
  assert.equal(choices.minItems,2);
  assert.equal(choices.maxItems,6);
});

test('legacy resources receive safe assessment defaults when reopened',() => {
  const legacy = resourceSchema.parse({ id:'old',subjectId:'math',topicId:'algebra',title:'Old quiz',kind:'quiz',createdAt:'2026-10-20T00:00:00.000Z',updatedAt:'2026-10-20T00:00:00.000Z',content:'',questions:[{ id:'old-question',prompt:'Solve 1 + 1',answer:'2' }],completedAt:null });
  assert.equal(legacy.questions[0]?.responseType,'short_response');
  assert.deepEqual(legacy.questions[0]?.choices,[]);
  assert.deepEqual(legacy.questionTypes,['multiple_choice','short_response','long_response']);
  assert.equal(legacy.durationMinutes,null);
});

test.after(() => { if (originalBinary === undefined) delete process.env.CENTRE_CODEX_BIN; else process.env.CENTRE_CODEX_BIN = originalBinary; });

test('service lock rejects another active writer and recovers a dead process lock',async () => {
  const f = await fixture();
  try { await assert.rejects(createService({ dataDir:f.directory }),/already running/); } finally { await f.cleanup(); }
  const directory = await mkdtemp(join(tmpdir(),'centre-lock-test-'));
  await writeFile(join(directory,'service.lock'),JSON.stringify({ pid:2147483647,nonce:'dead-process' }));
  const service = await createService({ dataDir:directory });
  await service.close();
  await assert.rejects(readFile(join(directory,'service.lock'),'utf8'),{ code:'ENOENT' });
  await rm(directory,{ recursive:true,force:true });
});

test('a listener startup failure releases its data directory lock',async () => {
  const f = await fixture(); const directory = await mkdtemp(join(tmpdir(),'centre-bind-failure-'));
  try {
    await assert.rejects(createService({ dataDir:directory,port:f.service.port }),{ code:'EADDRINUSE' });
    await assert.rejects(readFile(join(directory,'service.lock'),'utf8'),{ code:'ENOENT' });
    const restarted = await createService({ dataDir:directory }); await restarted.close();
  } finally { await f.cleanup(); await rm(directory,{ recursive:true,force:true }); }
});

test('shutdown retains its writer lock until an in-flight upstream write has settled',async () => {
  const previous = process.env.ORGANATO_API_KEY; process.env.ORGANATO_API_KEY = 'org_shutdown_fixture';
  let finish: (() => void) | undefined;
  let signalStarted: (() => void) | undefined;
  const started = new Promise<void>(resolve => { signalStarted = resolve; });
  const upstream = createServer((_request,response) => {
    signalStarted?.(); finish = () => { if (response.writableEnded) return; response.setHeader('Content-Type','application/json'); response.end(JSON.stringify({ item:{ id:'created',displayName:'Revision',kind:'todo',subjectId:'math',dueDateLocal:null,dueAt:null,workingStatus:'not_started',version:1 } })); };
  });
  await new Promise<void>(resolve => upstream.listen(0,'127.0.0.1',resolve)); const address = upstream.address(); assert.ok(address && typeof address !== 'string');
  const f = await fixture(); let closed = false;
  try {
    await f.request('/api/settings','PATCH',{ organatoBaseUrl:`http://127.0.0.1:${address.port}/api/v1` });
    const writing = f.request('/api/organato/items','POST',{ kind:'todo',displayName:'Revision' }).catch(() => undefined);
    await started;
    const closing = f.service.close();
    await assert.rejects(createService({ dataDir:f.directory }),/already running/);
    finish?.(); await closing; closed = true; await writing;
    assert.equal((await Store.open(f.directory)).state.assignments[0]?.id,'created');
    await assert.rejects(readFile(join(f.directory,'service.lock'),'utf8'),{ code:'ENOENT' });
  } finally {
    finish?.(); if (!closed) await f.service.close();
    upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); await rm(f.directory,{ recursive:true,force:true });
    if (previous === undefined) delete process.env.ORGANATO_API_KEY; else process.env.ORGANATO_API_KEY = previous;
  }
});
