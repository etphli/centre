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
import { eventSchema,snapshotSchema } from '../shared/schema';

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
    assert.notEqual(created.body.id,'remote-1'); assert.match(created.body.id,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.equal(created.body.origin,'centre'); assert.equal(created.body.kind,'session'); assert.equal(created.body.revision,1); assert.equal(created.body.plannedDurationMinutes,45); assert.equal(created.body.startAt,'2026-10-21T05:00:00Z');
    assert.equal(created.body.organatoId,'remote-1'); assert.equal(created.body.organatoVersion,1); assert.equal(created.body.time,'16:00'); assert.equal(created.body.notes,input.notes);
    assert.equal(records.get('remote-1')?.dueAt,'2026-10-21T05:00:00Z'); assert.equal(records.get('remote-1')?.calendarNote,input.notes); assert.equal(records.get('remote-1')?.estimatedMinutes,45);
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

function deferredSignal() {
  let resolve = () => {};
  const promise = new Promise<void>(done => { resolve = done; });
  return {promise,resolve};
}

function responseBarrier() {
  const entered = deferredSignal();
  const released = deferredSignal();
  return {
    async waitUntilEntered() {
      let timer:ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([entered.promise,new Promise<never>((_,reject) => {
          timer = setTimeout(() => reject(new Error('Fixture write did not reach its response barrier.')),5000);
        })]);
      } finally { clearTimeout(timer); }
    },
    async hold() { entered.resolve(); await released.promise; },
    release:released.resolve,
  };
}

type ArchiveMode = 'success' | 'unavailable' | 'disconnect' | 'unconfirmed' | 'wrong-id' | 'malformed';

async function withArchiveFixture(run:(fixture:{
  directory:string;
  records:Map<string,Record<string,unknown>>;
  writes:{method:string;path:string;body:unknown}[];
  setMode:(mode:ArchiveMode) => void;
  holdNextWrite:(method:string,path:string) => ReturnType<typeof responseBarrier>;
  request:(path:string,method?:string,body?:unknown) => Promise<{status:number;body:unknown}>;
}) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(),'centre-calendar-archive-'));
  const previousKey = process.env.ORGANATO_API_KEY;
  const previousBinary = process.env.CENTRE_CODEX_BIN;
  process.env.ORGANATO_API_KEY = 'org_local_archive_fixture';
  process.env.CENTRE_CODEX_BIN = '/centre-test/no-codex-binary';
  const records = new Map<string,Record<string,unknown>>();
  const writes:{method:string;path:string;body:unknown}[] = [];
  let mode:ArchiveMode = 'success';
  const barriers = new Map<string,ReturnType<typeof responseBarrier>>();
  const allBarriers:ReturnType<typeof responseBarrier>[] = [];
  const holdNextWrite = (method:string,path:string) => {
    const barrier = responseBarrier();
    barriers.set(`${method} ${path}`,barrier); allBarriers.push(barrier);
    return barrier;
  };
  const holdResponse = async (method:string,path:string) => {
    const key = `${method} ${path}`; const barrier = barriers.get(key);
    barriers.delete(key);
    await barrier?.hold();
  };
  const upstream = createServer((request,response) => { void (async () => {
    response.setHeader('Content-Type','application/json');
    const path = new URL(request.url ?? '/','http://localhost').pathname;
    if (request.method === 'GET') {
      response.end(JSON.stringify(path.endsWith('/subjects') ? {subjects:[]} : {items:[...records.values()],nextCursor:null}));
      return;
    }
    const chunks:Buffer[] = [];
    for await (const chunk of request) if (Buffer.isBuffer(chunk)) chunks.push(chunk);
    const body:unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null');
    writes.push({method:request.method ?? '',path,body});
    if (request.method === 'POST' && path === '/api/v1/items') {
      const input = createItemSchema.parse(body);
      const id = `remote-${records.size+1}`;
      const record = {id,...input,subjectId:input.subjectId ?? null,dueAt:input.dueAt ?? null,dueDateLocal:input.dueDateLocal ?? null,version:1,workingStatus:'not_started',completedAt:null,archivedAt:null};
      records.set(id,record);
      response.writeHead(201).end(JSON.stringify({item:record}));
      return;
    }
    if (request.method === 'PATCH') {
      const input = updateItemSchema.parse(body);
      const id = decodeURIComponent(path.split('/').at(-1) ?? '');
      const current = records.get(id); assert.ok(current);
      if (input.version !== current.version) { response.writeHead(409).end(JSON.stringify({error:'Stale version.'})); return; }
      const updated = {...current,...input,version:input.version+1};
      records.set(id,updated);
      await holdResponse('PATCH',path);
      response.end(JSON.stringify({item:updated}));
      return;
    }
    const archive = /^\/api\/v1\/items\/([^/]+)\/archive$/.exec(path);
    if (request.method !== 'POST' || !archive) {
      response.writeHead(405).end(JSON.stringify({error:'Fixture only allows POST /items and POST /items/:id/archive.'}));
      return;
    }
    const current = records.get(decodeURIComponent(archive[1] ?? ''));
    assert.ok(current);
    if (mode === 'unavailable') { response.writeHead(503).end(JSON.stringify({error:'Archive unavailable.'})); return; }
    if (mode === 'malformed') { response.end('{'); return; }
    if (typeof body !== 'object' || body === null || !('version' in body) || body.version !== current.version) {
      response.writeHead(409).end(JSON.stringify({error:'Stale version.'})); return;
    }
    assert.ok(typeof current.version === 'number');
    const archived = {...current,version:current.version+1,archivedAt:'2026-10-21T06:00:00Z'};
    if (mode === 'disconnect') { records.set(String(current.id),archived); request.socket.destroy(); return; }
    if (mode === 'unconfirmed') { response.end(JSON.stringify({item:{...archived,archivedAt:null}})); return; }
    if (mode === 'wrong-id') { response.end(JSON.stringify({item:{...archived,id:'different-todo'}})); return; }
    await holdResponse('POST',path);
    records.set(String(current.id),archived);
    response.end(JSON.stringify({item:archived}));
  })().catch(error => { response.writeHead(500).end(JSON.stringify({error:error instanceof Error ? error.message : 'Fixture failed.'})); }); });
  let service:Awaited<ReturnType<typeof createService>> | undefined;
  try {
    await new Promise<void>(resolve => upstream.listen(0,'127.0.0.1',resolve));
    const address = upstream.address(); assert.ok(address && typeof address !== 'string');
    const store = await Store.open(directory);
    store.state.settings.organatoBaseUrl = `http://127.0.0.1:${address.port}/api/v1`;
    await store.save();
    const running = await createService({dataDir:directory}); service = running;
    const request = async (path:string,method = 'GET',body?:unknown) => {
      const response = await fetch(`http://127.0.0.1:${running.port}${path}`,{method,headers:{Authorization:`Bearer ${running.token}`,...(body === undefined ? {} : {'Content-Type':'application/json'})},...(body === undefined ? {} : {body:JSON.stringify(body)})});
      const result:unknown = await response.json();
      return {status:response.status,body:result};
    };
    await run({directory,records,writes,holdNextWrite,setMode:value => { mode = value; },request});
  } finally {
    for (const barrier of allBarriers) barrier.release();
    await service?.close();
    upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
    if (previousKey === undefined) delete process.env.ORGANATO_API_KEY; else process.env.ORGANATO_API_KEY = previousKey;
    if (previousBinary === undefined) delete process.env.CENTRE_CODEX_BIN; else process.env.CENTRE_CODEX_BIN = previousBinary;
    await rm(directory,{recursive:true,force:true});
  }
}

const archiveSessionInput = {title:'Archive this session',date:'2026-10-21',time:'16:00'};

test('editing notes or duration preserves a precise existing instant in a repeated DST hour',async () => withArchiveFixture(async ({request,records}) => {
  const created = eventSchema.parse((await request('/api/events','POST',archiveSessionInput)).body);
  assert.ok(created.organatoId);
  const remote = records.get(created.organatoId); assert.ok(remote);
  const startAt = '2026-04-04T15:30:12.123Z';
  records.set(created.organatoId,{...remote,dueAt:startAt,dueDateLocal:null,version:2});
  assert.equal((await request('/api/organato/sync','POST',{})).status,200);
  const synced = snapshotSchema.parse((await request('/api/state')).body).events.find(event => event.id === created.id); assert.ok(synced);
  assert.equal(synced.time,'02:30:12.123'); assert.equal(synced.startAt,startAt);
  const updated = await request(`/api/events/${created.id}`,'PATCH',{notes:'Keep the original precise start',plannedDurationMinutes:60,expectedRevision:synced.revision});
  assert.equal(updated.status,200);
  assert.equal(eventSchema.parse(updated.body).startAt,startAt);
  assert.equal(records.get(created.organatoId)?.dueAt,startAt);
}));

test('calendar archive uses revision checks and keeps tombstones only after confirmed remote success',async t => {
  await t.test('archives exactly the linked todo with POST and persists a tombstone through stale sync',async () => withArchiveFixture(async fixture => {
    const {request,records,writes,directory} = fixture;
    const created = await request('/api/events','POST',archiveSessionInput); assert.equal(created.status,200);
    const event = eventSchema.parse(created.body); assert.notEqual(event.id,event.organatoId);
    const unrelated = await request('/api/events','POST',{...archiveSessionInput,title:'Keep this session'}); assert.equal(unrelated.status,200);
    const otherEvent = eventSchema.parse(unrelated.body);
    assert.ok(event.organatoId);
    const activeRemote = records.get(event.organatoId); assert.ok(activeRemote);
    records.set('unrelated-work',{...activeRemote,id:'unrelated-work',kind:'work',displayName:'Keep this assignment',calendarEnabled:false});
    assert.equal((await request('/api/organato/sync','POST',{})).status,200);
    const before = snapshotSchema.parse((await request('/api/state')).body);
    assert.equal(before.assignments.length,3);
    const searchBefore = await request('/api/search?q=Archive%20this%20session');
    assert.equal(searchBefore.status,200);
    assert.ok(Array.isArray(searchBefore.body) && searchBefore.body.some(value => value.id === `event:${event.id}`));
    const writeCount = writes.length;
    const archived = await request(`/api/events/${event.id}/archive`,'POST',{expectedRevision:event.revision});
    assert.equal(archived.status,200);
    const searchAfter = await request('/api/search?q=Archive%20this%20session');
    assert.equal(searchAfter.status,200);
    assert.deepEqual(searchAfter.body,[],'Archived sessions and their stale Organato projections must leave search immediately');
    assert.deepEqual(writes.slice(writeCount),[{method:'POST',path:`/api/v1/items/${event.organatoId}/archive`,body:{version:event.organatoVersion}}]);
    const persisted = await Store.open(directory);
    const tombstone = persisted.state.events.find(value => value.id === event.id); assert.ok(tombstone);
    assert.equal(tombstone.deletedAt,'2026-10-21T06:00:00Z');
    assert.equal(tombstone.revision,event.revision+1); assert.equal(tombstone.organatoVersion,2);
    assert.deepEqual(persisted.state.assignments,before.assignments.filter(value => value.id !== event.organatoId));
    assert.deepEqual(persisted.state.events.find(value => value.id === otherEvent.id),before.events.find(value => value.id === otherEvent.id));
    records.set(event.organatoId,activeRemote);
    assert.equal((await request('/api/organato/sync','POST',{})).status,200);
    const synced = snapshotSchema.parse((await request('/api/state')).body);
    assert.deepEqual(synced.events.filter(value => value.id === event.id),[tombstone]);
    assert.equal(synced.events.some(value => value.organatoId === event.organatoId && !value.deletedAt),false);
    assert.deepEqual(synced.assignments,before.assignments.filter(value => value.id !== event.organatoId));
    assert.deepEqual((await Store.open(directory)).state.events.find(value => value.id === event.id),tombstone);
    const afterArchive = writes.length;
    assert.equal((await request(`/api/events/${event.id}/archive`,'POST',{expectedRevision:tombstone.revision})).status,409);
    assert.equal((await request(`/api/events/${event.id}`,'PATCH',{title:'Resurrect',expectedRevision:tombstone.revision})).status,409);
    assert.equal(writes.length,afterArchive);
    assert.equal(writes.some(write => write.method === 'DELETE'),false);
  }));

  await t.test('stale local revisions after sync make no remote write',async () => withArchiveFixture(async ({request,records,writes,directory}) => {
    const created = await request('/api/events','POST',archiveSessionInput); assert.equal(created.status,200);
    const event = eventSchema.parse(created.body); assert.ok(event.organatoId);
    const remote = records.get(event.organatoId); assert.ok(remote);
    remote.version = 7; remote.displayName = 'Changed remotely';
    assert.equal((await request('/api/organato/sync','POST',{})).status,200);
    const before = (await Store.open(directory)).state;
    const synced = before.events.find(value => value.id === event.id); assert.ok(synced);
    assert.equal(synced.revision,event.revision+1); assert.equal(synced.organatoVersion,7);
    const writeCount = writes.length;
    assert.equal((await request(`/api/events/${event.id}/archive`,'POST',{expectedRevision:event.revision})).status,409);
    assert.equal(writes.length,writeCount);
    const after = (await Store.open(directory)).state;
    assert.deepEqual(after.events,before.events); assert.deepEqual(after.assignments,before.assignments);
  }));

  await t.test('archive requires a positive expectedRevision before any upstream write',async () => withArchiveFixture(async ({request,writes,directory}) => {
    const created = await request('/api/events','POST',archiveSessionInput); assert.equal(created.status,200);
    const event = eventSchema.parse(created.body);
    const before = (await Store.open(directory)).state;
    const writeCount = writes.length;
    for (const body of [{},{expectedRevision:0},{expectedRevision:'1'}]) {
      assert.equal((await request(`/api/events/${event.id}/archive`,'POST',body)).status,400);
    }
    assert.equal(writes.length,writeCount);
    assert.deepEqual((await Store.open(directory)).state.events,before.events);
  }));

  await t.test('stale upstream version returns 409 and leaves the session active',async () => withArchiveFixture(async ({request,records,writes,directory}) => {
    const created = await request('/api/events','POST',archiveSessionInput); assert.equal(created.status,200);
    const event = eventSchema.parse(created.body); assert.ok(event.organatoId);
    const remote = records.get(event.organatoId); assert.ok(remote); remote.version = 9;
    const before = (await Store.open(directory)).state; const writeCount = writes.length;
    const result = await request(`/api/events/${event.id}/archive`,'POST',{expectedRevision:event.revision});
    assert.equal(result.status,409);
    assert.deepEqual(writes.slice(writeCount),[{method:'POST',path:`/api/v1/items/${event.organatoId}/archive`,body:{version:1}}]);
    const after = (await Store.open(directory)).state;
    assert.deepEqual(after.events,before.events); assert.deepEqual(after.assignments,before.assignments);
    assert.equal(remote.archivedAt,null);
  }));

  const failures:{mode:ArchiveMode;status:number}[] = [{mode:'unavailable',status:503},{mode:'disconnect',status:502},{mode:'unconfirmed',status:502},{mode:'wrong-id',status:502},{mode:'malformed',status:502}];
  for (const {mode,status} of failures) await t.test(`${mode} archive response leaves persisted and visible state active`,async () => withArchiveFixture(async ({request,records,writes,setMode,directory}) => {
    const created = await request('/api/events','POST',archiveSessionInput); assert.equal(created.status,200);
    const event = eventSchema.parse(created.body);
    const before = snapshotSchema.parse((await request('/api/state')).body);
    const writeCount = writes.length; setMode(mode);
    assert.equal((await request(`/api/events/${event.id}/archive`,'POST',{expectedRevision:event.revision})).status,status);
    assert.deepEqual(writes.slice(writeCount),[{method:'POST',path:`/api/v1/items/${event.organatoId}/archive`,body:{version:event.organatoVersion}}]);
    const after = snapshotSchema.parse((await request('/api/state')).body);
    assert.deepEqual(after.events,before.events); assert.deepEqual(after.assignments,before.assignments);
    if (mode === 'disconnect') assert.equal(records.get(String(event.organatoId))?.archivedAt,'2026-10-21T06:00:00Z');
    const persisted = await Store.open(directory);
    assert.deepEqual(persisted.state.events,before.events); assert.deepEqual(persisted.state.assignments,before.assignments);
  }));

  await t.test('imported timed todos and Centre all-day deadlines cannot be archived',async () => withArchiveFixture(async ({request,records,writes,directory}) => {
    const created = await request('/api/events','POST',{title:'Centre deadline',date:'2026-10-21'}); assert.equal(created.status,200);
    const deadline = eventSchema.parse(created.body); assert.equal(deadline.kind,'deadline');
    const remote = records.get(String(deadline.organatoId)); assert.ok(remote);
    records.set('imported-todo',{...remote,id:'imported-todo',dueAt:'2026-10-21T05:00:00Z',dueDateLocal:null});
    assert.equal((await request('/api/organato/sync','POST',{})).status,200);
    const before = (await Store.open(directory)).state;
    const imported = before.events.find(value => value.organatoId === 'imported-todo'); assert.ok(imported); assert.equal(imported.origin,'organato');
    const writeCount = writes.length;
    for (const event of [deadline,imported]) assert.equal((await request(`/api/events/${event.id}/archive`,'POST',{expectedRevision:event.revision})).status,400);
    assert.equal(writes.length,writeCount);
    const after = (await Store.open(directory)).state;
    assert.deepEqual(after.events,before.events); assert.deepEqual(after.assignments,before.assignments);
  }));
});

test('calendar write responses preserve concurrent sync and archive results',async t => {
  for (const syncRemovesEvent of [false,true]) await t.test(`archive persists a tombstone when in-flight sync ${syncRemovesEvent ? 'removes' : 'replaces'} the event`,async () => withArchiveFixture(async ({request,records,holdNextWrite,directory}) => {
    const created = await request('/api/events','POST',archiveSessionInput); assert.equal(created.status,200);
    const event = eventSchema.parse(created.body); assert.ok(event.organatoId);
    const remote = records.get(event.organatoId); assert.ok(remote);
    const staleActive = {...remote};
    const other = await request('/api/events','POST',{...archiveSessionInput,title:'Unrelated session'}); assert.equal(other.status,200);
    records.set('unrelated-work',{...remote,id:'unrelated-work',kind:'work',displayName:'Unrelated assignment',calendarEnabled:false});
    assert.equal((await request('/api/organato/sync','POST',{})).status,200);
    const before = (await Store.open(directory)).state;
    const barrier = holdNextWrite('POST',`/api/v1/items/${event.organatoId}/archive`);
    const pendingArchive = request(`/api/events/${event.id}/archive`,'POST',{expectedRevision:event.revision});
    try {
      await barrier.waitUntilEntered();
      if (syncRemovesEvent) records.delete(event.organatoId);
      else records.set(event.organatoId,{...remote,displayName:'Active projection replaced during archive'});
      assert.equal((await request('/api/organato/sync','POST',{})).status,200);
      const during = (await Store.open(directory)).state.events.find(value => value.id === event.id);
      if (syncRemovesEvent) { assert.ok(during); assert.equal(during.deletedAt,null); assert.match((await Store.open(directory)).state.syncError ?? '',/local plan is kept/); }
      else { assert.ok(during); assert.equal(during.title,'Active projection replaced during archive'); assert.equal(during.deletedAt,null); }
    } finally { barrier.release(); }
    assert.equal((await pendingArchive).status,200);
    const after = (await Store.open(directory)).state;
    const tombstone = after.events.find(value => value.id === event.id); assert.ok(tombstone);
    assert.equal(tombstone.deletedAt,'2026-10-21T06:00:00Z'); assert.equal(tombstone.organatoVersion,2); assert.equal(tombstone.revision,event.revision+1);
    assert.deepEqual(after.events.filter(value => value.id !== event.id),before.events.filter(value => value.id !== event.id));
    assert.deepEqual(after.assignments,before.assignments.filter(value => value.id !== event.organatoId));
    records.set(event.organatoId,staleActive);
    assert.equal((await request('/api/organato/sync','POST',{})).status,200);
    const synced = (await Store.open(directory)).state;
    assert.deepEqual(new Map(synced.events.map(value => [value.id,value])),new Map(after.events.map(value => [value.id,value])));
    assert.deepEqual(synced.assignments,after.assignments);
    const visible = snapshotSchema.parse((await request('/api/state')).body);
    assert.deepEqual(new Map(visible.events.map(value => [value.id,value])),new Map(after.events.map(value => [value.id,value])));
  }));

  for (const archiveAfterEdit of [true,false]) await t.test(`delayed edit response preserves ${archiveAfterEdit ? 'a concurrent archive tombstone' : 'a newer synced remote version'}`,async () => withArchiveFixture(async ({request,records,holdNextWrite,directory}) => {
    const created = await request('/api/events','POST',archiveSessionInput); assert.equal(created.status,200);
    const event = eventSchema.parse(created.body); assert.ok(event.organatoId);
    const remote = records.get(event.organatoId); assert.ok(remote);
    const staleActive = {...remote};
    const other = await request('/api/events','POST',{...archiveSessionInput,title:'Unrelated session'}); assert.equal(other.status,200);
    records.set('unrelated-work',{...remote,id:'unrelated-work',kind:'work',displayName:'Unrelated assignment',calendarEnabled:false});
    assert.equal((await request('/api/organato/sync','POST',{})).status,200);
    const before = (await Store.open(directory)).state;
    const barrier = holdNextWrite('PATCH',`/api/v1/items/${event.organatoId}`);
    const pendingEdit = request(`/api/events/${event.id}`,'PATCH',{title:'Delayed edit',expectedRevision:event.revision});
    let expected:Awaited<ReturnType<typeof Store.open>>['state'] | undefined;
    try {
      await barrier.waitUntilEntered();
      const editedRemote = records.get(event.organatoId); assert.ok(editedRemote); assert.equal(editedRemote.version,2);
      if (!archiveAfterEdit) records.set(event.organatoId,{...editedRemote,version:3,displayName:'Newer remote edit wins'});
      assert.equal((await request('/api/organato/sync','POST',{})).status,200);
      const syncedEvent = (await Store.open(directory)).state.events.find(value => value.id === event.id); assert.ok(syncedEvent);
      assert.equal(syncedEvent.organatoVersion,archiveAfterEdit ? 2 : 3);
      if (archiveAfterEdit) assert.equal((await request(`/api/events/${event.id}/archive`,'POST',{expectedRevision:syncedEvent.revision})).status,200);
      expected = (await Store.open(directory)).state;
    } finally { barrier.release(); }
    const editResult = await pendingEdit; assert.equal(editResult.status,200); assert.ok(expected);
    const current = expected.events.find(value => value.id === event.id); assert.ok(current);
    assert.equal(current.organatoVersion,3);
    assert.equal(current.deletedAt,archiveAfterEdit ? '2026-10-21T06:00:00Z' : null);
    if (!archiveAfterEdit) assert.equal(current.title,'Newer remote edit wins');
    assert.deepEqual(eventSchema.parse(editResult.body),current);
    const after = (await Store.open(directory)).state;
    assert.deepEqual(after.events,expected.events); assert.deepEqual(after.assignments,expected.assignments);
    assert.deepEqual(after.events.filter(value => value.id !== event.id),before.events.filter(value => value.id !== event.id));
    assert.deepEqual(after.assignments.filter(value => value.id !== event.organatoId),before.assignments.filter(value => value.id !== event.organatoId));
    if (archiveAfterEdit) {
      records.set(event.organatoId,staleActive);
      assert.equal((await request('/api/organato/sync','POST',{})).status,200);
      const staleSynced = (await Store.open(directory)).state;
      assert.deepEqual(staleSynced.events,after.events); assert.deepEqual(staleSynced.assignments,after.assignments);
    }
  }));
});
