import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store';
import { createService } from './index';
import { createItemSchema,updateItemSchema } from './organato';
import { organatoDeadline } from './calendar';

test('Sydney calendar conversion handles DST, all-day dates and invalid wall-clock times',() => {
  assert.equal(organatoDeadline('2026-10-21','16:00','Australia/Sydney').dueAt,'2026-10-21T05:00:00Z');
  assert.equal(organatoDeadline('2026-07-21','16:00','Australia/Sydney').dueAt,'2026-07-21T06:00:00Z');
  assert.deepEqual(organatoDeadline('2026-10-21',null,'Australia/Sydney'),{dueAt:null,dueDateLocal:'2026-10-21',dueHasExplicitTime:false});
  for (const date of ['2026-10-04','2026-04-05']) assert.throws(() => organatoDeadline(date,'02:30','Australia/Sydney'),/ambiguous or does not exist/);
});

test('calendar API writes Organato todos first, preserves links and versions, and never falls back to local success',async () => {
  const directory = await mkdtemp(join(tmpdir(),'centre-calendar-api-'));
  const previousKey = process.env.ORGANATO_API_KEY; const previousBinary = process.env.CENTRE_CODEX_BIN;
  delete process.env.ORGANATO_API_KEY; process.env.CENTRE_CODEX_BIN = '/centre-test/no-codex-binary';
  const records = new Map<string,Record<string,unknown>>(); let attempts = 0; let failWrites = false; let disconnectWrites = false;
  const upstream = createServer((request,response) => { void (async () => {
    response.setHeader('Content-Type','application/json'); const path = new URL(request.url ?? '/','http://localhost').pathname;
    if (request.method === 'GET') {
      if (path.endsWith('/subjects')) response.end(JSON.stringify({subjects:[{id:'math',displayName:'Year10Maths',shortName:'Maths',colour:'#fff',active:true}]}));
      else response.end(JSON.stringify({items:[...records.values()],nextCursor:null})); return;
    }
    attempts++;
    if (disconnectWrites) { request.socket.destroy(); return; }
    if (request.headers.authorization === 'Bearer org_read_only') { response.writeHead(403).end(JSON.stringify({error:'This key is read only.'})); return; }
    if (failWrites) { response.writeHead(503).end(JSON.stringify({error:'Write uncertain; inspect Organato before retrying.'})); return; }
    const chunks: Buffer[] = []; for await (const chunk of request) if (Buffer.isBuffer(chunk)) chunks.push(chunk);
    const raw: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (request.method === 'POST') {
      const input = createItemSchema.parse(raw); assert.equal(input.kind,'todo'); assert.equal(input.calendarEnabled,true);
      const id = `remote-${records.size+1}`;
      const record = {id,...input,subjectId:input.subjectId ?? null,dueAt:input.dueAt ?? null,dueDateLocal:input.dueDateLocal ?? null,version:1,workingStatus:'not_started',completedAt:null};
      records.set(id,record); response.writeHead(201).end(JSON.stringify({item:record})); return;
    }
    const input = updateItemSchema.parse(raw); const id = path.split('/').at(-1) ?? ''; const current = records.get(id); assert.ok(current);
    if (input.version !== current.version) { response.writeHead(409).end(JSON.stringify({error:'Stale version.'})); return; }
    const record = {...current,...input,version:input.version+1,completedAt:input.workingStatus === 'completed' ? '2026-10-21T05:05:00Z' : input.workingStatus === 'not_started' ? null : current.completedAt};
    records.set(id,record); response.end(JSON.stringify({item:record,nextOccurrence:null}));
  })().catch(error => { response.writeHead(500).end(JSON.stringify({error:error instanceof Error ? error.message : 'Fixture failed.'})); }); });
  await new Promise<void>(resolve => upstream.listen(0,'127.0.0.1',resolve)); const address = upstream.address(); assert.ok(address && typeof address !== 'string');
  const store = await Store.open(directory); store.state.settings.organatoBaseUrl = `http://127.0.0.1:${address.port}/api/v1`;
  store.state.subjects.push({id:'math',name:'Year10Maths',shortName:'Maths',color:'#fff',icon:'book'}); await store.save();
  const service = await createService({dataDir:directory});
  const request = async (path: string,method = 'GET',body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${service.port}${path}`,{method,headers:{Authorization:`Bearer ${service.token}`,...(body === undefined ? {} : {'Content-Type':'application/json'})},...(body === undefined ? {} : {body:JSON.stringify(body)})});
    return {status:response.status,body:await response.json()};
  };
  const input = {title:'Revise algebra',date:'2026-10-21',time:'16:00',subjectId:'math',notes:'Practice equations.'};
  try {
    assert.equal((await request('/api/events','POST',input)).status,400); assert.equal(attempts,0);
    process.env.ORGANATO_API_KEY = 'org_read_only';
    assert.equal((await request('/api/events','POST',input)).status,403); assert.equal((await request('/api/state')).body.events.length,0);
    process.env.ORGANATO_API_KEY = 'org_write_fixture';
    const created = await request('/api/events','POST',input); assert.equal(created.status,200);
    assert.equal(created.body.organatoId,'remote-1'); assert.equal(created.body.organatoVersion,1); assert.equal(created.body.time,'16:00'); assert.equal(created.body.notes,input.notes);
    assert.equal(records.get('remote-1')?.dueAt,'2026-10-21T05:00:00Z'); assert.equal(records.get('remote-1')?.calendarNote,input.notes);
    const moved = await request(`/api/events/${created.body.id}`,'PATCH',{title:'New session',date:'2026-07-21',time:'16:00',notes:'Updated.'});
    assert.equal(moved.status,200); assert.equal(moved.body.organatoVersion,2); assert.equal(records.get('remote-1')?.dueAt,'2026-07-21T06:00:00Z');
    const completed = await request(`/api/events/${created.body.id}`,'PATCH',{completedAt:'2026-10-21T05:04:00Z'});
    assert.equal(completed.status,200); assert.equal(completed.body.completedAt,'2026-10-21T05:05:00Z'); assert.equal(completed.body.notes,'Updated.'); assert.equal(records.get('remote-1')?.workingStatus,'completed');
    const undone = await request(`/api/events/${created.body.id}`,'PATCH',{completedAt:null}); assert.equal(undone.status,200); assert.equal(undone.body.completedAt,null);
    const allDay = await request('/api/events','POST',{title:'All-day revision',date:'2026-10-22'}); assert.equal(allDay.status,200);
    assert.equal(records.get('remote-2')?.dueDateLocal,'2026-10-22'); assert.equal(records.get('remote-2')?.dueAt,null);
    const before = attempts; const remote = records.get('remote-1'); assert.ok(remote); remote.version = 99;
    const stale = await request(`/api/events/${created.body.id}`,'PATCH',{title:'Conflicting edit'}); assert.equal(stale.status,409); assert.equal(attempts,before+1);
    assert.equal((await request('/api/state')).body.events[0].title,'New session');
    failWrites = true; const beforeFailure = attempts;
    const failed = await request('/api/events','POST',input); assert.equal(failed.status,503); assert.match(failed.body.error,/inspect Organato/); assert.equal(attempts,beforeFailure+1);
    assert.equal((await request('/api/state')).body.events.length,2);
    const badTime = await request('/api/events','POST',{...input,date:'2026-10-04',time:'02:30'}); assert.equal(badTime.status,400); assert.equal(attempts,beforeFailure+1);
    failWrites = false; remote.displayName = 'Changed in Organato';
    assert.equal((await request('/api/organato/sync','POST',{})).status,200);
    assert.equal((await request('/api/state')).body.events[0].title,'Changed in Organato');
    const persisted = await Store.open(directory); assert.equal(persisted.state.events[0]?.organatoVersion,99);
    disconnectWrites = true; const beforeDisconnect = attempts;
    const uncertain = await request('/api/events','POST',input); assert.equal(uncertain.status,502); assert.match(uncertain.body.error,/Inspect Organato before retrying/); assert.equal(attempts,beforeDisconnect+1);
    assert.equal((await request('/api/state')).body.events.length,2);
  } finally {
    await service.close(); upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve()));
    if (previousKey === undefined) delete process.env.ORGANATO_API_KEY; else process.env.ORGANATO_API_KEY = previousKey;
    if (previousBinary === undefined) delete process.env.CENTRE_CODEX_BIN; else process.env.CENTRE_CODEX_BIN = previousBinary;
    await rm(directory,{recursive:true,force:true});
  }
});
