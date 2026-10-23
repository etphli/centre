import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { handleGradeRequest, type GradeContext, type GradeRecord, type GradeMutation, type GradeStatement } from '../cloud-ai/grade';

// Local SQLite proves persistence, uniqueness, and CAS. Fixture inference is not hosted provider proof.
function fixture(written = false) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../cloud-ai/migrations/0002_grades.sql', import.meta.url),'utf8'));
  sqlite.exec('CREATE TABLE entities(workspace TEXT,kind TEXT,id TEXT,version INTEGER,data TEXT,PRIMARY KEY(workspace,kind,id))');
  const db = { prepare(sql:string):GradeStatement {
    let params: (string | number | null)[] = [];
    return {bind(...values:unknown[]) { params = values.map(v => { if (typeof v === 'string' || typeof v === 'number' || v === null) return v; throw new Error('SQL parameter'); }); return this; },
      async first<T>() { return sqlite.prepare(sql).get(...params) as T || null; },
      async run() { return sqlite.prepare(sql).run(...params); }};
  }};
  const draftId = crypto.randomUUID();
  const now = '2026-10-22T00:00:00.000Z';
  let providerCalls = 0;
  let commitCalls = 0;
  let failCommit: 'none'|'unknown'|'conflict' = 'none';
  let providerFails = false;
  const get = async (kind:string,id:string):Promise<GradeRecord|null> => {
    const row = sqlite.prepare('SELECT * FROM entities WHERE workspace=? AND kind=? AND id=?').get(context.auth.workspaceId,kind,id);
    return row ? {kind,id,version:Number(row.version),deleted:false,data:JSON.parse(String(row.data))} : null;
  };
  const put = (kind:string,id:string,data:unknown,version=1) => sqlite.prepare('INSERT OR REPLACE INTO entities VALUES(?,?,?,?,?)').run('workspace-a',kind,id,version,JSON.stringify(data));
  const context:GradeContext = {env:{DB:db,AI:{async run() { providerCalls++; if (providerFails) throw new Error('connection interrupted'); return {response:JSON.stringify({score:0,total:1,feedback:[{questionId:'q1',concept:'Fractions',score:0,maxScore:1,feedback:'Try again',needsReview:true}]})}; }}},auth:{workspaceId:'workspace-a',deviceId:'device'},entities:{ get,
    async getPracticeAttempt(draft) {
      const row = sqlite.prepare("SELECT id FROM entities WHERE workspace=? AND kind='practice.attempt' AND json_extract(data,'$.sourceDraftId')=?").get(context.auth.workspaceId,draft);
      return row ? get('practice.attempt',String(row.id)) : null;
    },
    async listLearningNeeds() {
      const rows = sqlite.prepare("SELECT id FROM entities WHERE workspace=? AND kind='practice.learningNeed'").all(context.auth.workspaceId);
      const records = await Promise.all(rows.map(row => get('practice.learningNeed',String(row.id))));
      return records.filter((r):r is GradeRecord => r !== null);
    },
    async commit(mutations:GradeMutation[]) {
      commitCalls++;
      if (failCommit === 'unknown') throw new Error('write transport failed');
      sqlite.exec('BEGIN');
      try {
        for (const mutation of mutations) {
          const current = await get(mutation.kind,mutation.id);
          if ((current?.version || 0) !== mutation.expectedVersion || failCommit === 'conflict' && mutation.kind === 'practice.draft') throw {status:409,code:'conflict'};
          if (mutation.kind === 'practice.attempt') {
            const data = mutation.data as {sourceDraftId:string};
            if (await context.entities.getPracticeAttempt(data.sourceDraftId)) throw {status:409};
          }
          sqlite.prepare('INSERT OR REPLACE INTO entities VALUES(?,?,?,?,?)').run(context.auth.workspaceId,mutation.kind,mutation.id,mutation.expectedVersion+1,JSON.stringify(mutation.data));
        }
        sqlite.exec('COMMIT');
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    }}};
  const resource = {id:'quiz',subjectId:null,topicId:null,title:'Fractions',kind:'quiz',createdAt:now,updatedAt:now,content:'',questions:[{id:'q1',responseType:written ? 'short_response':'multiple_choice',choices:written ? []:['A','B'],prompt:'Choose A',answer:'A',marks:1}]};
  const draft = {schemaVersion:1,id:draftId,revision:1,resourceId:'quiz',answers:{q1:'B'},currentQuestion:0,createdAt:now,updatedAt:now,deletedAt:null};
  put('resource','quiz',resource); put('practice.draft',draftId,draft);
  const input = {id:crypto.randomUUID(),resourceId:'quiz',draftId,expectedDraftRevision:1};
  const post = (body:unknown = input) => handleGradeRequest(new Request('https://centre.test/v1/ai/grades',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}),context).then(r => {assert.ok(r);return r;});
  const read = () => handleGradeRequest(new Request(`https://centre.test/v1/ai/grades/${input.id}`),context).then(r => {assert.ok(r);return r;});
  return {sqlite,context,input,post,read,put,resource,draft,get,stats:()=>({providerCalls,commitCalls}),failWrite:(mode:typeof failCommit)=>{failCommit=mode;},failProvider:()=>{providerFails=true;}};
}

test('objective grading is durable and exactly once for the draft, without AI',async()=>{
  const f=fixture(); delete f.context.env.AI;
  assert.equal((await f.post()).status,200);
  const first=await (await f.read()).json();
  assert.equal(first.attempt.result.score,0);
  assert.equal((await f.post({...f.input,id:crypto.randomUUID()})).status,200);
  assert.equal(f.stats().providerCalls,0); assert.equal(f.stats().commitCalls,1);
  const needs=await f.context.entities.listLearningNeeds(); assert.equal(needs.length,1);
  assert.equal((needs[0].data as {evidence:unknown[]}).evidence.length,1);
  assert.ok((await f.get('practice.draft',f.input.draftId))?.data);
});

test('concurrent source draft submissions generate one attempt and one evidence record',async()=>{
  const f=fixture(true);
  const responses=await Promise.all([f.post(),f.post({...f.input,id:crypto.randomUUID()})]);
  assert.ok(responses.some(r=>r.status===200));
  assert.equal(f.stats().providerCalls,1);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM entities WHERE kind='practice.attempt'").get()?.n,1);
  const needs=await f.context.entities.listLearningNeeds(); assert.equal((needs[0].data as {evidence:unknown[]}).evidence.length,1);
});

test('atomic CAS conflict rolls back attempt, tombstone, and learning evidence',async()=>{
  const f=fixture(true); f.failWrite('conflict');
  assert.equal((await f.post()).status,409);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM entities WHERE kind IN ('practice.attempt','practice.learningNeed')").get()?.n,0);
  assert.equal((await f.get('practice.draft',f.input.draftId))?.version,1);
  assert.equal((await f.read()).status,409); assert.equal(f.stats().providerCalls,1);
});

test('unknown provider failure is terminal even across retry IDs',async()=>{
  const f=fixture(true);f.failProvider();
  assert.equal((await f.post()).status,422); assert.equal((await f.post()).status,422);
  assert.equal((await f.post({...f.input,id:crypto.randomUUID()})).status,422);
  assert.equal(f.stats().providerCalls,1);
});

test('prepared grade replays its exact stable mutations after unknown entity write outcome',async()=>{
  const f=fixture(true);f.failWrite('unknown'); assert.equal((await f.post()).status,503);
  const before=f.sqlite.prepare('SELECT grade_json,mutations_json FROM centre_ai_grade_runs').get(); assert.ok(before?.mutations_json);
  f.failWrite('none'); assert.equal((await f.read()).status,200);
  const after=f.sqlite.prepare('SELECT grade_json,mutations_json FROM centre_ai_grade_runs').get(); assert.deepEqual(after,before);
  assert.equal(f.stats().providerCalls,1);
});

test('a committed preparation with a lost acknowledgement recovers without repeating inference',async t=>{
  const f=fixture(true); t.after(()=>f.sqlite.close());
  const db=f.context.env.DB; assert.ok(db);
  const prepare=db.prepare.bind(db);
  let interrupted=false;
  db.prepare=sql=>{
    const statement=prepare(sql);
    if (!sql.includes("SET status='prepared'")) return statement;
    const run=statement.run.bind(statement);
    statement.run=async()=>{
      const result=await run();
      if (!interrupted) { interrupted=true; throw new Error('Fixture lost preparation acknowledgement after commit'); }
      return result;
    };
    return statement;
  };
  assert.equal((await f.post()).status,200);
  const prepared=f.sqlite.prepare('SELECT status,grade_json,mutations_json FROM centre_ai_grade_runs').get();
  assert.equal(prepared?.status,'completed');
  assert.ok(prepared?.grade_json); assert.ok(prepared?.mutations_json);
  assert.equal((await f.read()).status,200);
  assert.equal((await f.post({...f.input,id:crypto.randomUUID()})).status,200);
  assert.deepEqual(f.stats(),{providerCalls:1,commitCalls:1});
});

test('strict input, workspace isolation, stale revisions, wrong resources and unknown answers fail before inference',async()=>{
  const f=fixture(true);
  assert.equal((await f.post({...f.input,model:'client-model'})).status,400);
  assert.equal((await f.post({...f.input,expectedDraftRevision:2})).status,409);
  assert.equal((await f.post({...f.input,resourceId:'missing'})).status,404);
  f.context.auth.workspaceId='workspace-b'; assert.equal((await f.post()).status,404); assert.equal((await f.read()).status,404);
  f.context.auth.workspaceId='workspace-a';f.put('practice.draft',f.input.draftId,{...f.draft,answers:{unknown:'answer'}});
  assert.equal((await f.post()).status,400);assert.equal(f.stats().providerCalls,0);
});

test('question and text bounds and missing bindings fail honestly',async()=>{
  const f=fixture(true);
  delete f.context.env.AI; assert.equal((await f.post()).status,503);
  f.put('resource','quiz',{...f.resource,questions:Array.from({length:31},(_,i)=>({...f.resource.questions[0],id:`q${i}`}))});
  assert.equal((await f.post()).status,400);
  f.put('resource','quiz',{...f.resource,questions:[{...f.resource.questions[0],prompt:'x'.repeat(20000)}]});
  assert.equal((await f.post()).status,413);
  delete f.context.env.DB;assert.equal((await f.post()).status,503);
});

test('durable quota denies admission without calling inference',async()=>{
  const f=fixture(true);const day=new Date().toISOString().slice(0,10);
  for(let i=0;i<10;i++)f.sqlite.prepare('INSERT INTO centre_ai_grade_admissions VALUES(?,?,?,?,0,?)').run('workspace-a',crypto.randomUUID(),'grade',day,'2999-01-01T00:00:00.000Z');
  assert.equal((await f.post()).status,429);assert.equal(f.stats().providerCalls,0);
});


test('correct objective answers receive full marks without creating weak spots',async()=>{
  const f=fixture();f.put('practice.draft',f.input.draftId,{...f.draft,answers:{q1:'A'}});
  const response=await f.post();assert.equal(response.status,200);
  const result=await response.json();assert.equal(result.attempt.result.score,1);assert.equal(result.attempt.result.total,1);
  assert.equal((await f.context.entities.listLearningNeeds()).length,0);assert.equal(f.stats().providerCalls,0);
});

test('same request ID cannot change input and prior results do not leak across workspaces',async()=>{
  const f=fixture();assert.equal((await f.post()).status,200);
  assert.equal((await f.post({...f.input,expectedDraftRevision:2})).status,409);
  f.context.auth.workspaceId='workspace-b';assert.equal((await f.read()).status,404);
});

test('expired processing lease returns a stable interruption and releases admission without inference',async()=>{
  const f=fixture(true);
  const old='2000-01-01T00:00:00.000Z';
  f.sqlite.prepare("INSERT INTO centre_ai_grade_runs(workspace_id,id,source_draft_id,request_json,status,created_at,lease_expires_at) VALUES(?,?,?,?,'processing',?,?)").run('workspace-a',f.input.id,f.input.draftId,JSON.stringify(f.input),old,old);
  f.sqlite.prepare('INSERT INTO centre_ai_grade_admissions VALUES(?,?,?,?,1,?)').run('workspace-a',f.input.id,'grade',old.slice(0,10),old);
  const response=await f.read();assert.equal(response.status,422);const body=await response.json();
  assert.deepEqual(body.run,{id:f.input.id,status:'interrupted',model:'@cf/meta/llama-3.1-8b-instruct-fp8',provider:'cloudflare-workers-ai',errorCode:'grade_interrupted'});
  const retry=await (await f.post()).json();assert.deepEqual(retry.run,body.run);
  const differentId=await (await f.post({...f.input,id:crypto.randomUUID()})).json();assert.deepEqual(differentId.run,body.run);
  assert.equal(f.sqlite.prepare('SELECT active FROM centre_ai_grade_admissions WHERE id=?').get(f.input.id)?.active,0);
  assert.equal(f.stats().providerCalls,0);
});

test('provider deadline is terminal and late provider completion cannot save an attempt',async(t)=>{
  const f=fixture(true);
  let started=false;
  let finish:(value:unknown)=>void=()=>{};
  f.context.env.AI={run(){started=true;return new Promise(resolve=>{finish=resolve;});}};
  t.mock.timers.enable({apis:['setTimeout']});
  const pending=f.post();
  while(!started)await new Promise(resolve=>setImmediate(resolve));
  t.mock.timers.tick(45_000);
  const response=await pending;assert.equal(response.status,422);
  const body=await response.json();assert.equal(body.run.status,'interrupted');assert.equal(body.run.id,f.input.id);
  finish({response:'{}'});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.stats().commitCalls,0);
  const retry=await(await f.read()).json();assert.deepEqual(retry.run,body.run);
});

test('expired admissions do not block fresh grade requests',async()=>{
  const f=fixture();
  for(let i=0;i<8;i++)f.sqlite.prepare('INSERT INTO centre_ai_grade_admissions VALUES(?,?,?,?,1,?)').run('workspace-a',crypto.randomUUID(),'grade','2000-01-01','2000-01-01T00:00:00.000Z');
  assert.equal((await f.post()).status,200);
});

test('JSON content type and valid UTF-8 are required before admission',async()=>{
  const f=fixture();
  const wrong=await handleGradeRequest(new Request('https://centre.test/v1/ai/grades',{method:'POST',body:JSON.stringify(f.input)}),f.context);assert.equal(wrong?.status,415);
  const invalid=await handleGradeRequest(new Request('https://centre.test/v1/ai/grades',{method:'POST',headers:{'content-type':'application/json'},body:new Uint8Array([0xff])}),f.context);assert.equal(invalid?.status,400);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM centre_ai_grade_admissions').get()?.n,0);
});


test('saved objective question concepts create separate scoped needs without AI or duplicate retry evidence',async()=>{
  const f=fixture();delete f.context.env.AI;
  const questions=[{...f.resource.questions[0],concept:' Fractions '},{...f.resource.questions[0],id:'q2',concept:'Decimals'}];
  f.put('resource','quiz',{...f.resource,subjectId:'math',topicId:'numbers',questions,practiceFocus:[' Fractions ','Decimals']});
  f.put('practice.draft',f.input.draftId,{...f.draft,answers:{q1:'B',q2:'B'}});
  const response=await f.post();assert.equal(response.status,200);
  const body=await response.json();assert.deepEqual(body.attempt.result.feedback.map((item:{concept:string})=>item.concept),['Fractions','Decimals']);
  const before=await f.context.entities.listLearningNeeds();assert.equal(before.length,2);
  const needs=before.map(record=>record.data as {conceptLabel:string;subjectId:string;topicId:string;evidence:unknown[]});
  assert.deepEqual(needs.map(need=>need.conceptLabel).sort(),['Decimals','Fractions']);
  for(const need of needs){assert.equal(need.subjectId,'math');assert.equal(need.topicId,'numbers');assert.equal(need.evidence.length,1);}
  assert.equal((await f.post()).status,200);assert.deepEqual(await f.context.entities.listLearningNeeds(),before);
  assert.equal(f.stats().providerCalls,0);assert.equal(f.stats().commitCalls,1);
});

test('written feedback without a concept uses the saved canonical question concept',async()=>{
  const f=fixture(true);f.put('resource','quiz',{...f.resource,questions:[{...f.resource.questions[0],concept:'Cell respiration'}]});
  f.context.env.AI={async run(){return {response:JSON.stringify({score:0,total:1,feedback:[{questionId:'q1',score:0,maxScore:1,feedback:'Explain ATP production.',needsReview:true}]})};}};
  const response=await f.post();assert.equal(response.status,200);const body=await response.json();
  assert.equal(body.attempt.result.feedback[0].concept,'Cell respiration');
  const needs=await f.context.entities.listLearningNeeds();assert.equal(needs.length,1);
  assert.equal((needs[0].data as {conceptLabel:string}).conceptLabel,'Cell respiration');
  assert.equal((await f.post()).status,200);assert.deepEqual(await f.context.entities.listLearningNeeds(),needs);
});

test('a full retained history including transport tombstones still grades and evolves existing concepts',async()=>{
  const f=fixture();delete f.context.env.AI;
  for(let i=0;i<499;i++) {
    const id=crypto.randomUUID();
    f.put('practice.learningNeed',id,{schemaVersion:1,id,revision:1,subjectId:null,topicId:null,conceptKey:i===0?'fractions':`retained-${i}`,conceptLabel:i===0?'Fractions':`Retained ${i}`,needScore:2,evidence:[],createdAt:f.draft.createdAt,updatedAt:f.draft.updatedAt,deletedAt:null});
  }
  const list=f.context.entities.listLearningNeeds;
  f.context.entities.listLearningNeeds=async()=>[...await list(),{kind:'practice.learningNeed',id:crypto.randomUUID(),version:2,deleted:true,data:null}];
  f.put('resource','quiz',{...f.resource,questions:[{...f.resource.questions[0],concept:'Fractions'},{...f.resource.questions[0],id:'q2',concept:'Decimals'}]});
  f.put('practice.draft',f.input.draftId,{...f.draft,answers:{q1:'B',q2:'B'}});
  const response=await f.post();assert.equal(response.status,200);
  const body=await response.json();assert.equal(body.attempt.result.feedback.length,2);
  const retained=await list();assert.equal(retained.length,499);
  const fractions=retained.find(record=>(record.data as {conceptKey:string}).conceptKey==='fractions');
  assert.ok(fractions);assert.equal((fractions.data as {revision:number}).revision,2);
  assert.equal((fractions.data as {evidence:unknown[]}).evidence.length,1);
  assert.equal(retained.some(record=>(record.data as {conceptKey:string}).conceptKey==='decimals'),false);
  assert.equal((await f.post({...f.input,id:crypto.randomUUID()})).status,200);
  assert.deepEqual(await list(),retained);assert.equal(f.stats().commitCalls,1);
});
