import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { calendarEventSchema, eventSchema, type CalendarEvent } from '../shared/schema';
import { handleOrganatoRequest } from './index';
import { Fixture, object, remoteItem, session, type RemoteItem } from './test-support';

const receiptSchema=z.object({operationId:z.string().uuid(),expectedVersion:z.number().int().nonnegative(),expectedRevision:z.number().int().positive().nullable(),status:z.enum(['succeeded','unknown','conflict','failed','pending']),event:eventSchema.nullable(),record:z.object({kind:z.string(),id:z.string(),version:z.number(),cursor:z.string().regex(/^\d+$/),data:z.unknown()}).nullable(),error:z.object({code:z.string(),message:z.string()}).nullable(),reconciliationRequired:z.boolean()}).strict();
function receipt(body:unknown) { const parsed=receiptSchema.safeParse(body);assert.ok(parsed.success,JSON.stringify(parsed.error?.issues));return parsed.data; }
function eventOf(body:unknown) { const value=receipt(body);assert.ok(value.event);return calendarEventSchema.parse(value.event); }
function command(body:unknown) {const value=receipt(body);assert.ok(value.record);assert.ok(value.event);return {operationId:randomUUID(),expectedVersion:value.record.version,expectedRevision:value.event.revision};}
async function desktop(f:Fixture,overrides:Partial<CalendarEvent>={}) {
  const data=calendarEventSchema.parse({...session(),organatoId:'desktop-match',organatoVersion:7,...overrides});
  await f.context().entities.put({mutationId:randomUUID(),kind:'calendarEvent',id:data.id,schemaVersion:1,expectedVersion:0,deleted:false,data});
  assert.ok(data.organatoId);
  f.items.set(data.organatoId,remoteItem({id:data.organatoId,version:data.organatoVersion ?? 7,displayName:data.title,notesMarkdown:data.notes,estimatedMinutes:data.plannedDurationMinutes,subjectId:data.subjectId,dueAt:data.startAt,workingStatus:data.completedAt?'completed':'not_started',completedAt:data.completedAt}));
  return data;
}

test('cloud Organato contract against actual migration and isolated SQLite',async t => {
  let f:Fixture;
  t.beforeEach(context => {f=new Fixture();context.mock.method(globalThis,'fetch',f.fetch);});
  t.afterEach(() => {f.db.close();});

  await t.test('namespace, authenticated workspace, explicit connection and removal',async () => {
    assert.equal(await handleOrganatoRequest(new Request('https://centre.test/v1/other'),f.context()),null);
    assert.equal((await f.request('/connection')).body.state,'unconfigured');assert.equal(f.calls.length,0);
    assert.equal((await f.request('/snapshot')).status,503);
    const ctx=f.context();ctx.auth.deviceId='';assert.equal((await f.request('/connection','GET',undefined,ctx)).status,401);
    await f.connect();assert.equal((await f.request('/connection')).body.state,'connected');
    assert.equal((await f.request('/connection/remove','POST',{})).body.state,'unconfigured');
    assert.equal((await f.request('/snapshot')).status,503);
  });

  await t.test('versioned AES-GCM storage decrypts with workspace-bound AAD and never leaks secrets',async context => {
    const logs:unknown[][]=[];for (const method of ['log','warn','error','info'] as const) context.mock.method(console,method,(...args:unknown[]) => {logs.push(args);});
    const connected=await f.connect();
    const row=object.parse(f.db.sqlite.prepare('SELECT * FROM centre_organato_connections').get());
    assert.equal(row.key_version,'v1');assert.notEqual(row.ciphertext,f.token);
    const plaintext=await crypto.subtle.decrypt({name:'AES-GCM',iv:Buffer.from(z.string().parse(row.iv),'base64'),additionalData:new TextEncoder().encode(JSON.stringify(['workspace-a',row.connection_id,row.base_url,row.key_version]))},await crypto.subtle.importKey('raw',Buffer.from(f.keys.v1,'base64'),'AES-GCM',false,['decrypt']),Buffer.from(z.string().parse(row.ciphertext),'base64'));
    assert.equal(new TextDecoder().decode(plaintext),f.token);
    await f.connect();const reencrypted=object.parse(f.db.sqlite.prepare('SELECT * FROM centre_organato_connections').get());assert.notEqual(reencrypted.iv,row.iv);assert.notEqual(reencrypted.ciphertext,row.ciphertext);
    const ctx=f.context();ctx.env.ORGANATO_KEY_VERSION='v2';
    assert.equal((await f.request('/snapshot','GET',undefined,ctx)).status,200,'old key version remains usable after current-key rotation');
    await f.connect(ctx);assert.equal((await f.request('/connection')).body.keyVersion,'v2');
    const evidence=JSON.stringify({connected,logs,rows:f.db.sqlite.prepare('SELECT * FROM centre_organato_connections').all(),entities:f.db.sqlite.prepare('SELECT * FROM test_entities').all()});
    for (const secret of [f.token,f.keys.v1,f.keys.v2]) assert.equal(evidence.includes(secret),false);
    f.db.sqlite.prepare("UPDATE centre_organato_connections SET workspace_id='workspace-b'").run();
    assert.equal((await f.request('/snapshot','GET',undefined,f.context('workspace-b'))).status,503,'ciphertext cannot be transplanted across workspaces');
  });

  await t.test('HTTPS origin allowlist rejects client-selected hosts, credentials and redirects',async () => {
    for (const baseUrl of ['http://organato.test/api/v1','https://evil.test/api/v1','https://organato.test.evil.test/api/v1','https://user:pass@organato.test/api/v1','https://organato.test/api/v1?next=x','https://organato.test/elsewhere']) {
      assert.equal((await f.request('/connection','POST',{apiKey:f.token,baseUrl})).status,400);
    }
    assert.equal(f.calls.length,0);
    f.intercept=async request => {assert.equal(request.redirect,'error');throw new TypeError('fetch failed: redirect');};
    assert.equal((await f.request('/connection','POST',{apiKey:f.token,baseUrl:'https://organato.test/api/v1'})).status,502);
    assert.equal(f.calls.length,1);assert.equal((await f.request('/connection')).body.state,'unconfigured');
  });

  await t.test('request and upstream stream byte limits apply without content-length',async () => {
    assert.equal((await f.request('/connection','POST',{apiKey:f.token,baseUrl:'x'.repeat(70*1024)})).status,413);assert.equal(f.calls.length,0);
    await f.connect();
    f.intercept=async () => new Response(new ReadableStream({start(controller) {controller.enqueue(new TextEncoder().encode(' '.repeat(2*1024*1024+1)));controller.close();}}));
    assert.equal((await f.request('/snapshot')).status,502);
  });

  await t.test('snapshot pagination cannot loop or exceed its page budget',async () => {
    await f.connect();let page=0;let repeat=true;
    f.intercept=async request => new URL(request.url).pathname.endsWith('/items') ? Response.json({items:[],nextCursor:repeat?'same':`page-${++page}`}) : null;
    const loop=await f.request('/snapshot');assert.equal(loop.status,502);assert.equal(object.parse(loop.body.error).code,'pagination_loop');
    repeat=false;const budget=await f.request('/snapshot');assert.equal(budget.status,502);assert.equal(object.parse(budget.body.error).code,'pagination_limit');assert.equal(page,25);
  });

  await t.test('workspace connection, operation receipt and canonical entity isolation',async () => {
    await f.connect();const created=await f.create();assert.equal(created.result.status,200);
    const b=f.context('workspace-b');assert.equal((await f.request('/connection','GET',undefined,b)).body.state,'unconfigured');
    assert.equal((await f.request(`/operations/${created.operationId}`,'GET',undefined,b)).status,404);
    assert.equal(await b.entities.get('calendarEvent',created.data.id),null);
    await f.connect(b);const other=await f.create(created.data,created.operationId,b);assert.equal(other.result.status,200);
    assert.equal(f.externalWrites().length,2);assert.notEqual(eventOf(created.result.body).organatoId,eventOf(other.result.body).organatoId);
    await f.request('/connection/remove','POST',{},b);assert.equal((await f.request('/connection')).body.state,'connected');
  });

  await t.test('snapshot preserves imported IDs and versions without writing canonical assignments or imported events',async () => {
    await f.connect();f.items.set('imported-todo',remoteItem());f.items.set('assignment',remoteItem({id:'assignment',kind:'work',version:19,calendarEnabled:false}));
    const result=await f.request('/snapshot');assert.equal(result.status,200);
    const snapshot=z.object({subjects:z.array(object),assignments:z.array(object),events:z.array(eventSchema)}).parse(result.body);
    assert.equal(snapshot.subjects[0]?.id,'math');assert.equal(snapshot.assignments.find(item => item.id === 'assignment')?.version,19);
    const imported=snapshot.events.find(item => item.id === 'imported-todo');assert.ok(imported);assert.equal(imported.origin,'organato');assert.equal(imported.organatoVersion,7);
    assert.equal(f.writes.length,0);assert.equal(f.externalWrites().length,0);
  });

  await t.test('snapshot captured upstream v1 preserves canonical v2 after a concurrent PATCH completes',async () => {
    await f.connect();const created=await f.create({...session(),time:'16:00:37.125',startAt:'2026-10-21T05:00:37.125Z'});assert.equal(created.result.status,200);const initial=eventOf(created.result.body);
    let release:() => void=() => {};let captured:() => void=() => {};
    const gate=new Promise<void>(resolve => {release=resolve;});const upstreamCaptured=new Promise<void>(resolve => {captured=resolve;});
    f.intercept=async request => {
      if (request.method !== 'GET' || !new URL(request.url).pathname.endsWith('/items')) return null;
      const stalePage=Response.json({items:structuredClone([...f.items.values()]),nextCursor:null});captured();await gate;return stalePage;
    };
    const pendingSnapshot=f.request('/snapshot');await upstreamCaptured;
    let latest:CalendarEvent | undefined;let latestRecord:unknown;
    try {
      const changed=await f.request(`/sessions/${initial.id}`,'PATCH',{...command(created.result.body),patch:{title:'Canonical v2 title',notes:'Canonical v2 notes',plannedDurationMinutes:60}});assert.equal(changed.status,200);
      latest=eventOf(changed.body);latestRecord=await f.context().entities.get('calendarEvent',initial.id);assert.equal(latest.revision,2);assert.equal(latest.organatoVersion,2);
    } finally {release();}
    const beforeWrites=f.writes.length;const snapshot=await pendingSnapshot;assert.equal(snapshot.status,200);assert.ok(latest);
    const returned=z.array(eventSchema).parse(snapshot.body.events).find(event => event.origin === 'centre' && event.id === initial.id);assert.ok(returned);assert.deepEqual(returned,latest);
    assert.equal(returned.time,'16:00:37.125');assert.equal(returned.startAt,'2026-10-21T05:00:37.125Z');
    assert.deepEqual(await f.context().entities.get('calendarEvent',initial.id),latestRecord);assert.equal(f.writes.length,beforeWrites);assert.equal(f.externalWrites().length,2);
  });

  await t.test('equal upstream version preserves exact canonical planned time precision instead of reprojecting',async () => {
    await f.connect();const data=await desktop(f,{time:'16:00:37.1250',startAt:'2026-10-21T05:00:37.125Z'});
    const linked=await f.request(`/sessions/${data.id}/link`,'POST',{expectedVersion:1,expectedRevision:1});assert.equal(linked.status,200);
    const saved=await f.context().entities.get('calendarEvent',data.id);assert.ok(saved);const beforeWrites=f.writes.length;
    const snapshot=await f.request('/snapshot');assert.equal(snapshot.status,200);
    const returned=z.array(eventSchema).parse(snapshot.body.events).find(event => event.origin === 'centre' && event.id === data.id);assert.ok(returned);assert.deepEqual(returned,data);assert.equal(returned.time,'16:00:37.1250');
    assert.deepEqual(await f.context().entities.get('calendarEvent',data.id),saved);assert.equal(f.writes.length,beforeWrites);assert.equal(f.externalWrites().length,0);
  });

  await t.test('snapshot stale ledger link A cannot overwrite canonical remote B even when A has a newer version',async () => {
    await f.connect();const created=await f.create();const original=eventOf(created.result.body);assert.ok(original.organatoId);
    const stale=f.items.get(original.organatoId);assert.ok(stale);stale.version=99;stale.displayName='Old A must not replace B';stale.notesMarkdown='Obsolete remote content';
    const current={...original,organatoId:'remote-B',organatoVersion:5,title:'Canonical B',notes:'Keep canonical B notes',revision:2};
    const saved=await f.context().entities.put({mutationId:randomUUID(),kind:'calendarEvent',id:current.id,schemaVersion:1,expectedVersion:1,deleted:false,data:current});
    f.items.set('remote-B',remoteItem({id:'remote-B',version:5,displayName:current.title,notesMarkdown:current.notes,estimatedMinutes:current.plannedDurationMinutes}));
    const assignment=remoteItem({id:'unrelated-assignment',kind:'work',calendarEnabled:false,version:17});f.items.set(assignment.id,assignment);
    const beforeWrites=f.writes.length;const snapshot=await f.request('/snapshot');assert.equal(snapshot.status,200);
    assert.deepEqual(await f.context().entities.get('calendarEvent',current.id),saved);assert.equal(f.writes.length,beforeWrites);
    const snapshotEvents=z.array(eventSchema).parse(snapshot.body.events);
    const importedOld=snapshotEvents.find(event => event.origin === 'organato' && event.id === original.organatoId);assert.ok(importedOld,'stale hosted link must not deduplicate the old remote projection');
    assert.equal(importedOld.organatoId,original.organatoId);assert.equal(importedOld.organatoVersion,99);assert.equal(importedOld.title,stale.displayName);assert.equal(importedOld.notes,stale.notesMarkdown);
    const projected=snapshotEvents.find(event => event.origin === 'centre' && event.id === current.id);
    if (projected) {assert.equal(projected.organatoId,'remote-B');assert.equal(projected.organatoVersion,5);assert.equal(projected.title,current.title);assert.equal(projected.notes,current.notes);}
    assert.deepEqual(f.items.get(assignment.id),assignment);
    const blocked=await f.request(`/sessions/${current.id}`,'PATCH',{operationId:randomUUID(),expectedVersion:2,expectedRevision:2,patch:{title:'Needs explicit link'}});assert.equal(blocked.status,409);assert.equal(f.externalWrites().length,1);
    const linked=await f.request(`/sessions/${current.id}/link`,'POST',{expectedVersion:2,expectedRevision:2});assert.equal(linked.status,200);assert.equal(calendarEventSchema.parse(linked.body.event).organatoId,'remote-B');assert.equal(f.externalWrites().length,1);
    const link=object.parse(f.db.sqlite.prepare('SELECT * FROM centre_organato_links WHERE event_id=?').get(current.id));assert.equal(link.organato_id,'remote-B');
  });

  await t.test('create, update, complete and archive preserve Centre UUID and unrelated assignments',async () => {
    await f.connect();const assignment=remoteItem({id:'unrelated',kind:'work',calendarEnabled:false,version:23});f.items.set(assignment.id,assignment);
    const created=await f.create();assert.equal(created.result.status,200);const event=eventOf(created.result.body);
    assert.equal(event.id,created.data.id);assert.notEqual(event.id,event.organatoId);assert.equal(event.revision,1);assert.equal(receipt(created.result.body).record?.version,1);
    assert.equal(receipt(created.result.body).expectedVersion,0);assert.equal(receipt(created.result.body).expectedRevision,null);
    const changed=await f.request(`/sessions/${event.id}`,'PATCH',{...command(created.result.body),patch:{title:'Moved session',date:'2026-07-21',notes:'Only planned notes'}});
    assert.equal(changed.status,200);assert.equal(eventOf(changed.body).startAt,'2026-07-21T06:00:00Z');assert.equal(eventOf(changed.body).revision,2);
    const completed=await f.request(`/sessions/${event.id}/complete`,'POST',{...command(changed.body),completed:true});assert.equal(completed.status,200);assert.ok(eventOf(completed.body).completedAt);
    const archived=await f.request(`/sessions/${event.id}/archive`,'POST',command(completed.body));assert.equal(archived.status,200);assert.ok(eventOf(archived.body).deletedAt);
    const last=f.externalWrites().at(-1);assert.equal(last?.method,'POST');assert.equal(new URL(last?.url ?? '').pathname,`/api/v1/items/${event.organatoId}/archive`);assert.deepEqual(last?.body,{version:3});
    assert.deepEqual(f.items.get(assignment.id),assignment);assert.ok(f.writes.every(write => write.kind === 'calendarEvent' && write.id === event.id));
    assert.equal(f.calls.some(call => call.method === 'DELETE' || /hours|timer|goals/.test(call.url)),false);
  });

  await t.test('only Centre sessions can be created or mutated, including imported UUID-shaped records',async () => {
    await f.connect();
    const data=session();assert.equal((await f.create({...data,kind:'deadline',time:null,startAt:null,plannedDurationMinutes:null})).result.status,400);
    assert.equal((await f.create({...data,organatoId:'unrelated',organatoVersion:1})).result.status,400);
    await f.context().entities.put({mutationId:randomUUID(),kind:'calendarEvent',id:data.id,schemaVersion:1,expectedVersion:0,deleted:false,data:{...data,origin:'organato',organatoId:'unrelated',organatoVersion:1}});
    for (const [suffix,method,payload] of [['','PATCH',{patch:{title:'Forbidden'}}],['/complete','POST',{completed:true}],['/archive','POST',{}]] as const) {
      assert.equal((await f.request(`/sessions/${data.id}${suffix}`,method,{operationId:randomUUID(),expectedVersion:1,expectedRevision:1,...payload})).status,400);
    }
    assert.equal(f.externalWrites().length,0);
  });

  await t.test('transport CAS and domain revision are independently checked before upstream writes',async () => {
    await f.connect();const created=await f.create();const event=eventOf(created.result.body);const ctx=f.context();
    await ctx.entities.put({mutationId:randomUUID(),kind:'calendarEvent',id:event.id,schemaVersion:1,expectedVersion:1,deleted:false,data:event});
    for (const input of [{expectedVersion:1,expectedRevision:1},{expectedVersion:2,expectedRevision:2}]) {
      assert.equal((await f.request(`/sessions/${event.id}`,'PATCH',{operationId:randomUUID(),...input,patch:{title:'Stale'}})).status,409);
    }
    assert.equal(f.externalWrites().length,1);
    const changed=await f.request(`/sessions/${event.id}`,'PATCH',{operationId:randomUUID(),expectedVersion:2,expectedRevision:1,patch:{title:'Valid'}});
    assert.equal(changed.status,200);assert.equal(receipt(changed.body).record?.version,3);assert.equal(eventOf(changed.body).revision,2);
    assert.equal(receipt(changed.body).expectedVersion,2);assert.equal(receipt(changed.body).expectedRevision,1);
  });

  await t.test('upstream version conflict yields a durable conflict receipt without local mutation',async () => {
    await f.connect();const created=await f.create();const event=eventOf(created.result.body);assert.ok(event.organatoId);const remote=f.items.get(event.organatoId);assert.ok(remote);remote.version=99;
    const input={...command(created.result.body),patch:{title:'Stale upstream'}};const first=await f.request(`/sessions/${event.id}`,'PATCH',input);
    assert.equal(first.status,409);assert.equal(receipt(first.body).status,'conflict');assert.equal(f.writes.length,1);
    assert.deepEqual(await f.request(`/sessions/${event.id}`,'PATCH',input),first);assert.equal(f.externalWrites().length,2);
  });

  await t.test('ledger is durable before external write; identical operation deduplicates and changed body conflicts',async () => {
    await f.connect();const data=session();const operationId=randomUUID();
    f.beforeWrite=() => {const saved=object.parse(f.db.sqlite.prepare('SELECT * FROM centre_organato_operations WHERE operation_id=?').get(operationId));assert.equal(saved.status,'pending');assert.equal(saved.event_id,data.id);};
    const first=await f.create(data,operationId);assert.equal(first.result.status,200);
    assert.deepEqual((await f.create(data,operationId)).result,first.result);assert.equal(f.externalWrites().length,1);
    assert.equal((await f.create({...data,title:'Different'},operationId)).result.status,409);assert.equal(f.externalWrites().length,1);
    assert.deepEqual((await f.request(`/operations/${operationId}`)).body,first.result.body);
  });

  await t.test('ledger insertion failure prevents every external write',async () => {
    await f.connect();f.db.failSQL=query => query.startsWith('INSERT INTO centre_organato_operations');
    const result=await f.create();assert.notEqual(result.result.status,200);assert.equal(f.externalWrites().length,0);assert.equal(f.writes.length,0);
  });

  await t.test('concurrent request observes pending ledger and cannot issue a second write',async () => {
    await f.connect();let release:() => void=() => {};let entered:() => void=() => {};
    const gate=new Promise<void>(resolve => {release=resolve;});const started=new Promise<void>(resolve => {entered=resolve;});
    f.intercept=async request => {if (request.method !== 'GET') {entered();await gate;}return null;};
    const data=session();const operationId=randomUUID();const first=f.create(data,operationId);
    await started;
    try {
      const duplicate=await f.create(data,operationId);assert.equal(duplicate.result.status,202);assert.equal(receipt(duplicate.result.body).status,'pending');
      assert.equal((await f.create(data)).result.status,409);assert.equal(f.externalWrites().length,1);
      assert.equal((await f.request(`/operations/${operationId}/reconcile`,'POST',{resolution:'not_applied'})).status,409);
    } finally {release();}
    assert.equal((await first).result.status,200);assert.equal(f.externalWrites().length,1);
  });

  for (const failure of ['disconnect','timeout','server-error','invalid-response']) await t.test(`${failure} leaves unknown receipt and blocks both same and new operation IDs`,async () => {
    await f.connect();f.intercept=async request => {if (request.method === 'GET') return null;if (failure === 'server-error') return Response.json({error:f.token},{status:503});if (failure === 'invalid-response') return Response.json({item:null});throw failure === 'timeout' ? new DOMException('Timed out','TimeoutError') : new TypeError('Socket disconnected');};
    const first=await f.create();assert.equal(first.result.status,202);assert.equal(receipt(first.result.body).status,'unknown');assert.equal(receipt(first.result.body).reconciliationRequired,true);
    assert.deepEqual((await f.create(first.data,first.operationId)).result,first.result);
    assert.equal((await f.create(first.data)).result.status,409);assert.equal(f.externalWrites().length,1);
    const saved=await f.request(`/operations/${first.operationId}`);assert.equal(saved.status,200);assert.equal(receipt(saved.body).status,'unknown');assert.equal(JSON.stringify(saved).includes(f.token),false);
  });

  await t.test('unknown create reconciliation rejects arbitrary work and same-title mismatching todo; only verified match links',async () => {
    await f.connect();f.intercept=async request => {if (request.method !== 'GET') throw new TypeError('Disconnected');return null;};
    const first=await f.create();f.intercept=null;
    const expected=remoteItem({id:'matching',version:1,displayName:first.data.title,notesMarkdown:first.data.notes,estimatedMinutes:first.data.plannedDurationMinutes});
    const wrongWork={...expected,id:'work',kind:'work' as const};
    const unrelated={...expected,id:'unrelated',notesMarkdown:'Unrelated assignment notes',estimatedMinutes:120,calendarEnabled:false};
    const sameTitle={...expected,id:'same-title',notesMarkdown:'Different content',estimatedMinutes:120};
    for (const item of [wrongWork,unrelated,sameTitle]) {f.items.set(item.id,item);const result=await f.request(`/operations/${first.operationId}/reconcile`,'POST',{resolution:'applied',organatoId:item.id});assert.equal(result.status,409);assert.equal(await f.context().entities.get('calendarEvent',first.data.id),null);assert.equal(f.db.sqlite.prepare('SELECT * FROM centre_organato_links').all().length,0);}
    assert.equal((await f.request(`/operations/${first.operationId}/reconcile`,'POST',{resolution:'applied'})).status,400);
    f.items.set(expected.id,expected);const reconciled=await f.request(`/operations/${first.operationId}/reconcile`,'POST',{resolution:'applied',organatoId:expected.id});
    assert.equal(reconciled.status,200);assert.equal(eventOf(reconciled.body).id,first.data.id);assert.equal(eventOf(reconciled.body).organatoId,expected.id);
    assert.equal(f.externalWrites().length,1);assert.equal(receipt((await f.create(first.data,first.operationId)).result.body).status,'succeeded');
  });

  await t.test('unknown create reconciliation rejects an already claimed matching remote before canonical insert and permits corrected retry',async () => {
    await f.connect();const original=await f.create();const originalEvent=eventOf(original.result.body);assert.ok(originalEvent.organatoId);
    const ctx=f.context();const originalRecord=await ctx.entities.get('calendarEvent',originalEvent.id);assert.ok(originalRecord);
    const assignment=remoteItem({id:'unrelated-assignment',kind:'work',calendarEnabled:false,version:19});f.items.set(assignment.id,assignment);
    const assignmentRecord=await ctx.entities.put({mutationId:randomUUID(),kind:'assignment',id:assignment.id,schemaVersion:1,expectedVersion:0,deleted:false,data:assignment});
    f.intercept=async request => {if (request.method !== 'GET') throw new TypeError('Create response disconnected');return null;};
    const unknown=await f.create();assert.equal(unknown.result.status,202);f.intercept=null;const beforeWrites=f.writes.length;
    const rejected=await f.request(`/operations/${unknown.operationId}/reconcile`,'POST',{resolution:'applied',organatoId:originalEvent.organatoId});assert.equal(rejected.status,409);
    assert.equal(await ctx.entities.get('calendarEvent',unknown.data.id),null);assert.equal(f.writes.length,beforeWrites,'collision must be checked before any canonical insert');
    const operation=object.parse(f.db.sqlite.prepare('SELECT * FROM centre_organato_operations WHERE operation_id=?').get(unknown.operationId));assert.equal(operation.status,'unknown');assert.equal(operation.remote_json,null,'rejected supplied ID must not poison the saved remote ID');
    assert.equal(f.db.sqlite.prepare('SELECT * FROM centre_organato_links').all().length,1);assert.deepEqual(await ctx.entities.get('calendarEvent',originalEvent.id),originalRecord);
    assert.deepEqual(await ctx.entities.get('assignment',assignment.id),assignmentRecord);assert.deepEqual(f.items.get(assignment.id),assignment);
    const matching=f.items.get(originalEvent.organatoId);assert.ok(matching);const corrected={...matching,id:'corrected-unclaimed-remote'};f.items.set(corrected.id,corrected);
    const reconciled=await f.request(`/operations/${unknown.operationId}/reconcile`,'POST',{resolution:'applied',organatoId:corrected.id});assert.equal(reconciled.status,200);
    const event=eventOf(reconciled.body);assert.equal(event.id,unknown.data.id);assert.equal(event.organatoId,corrected.id);assert.equal(f.db.sqlite.prepare('SELECT * FROM centre_organato_links').all().length,2);
    assert.deepEqual(await ctx.entities.get('calendarEvent',originalEvent.id),originalRecord);assert.deepEqual(await ctx.entities.get('assignment',assignment.id),assignmentRecord);assert.deepEqual(f.items.get(assignment.id),assignment);assert.equal(f.externalWrites().length,2);
  });

  await t.test('not-applied reconciliation closes ambiguity and requires a new intentional operation ID',async () => {
    await f.connect();f.intercept=async request => {if (request.method !== 'GET') throw new TypeError('Disconnected');return null;};const first=await f.create();f.intercept=null;
    const closed=await f.request(`/operations/${first.operationId}/reconcile`,'POST',{resolution:'not_applied'});assert.equal(receipt(closed.body).status,'failed');assert.equal(receipt(closed.body).reconciliationRequired,false);
    assert.equal((await f.create(first.data,first.operationId)).result.status,502);assert.equal(f.externalWrites().length,1);
    assert.equal((await f.create(first.data)).result.status,200);assert.equal(f.externalWrites().length,2);
  });

  await t.test('upstream success then entities.put failure cannot replay and reconciliation only reads',async () => {
    await f.connect();f.failPut=true;const first=await f.create();assert.equal(first.result.status,202);
    assert.equal((await f.create(first.data,first.operationId)).result.status,202);assert.equal((await f.create(first.data)).result.status,409);assert.equal(f.externalWrites().length,1);
    assert.equal((await f.request(`/operations/${first.operationId}/reconcile`,'POST',{resolution:'not_applied'})).status,409);
    f.failPut=false;const reconciled=await f.request(`/operations/${first.operationId}/reconcile`,'POST',{resolution:'applied'});assert.equal(reconciled.status,200);assert.equal(f.externalWrites().length,1);assert.equal(eventOf(reconciled.body).id,first.data.id);
  });

  await t.test('upstream success then receipt save failure retains durable protection',async () => {
    await f.connect();let failed=false;f.db.failSQL=query => {if (!failed && query.startsWith('UPDATE centre_organato_operations SET status')) {failed=true;return true;}return false;};
    const first=await f.create();assert.equal(first.result.status,202);assert.equal((await f.create(first.data,first.operationId)).result.status,202);assert.equal(f.externalWrites().length,1);
    assert.equal((await f.request(`/operations/${first.operationId}`)).body.status,'unknown');assert.equal(f.items.size,1);
  });

  await t.test('persistent receipt save outage still leaves pending ledger that prevents replay',async () => {
    await f.connect();f.db.failSQL=query => query.startsWith('UPDATE centre_organato_operations SET status');
    const first=await f.create();assert.equal(first.result.status,503);
    const retry=await f.create(first.data,first.operationId);assert.equal(retry.result.status,202);assert.equal(receipt(retry.result.body).status,'pending');
    assert.equal((await f.create(first.data)).result.status,409);assert.equal(f.externalWrites().length,1);
  });

  await t.test('upstream success followed by actual local CAS conflict stays unknown with transport/domain versions separate',async () => {
    await f.connect();const created=await f.create();const event=eventOf(created.result.body);const input={...command(created.result.body),patch:{title:'Remote applies'}};
    let raced=false;f.intercept=async request => {if (request.method !== 'GET' && !raced) {raced=true;await f.context().entities.put({mutationId:randomUUID(),kind:'calendarEvent',id:event.id,schemaVersion:1,expectedVersion:1,deleted:false,data:{...event,title:'Concurrent local change'}});}return null;};
    const changed=await f.request(`/sessions/${event.id}`,'PATCH',input);assert.equal(changed.status,202);assert.equal(receipt(changed.body).status,'unknown');
    const unknown=receipt(changed.body);assert.equal(unknown.expectedVersion,1);assert.equal(unknown.expectedRevision,1);
    assert.equal(unknown.event?.title,'Remote applies');assert.equal(unknown.event?.revision,2);assert.equal(unknown.event?.organatoVersion,2);
    assert.equal(unknown.record?.version,2);assert.equal(calendarEventSchema.parse(unknown.record?.data).title,'Concurrent local change');assert.equal(calendarEventSchema.parse(unknown.record?.data).revision,1);
    const local=await f.context().entities.get('calendarEvent',event.id);assert.ok(local);assert.equal(local.version,2);assert.equal(calendarEventSchema.parse(local.data).revision,1);
    assert.deepEqual(await f.request(`/sessions/${event.id}`,'PATCH',input),changed);assert.equal(f.externalWrites().length,2);
    const reconciled=await f.request(`/operations/${input.operationId}/reconcile`,'POST',{resolution:'applied'});assert.equal(reconciled.status,202);assert.equal(receipt(reconciled.body).status,'unknown');assert.equal(f.externalWrites().length,2);
  });

  for (const [status,state] of [[401,'reauth'],[403,'permission'],[500,'error']] as const) await t.test(`upstream ${status} persists ${state} without echoing secret error body`,async context => {
    const logs:unknown[][]=[];for (const method of ['log','warn','error','info'] as const) context.mock.method(console,method,(...args:unknown[]) => {logs.push(args);});await f.connect();
    f.intercept=async () => Response.json({error:f.token},{status});const result=await f.request('/snapshot');assert.notEqual(result.status,200);
    assert.equal((await f.request('/connection')).body.state,state);assert.equal(JSON.stringify({result,logs,connection:(await f.request('/connection')).body}).includes(f.token),false);
  });

  await t.test('replacing connection cannot mutate sessions linked under the old connection',async () => {
    await f.connect();const created=await f.create();const event=eventOf(created.result.body);
    f.token=randomUUID();await f.connect();
    for (const [suffix,method,extra] of [['','PATCH',{patch:{title:'Wrong account'}}],['/complete','POST',{completed:true}],['/archive','POST',{}]] as const) {
      const result=await f.request(`/sessions/${event.id}${suffix}`,method,{...command(created.result.body),...extra});assert.equal(result.status,409);
    }
    assert.equal(f.externalWrites().length,1);
    assert.ok(event.organatoId);const collision=f.items.get(event.organatoId);assert.ok(collision);collision.displayName='New account colliding remote ID';collision.version=50;
    const snapshot=await f.request('/snapshot');assert.equal(snapshot.status,200);
    const events=z.array(eventSchema).parse(snapshot.body.events);const retained=events.find(item => item.origin === 'centre' && item.id === event.id);
    if (retained) {assert.equal(retained.title,event.title);assert.equal(retained.organatoVersion,event.organatoVersion);}
    const canonical=await f.context().entities.get('calendarEvent',event.id);assert.ok(canonical);assert.equal(calendarEventSchema.parse(canonical.data).title,event.title);assert.equal(canonical.version,1);
  });

  await t.test('desktop canonical without hosted link cannot attach or mutate a mismatched upstream collision',async () => {
    await f.connect();const data={...session(),organatoId:'desktop-remote',organatoVersion:7};
    await f.context().entities.put({mutationId:randomUUID(),kind:'calendarEvent',id:data.id,schemaVersion:1,expectedVersion:0,deleted:false,data});
    f.items.set('desktop-remote',remoteItem({id:'desktop-remote',version:7,displayName:data.title,notesMarkdown:'Unrelated todo with same title'}));
    const result=await f.request(`/sessions/${data.id}`,'PATCH',{operationId:randomUUID(),expectedVersion:1,expectedRevision:1,patch:{title:'Must not touch'}});
    assert.equal(result.status,409);assert.equal(f.externalWrites().length,0);assert.equal(f.db.sqlite.prepare('SELECT * FROM centre_organato_links').all().length,0);
  });

  await t.test('unknown operation cannot reconcile through replacement credentials or blindly create again',async () => {
    await f.connect();f.intercept=async request => {if (request.method !== 'GET') throw new TypeError('Connection lost');return null;};
    const first=await f.create();f.intercept=null;f.token=randomUUID();await f.connect();const reads=f.calls.length;
    const result=await f.request(`/operations/${first.operationId}/reconcile`,'POST',{resolution:'applied',organatoId:'new-account-item'});
    assert.equal(result.status,409);assert.equal(object.parse(result.body.error).code,'connection_changed');assert.equal(f.calls.length,reads);
    assert.equal((await f.create(first.data,first.operationId)).result.status,202);assert.equal((await f.create(first.data)).result.status,409);assert.equal(f.externalWrites().length,1);
  });

  await t.test('desktop canonical mutations stay blocked until explicit read-only link verification succeeds',async () => {
    await f.connect();const data=await desktop(f);const before=f.calls.length;
    assert.equal((await f.request(`/sessions/${data.id}`,'PATCH',{operationId:randomUUID(),expectedVersion:1,expectedRevision:1,patch:{title:'Blocked'}})).status,409);
    assert.equal(f.calls.length,before);
    const linked=await f.request(`/sessions/${data.id}/link`,'POST',{expectedVersion:1,expectedRevision:1});assert.equal(linked.status,200);
    assert.deepEqual(Object.keys(linked.body).sort(),['event','record']);const event=calendarEventSchema.parse(linked.body.event);const record=object.parse(linked.body.record);
    assert.equal(event.id,data.id);assert.equal(event.organatoId,data.organatoId);assert.equal(event.organatoVersion,7);assert.equal(event.revision,1);assert.equal(record.version,1);
    assert.equal(f.calls[before]?.method,'GET');assert.equal(new URL(f.calls[before]?.url ?? '').pathname,'/api/v1/items/desktop-match');assert.equal(f.externalWrites().length,0);
    const link=object.parse(f.db.sqlite.prepare('SELECT * FROM centre_organato_links WHERE event_id=?').get(data.id));assert.equal(link.organato_id,data.organatoId);assert.equal(typeof link.connection_id,'string');
    const changed=await f.request(`/sessions/${data.id}`,'PATCH',{operationId:randomUUID(),expectedVersion:record.version,expectedRevision:event.revision,patch:{title:'Verified edit'}});
    assert.equal(changed.status,200);assert.equal(f.externalWrites().length,1);
  });

  const mismatches: [string,Partial<RemoteItem>][]=[
    ['kind',{kind:'work'}],['calendar setting',{calendarEnabled:false}],['title',{displayName:'Different title'}],
    ['notes',{notesMarkdown:'Different notes'}],['subject',{subjectId:'other-subject'}],['duration',{estimatedMinutes:120}],
    ['date',{dueAt:'2026-10-22T05:00:00Z'}],['time',{dueAt:'2026-10-21T05:01:00Z'}],
    ['completion',{workingStatus:'completed',completedAt:'2026-10-21T05:30:00Z'}],['archived',{archivedAt:'2026-10-21T05:30:00Z'}],['stale remote version',{version:6}],
  ];
  for (const [name,changes] of mismatches) await t.test(`explicit link rejects ${name} mismatch without binding or external writes`,async () => {
    await f.connect();const data=await desktop(f);assert.ok(data.organatoId);const original=f.items.get(data.organatoId);assert.ok(original);f.items.set(data.organatoId,{...original,...changes});
    const result=await f.request(`/sessions/${data.id}/link`,'POST',{expectedVersion:1,expectedRevision:1});assert.equal(result.status,409);
    assert.equal(f.externalWrites().length,0);assert.equal(f.db.sqlite.prepare('SELECT * FROM centre_organato_links').all().length,0);
    const canonical=await f.context().entities.get('calendarEvent',data.id);assert.ok(canonical);assert.equal(canonical.version,1);assert.deepEqual(canonical.data,data);
  });

  await t.test('link verifies stored remote ID and rejects arbitrary caller-supplied assignment ID',async () => {
    await f.connect();const data=await desktop(f);f.items.set('unrelated-assignment',remoteItem({id:'unrelated-assignment',kind:'work'}));
    const before=f.calls.length;const result=await f.request(`/sessions/${data.id}/link`,'POST',{expectedVersion:1,expectedRevision:1,organatoId:'unrelated-assignment'});
    assert.equal(result.status,400);assert.equal(f.calls.length,before);assert.equal(f.externalWrites().length,0);assert.equal(f.db.sqlite.prepare('SELECT * FROM centre_organato_links').all().length,0);
  });

  await t.test('link checks transport CAS and domain revision independently before remote verification',async () => {
    await f.connect();const data=await desktop(f);const ctx=f.context();await ctx.entities.put({mutationId:randomUUID(),kind:'calendarEvent',id:data.id,schemaVersion:1,expectedVersion:1,deleted:false,data});const before=f.calls.length;
    for (const input of [{expectedVersion:1,expectedRevision:1},{expectedVersion:2,expectedRevision:2}]) assert.equal((await f.request(`/sessions/${data.id}/link`,'POST',input)).status,409);
    assert.equal(f.calls.length,before);assert.equal(f.externalWrites().length,0);
    const valid=await f.request(`/sessions/${data.id}/link`,'POST',{expectedVersion:2,expectedRevision:1});assert.equal(valid.status,200);assert.equal(object.parse(valid.body.record).version,2);assert.equal(calendarEventSchema.parse(valid.body.event).revision,1);
  });

  await t.test('newer verified remote version refreshes canonical version and domain revision using CAS',async () => {
    await f.connect();const data=await desktop(f);assert.ok(data.organatoId);const item=f.items.get(data.organatoId);assert.ok(item);item.version=11;
    const linked=await f.request(`/sessions/${data.id}/link`,'POST',{expectedVersion:1,expectedRevision:1});assert.equal(linked.status,200);
    const event=calendarEventSchema.parse(linked.body.event);assert.equal(event.id,data.id);assert.equal(event.organatoVersion,11);assert.equal(event.revision,2);assert.equal(object.parse(linked.body.record).version,2);assert.equal(f.externalWrites().length,0);
    const stale=await f.request(`/sessions/${data.id}`,'PATCH',{operationId:randomUUID(),expectedVersion:1,expectedRevision:1,patch:{title:'Stale'}});assert.equal(stale.status,409);
    const changed=await f.request(`/sessions/${data.id}`,'PATCH',{operationId:randomUUID(),expectedVersion:2,expectedRevision:2,patch:{title:'Current'}});assert.equal(changed.status,200);assert.equal(f.externalWrites()[0]?.body?.version,11);
  });

  await t.test('local CAS change during upstream link verification prevents binding',async () => {
    await f.connect();const data=await desktop(f);let raced=false;
    f.intercept=async request => {if (!raced && new URL(request.url).pathname.endsWith('/desktop-match')) {raced=true;await f.context().entities.put({mutationId:randomUUID(),kind:'calendarEvent',id:data.id,schemaVersion:1,expectedVersion:1,deleted:false,data:{...data,title:'Concurrent change',revision:2}});}return null;};
    const result=await f.request(`/sessions/${data.id}/link`,'POST',{expectedVersion:1,expectedRevision:1});assert.equal(result.status,409);assert.equal(raced,true);
    assert.equal(f.externalWrites().length,0);assert.equal(f.db.sqlite.prepare('SELECT * FROM centre_organato_links').all().length,0);
    const current=await f.context().entities.get('calendarEvent',data.id);assert.ok(current);assert.equal(current.version,2);assert.equal(calendarEventSchema.parse(current.data).title,'Concurrent change');
  });

  await t.test('two Centre UUIDs cannot claim the same remote item under one credential',async () => {
    await f.connect();const first=await desktop(f);const second=await desktop(f,{id:randomUUID()});
    assert.equal((await f.request(`/sessions/${first.id}/link`,'POST',{expectedVersion:1,expectedRevision:1})).status,200);
    assert.equal((await f.request(`/sessions/${second.id}/link`,'POST',{expectedVersion:1,expectedRevision:1})).status,409);
    const links=f.db.sqlite.prepare('SELECT * FROM centre_organato_links').all();assert.equal(links.length,1);assert.equal(links[0]?.event_id,first.id);assert.equal(f.externalWrites().length,0);
  });

  await t.test('link cannot bind imported, deadline, deleted or unlinked canonical records',async () => {
    await f.connect();const seed=await desktop(f);
    const variants=[{...seed,id:randomUUID(),origin:'organato'},{...seed,id:randomUUID(),kind:'deadline',time:null,startAt:null,plannedDurationMinutes:null},
      {...seed,id:randomUUID(),deletedAt:'2026-10-21T05:30:00Z'},{...seed,id:randomUUID(),organatoId:null,organatoVersion:null}];
    for (const data of variants) {
      await f.context().entities.put({mutationId:randomUUID(),kind:'calendarEvent',id:data.id,schemaVersion:1,expectedVersion:0,deleted:false,data});
      const result=await f.request(`/sessions/${data.id}/link`,'POST',{expectedVersion:1,expectedRevision:1});assert.ok([400,404,409].includes(result.status));
    }
    assert.equal(f.externalWrites().length,0);assert.equal(f.db.sqlite.prepare('SELECT * FROM centre_organato_links').all().length,0);
  });

  await t.test('link is workspace scoped and cannot read or bind another workspace canonical session',async () => {
    await f.connect();const data=await desktop(f);const b=f.context('workspace-b');await f.connect(b);const before=f.calls.length;
    const result=await f.request(`/sessions/${data.id}/link`,'POST',{expectedVersion:1,expectedRevision:1},b);assert.equal(result.status,404);assert.equal(f.calls.length,before);assert.equal(f.externalWrites().length,0);
    assert.equal(f.db.sqlite.prepare('SELECT * FROM centre_organato_links').all().length,0);
  });

  await t.test('completed desktop canonical link verifies completion and never generates actual study time',async () => {
    await f.connect();const data=await desktop(f,{completedAt:'2026-10-21T05:30:00Z'});assert.ok(data.organatoId);const item=f.items.get(data.organatoId);assert.ok(item);
    item.workingStatus='not_started';item.completedAt=null;
    assert.equal((await f.request(`/sessions/${data.id}/link`,'POST',{expectedVersion:1,expectedRevision:1})).status,409);
    item.workingStatus='completed';item.completedAt=data.completedAt;
    const linked=await f.request(`/sessions/${data.id}/link`,'POST',{expectedVersion:1,expectedRevision:1});assert.equal(linked.status,200);assert.equal(calendarEventSchema.parse(linked.body.event).completedAt,data.completedAt);
    assert.equal(f.externalWrites().length,0);assert.ok(f.writes.every(write => write.kind === 'calendarEvent'));
  });

  await t.test('credential rotation requires explicit verified relink before normal mutations',async () => {
    await f.connect();const created=await f.create();const event=eventOf(created.result.body);const oldLink=object.parse(f.db.sqlite.prepare('SELECT * FROM centre_organato_links WHERE event_id=?').get(event.id));
    f.token=randomUUID();await f.connect();const input={...command(created.result.body),patch:{notes:'After rotation'}};
    assert.equal((await f.request(`/sessions/${event.id}`,'PATCH',input)).status,409);assert.equal(f.externalWrites().length,1);
    assert.ok(event.organatoId);const item=f.items.get(event.organatoId);assert.ok(item);item.notesMarkdown='Different account item';
    assert.equal((await f.request(`/sessions/${event.id}/link`,'POST',{expectedVersion:1,expectedRevision:1})).status,409);
    assert.equal(object.parse(f.db.sqlite.prepare('SELECT * FROM centre_organato_links WHERE event_id=?').get(event.id)).connection_id,oldLink.connection_id);item.notesMarkdown=event.notes;
    const linked=await f.request(`/sessions/${event.id}/link`,'POST',{expectedVersion:1,expectedRevision:1});assert.equal(linked.status,200);assert.equal(f.externalWrites().length,1);
    const newLink=object.parse(f.db.sqlite.prepare('SELECT * FROM centre_organato_links WHERE event_id=?').get(event.id));assert.notEqual(newLink.connection_id,oldLink.connection_id);assert.equal(newLink.organato_id,event.organatoId);
    assert.equal((await f.request(`/sessions/${event.id}`,'PATCH',input)).status,200);assert.equal(f.externalWrites().length,2);
  });

  for (const precision of ['37','37.125']) await t.test(`imported and linked timestamps preserve untouched seconds ${precision} through projection, edit and completion`,async () => {
    await f.connect();const time=`16:00:${precision}`;const startAt=`2026-10-21T05:00:${precision}Z`;
    const data=await desktop(f,{time,startAt});const imported=remoteItem({id:'precise-import',dueAt:startAt});f.items.set(imported.id,imported);
    const linked=await f.request(`/sessions/${data.id}/link`,'POST',{expectedVersion:1,expectedRevision:1});assert.equal(linked.status,200);assert.equal(calendarEventSchema.parse(linked.body.event).time,time);
    const snapshot=await f.request('/snapshot');assert.equal(snapshot.status,200);const events=z.array(eventSchema).parse(snapshot.body.events);
    for (const id of [data.id,imported.id]) {const event=events.find(item => item.id === id);assert.ok(event);assert.equal(event.time,time);assert.equal(event.startAt,startAt);}
    const changed=await f.request(`/sessions/${data.id}`,'PATCH',{operationId:randomUUID(),expectedVersion:1,expectedRevision:1,patch:{notes:'Keep exact start'}});assert.equal(changed.status,200);assert.equal(eventOf(changed.body).time,time);assert.equal(eventOf(changed.body).startAt,startAt);
    assert.equal(f.externalWrites().at(-1)?.body?.dueAt,startAt);
    const completed=await f.request(`/sessions/${data.id}/complete`,'POST',{...command(changed.body),completed:true});assert.equal(completed.status,200);assert.equal(eventOf(completed.body).time,time);assert.equal(eventOf(completed.body).startAt,startAt);
    assert.ok(f.writes.every(write => write.kind === 'calendarEvent'));assert.ok(f.externalWrites().every(call => /\/items(?:\/[^/]+)?$/.test(new URL(call.url).pathname)));assert.equal(f.items.get(imported.id)?.dueAt,startAt);
  });
});
