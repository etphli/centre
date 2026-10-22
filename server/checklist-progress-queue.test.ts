import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diagramPreviewSchema } from '../shared/checklist-progress';
import { ChecklistProgressQueue, type ChecklistProgressEvent, type ChecklistProgressScope } from '../shared/checklist-progress-queue';
import { resourceSchema } from '../shared/schema';
import { createService } from './index';
import { Store } from './store';

const scope:ChecklistProgressScope = {resourceId:'checklist',documentRevision:'a'.repeat(64)};

function deferred<T>() {
  let resolve!:(value:T|PromiseLike<T>) => void;
  let reject!:(reason:unknown) => void;
  const promise = new Promise<T>((yes,no) => { resolve = yes;reject = no; });
  return {promise,resolve,reject};
}

// Give queued promise continuations a turn without relying on wall-clock delays.
const turn = () => new Promise<void>(resolve => setImmediate(resolve));

function controlledQueue() {
  const calls:{scope:ChecklistProgressScope;itemId:string;checked:boolean;result:ReturnType<typeof deferred<void>>}[] = [];
  const queue = new ChecklistProgressQueue((scope,itemId,checked) => {
    const result = deferred<void>();
    calls.push({scope,itemId,checked,result});
    return result.promise;
  });
  const call = (index:number) => {
    const value = calls[index];
    assert.ok(value,`Expected persistence call ${index}`);
    return value;
  };
  return {queue,calls,call};
}

test('queued writes continue after the last view unsubscribes',async () => {
  const {queue,calls,call} = controlledQueue();
  const events:ChecklistProgressEvent[] = [];
  const unsubscribe = queue.subscribe(scope,event => events.push(event));
  queue.enqueue(scope,'alpha',true);
  await turn();
  queue.enqueue(scope,'beta',true);
  unsubscribe();
  const before = [...events];
  call(0).result.resolve();
  await turn();
  assert.equal(calls.length,2);
  assert.equal(call(1).itemId,'beta');
  call(1).result.resolve();
  assert.equal(await queue.read(scope.resourceId,async () => 'restored'),'restored');
  assert.deepEqual([...queue.pending(scope)],[]);
  assert.deepEqual(events,before);
});

test('toggles coalesce to the latest value per item while a write is in flight',async () => {
  const {queue,calls,call} = controlledQueue();
  queue.enqueue(scope,'alpha',true);
  await turn();
  queue.enqueue(scope,'alpha',false);
  queue.enqueue(scope,'alpha',true);
  queue.enqueue(scope,'alpha',false);
  queue.enqueue(scope,'beta',true);
  queue.enqueue(scope,'beta',false);
  assert.deepEqual([...queue.pending(scope)],[['alpha',false],['beta',false]]);
  assert.equal(calls.length,1);
  call(0).result.resolve();
  await turn();
  assert.equal(call(1).itemId,'alpha');
  assert.equal(call(1).checked,false);
  call(1).result.resolve();
  await turn();
  assert.equal(call(2).itemId,'beta');
  assert.equal(call(2).checked,false);
  call(2).result.resolve();
  await queue.read(scope.resourceId,async () => undefined);
  assert.equal(calls.length,3);
  assert.equal(queue.pending(scope).size,0);
});

test('a new view reads only after all queued writes have settled',async () => {
  const {queue,call} = controlledQueue();
  queue.enqueue(scope,'alpha',true);
  await turn();
  queue.enqueue(scope,'beta',true);
  let loads = 0;
  const restored = queue.read(scope.resourceId,async () => { loads += 1;return ['alpha','beta']; });
  await turn();
  assert.equal(loads,0);
  call(0).result.resolve();
  await turn();
  assert.equal(loads,0);
  call(1).result.resolve();
  assert.deepEqual(await restored,['alpha','beta']);
  assert.equal(loads,1);
});

test('a change during a preview read discards the stale result and waits before reading again',async () => {
  const {queue,call} = controlledQueue();
  const stale = deferred<string[]>();
  let loads = 0;
  let returned = false;
  const restored = queue.read(scope.resourceId,() => {
    loads += 1;
    return loads === 1 ? stale.promise : Promise.resolve(['alpha']);
  }).then(value => { returned = true;return value; });
  assert.equal(loads,1);
  queue.enqueue(scope,'alpha',true);
  await turn();
  stale.resolve([]);
  await turn();
  assert.equal(returned,false);
  assert.equal(loads,1);
  call(0).result.resolve();
  assert.deepEqual(await restored,['alpha']);
  assert.equal(loads,2);
});

test('a change that finishes before a preview response still forces a fresh read',async () => {
  const {queue,call} = controlledQueue();
  const stale = deferred<string[]>();
  let loads = 0;
  const restored = queue.read(scope.resourceId,() => ++loads === 1 ? stale.promise : Promise.resolve(['beta']));
  queue.enqueue(scope,'beta',true);
  await turn();
  call(0).result.resolve();
  await queue.read(scope.resourceId,async () => undefined);
  stale.resolve([]);
  assert.deepEqual(await restored,['beta']);
  assert.equal(loads,2);
});

for (const resume of ['retry','fresh change']) {
  test(`save failure retains latest intent without automatic replay and resumes on ${resume}`,async () => {
    const {queue,calls,call} = controlledQueue();
    const events:ChecklistProgressEvent[] = [];
    const unsubscribe = queue.subscribe(scope,event => events.push(event));
    queue.enqueue(scope,'alpha',true);
    await turn();
    queue.enqueue(scope,'alpha',false);
    queue.enqueue(scope,'beta',true);
    call(0).result.reject(new Error('storage unavailable'));
    await turn();
    assert.deepEqual(events.at(-1),{type:'status',status:'error'});
    assert.deepEqual([...queue.pending(scope)],[['alpha',false],['beta',true]]);
    const snapshot = queue.pending(scope);
    unsubscribe();
    const remounted:ChecklistProgressEvent[] = [];
    const stop = queue.subscribe({...scope},event => remounted.push(event));
    assert.deepEqual(remounted,[{type:'status',status:'error'}]);
    assert.equal(await queue.read(scope.resourceId,async () => 'server state'),'server state');
    await turn();
    assert.equal(calls.length,1,'Reading and subscribing must not replay a failed write');
    if (resume === 'retry') {
      queue.retry(scope);
      queue.retry(scope);
    } else queue.enqueue(scope,'beta',false);
    await turn();
    assert.equal(calls.length,2,'Only one persistence loop may resume');
    assert.equal(call(1).itemId,'alpha');
    assert.equal(call(1).checked,false);
    call(1).result.resolve();
    await turn();
    assert.equal(call(2).itemId,'beta');
    assert.equal(call(2).checked,resume === 'retry');
    call(2).result.resolve();
    await queue.read(scope.resourceId,async () => undefined);
    assert.deepEqual(remounted.at(-1),{type:'status',status:'saved'});
    assert.equal(queue.pending(scope).size,0);
    assert.deepEqual([...snapshot],[['alpha',false],['beta',true]],'Pending snapshots must not change under the caller');
    assert.equal(calls.length,3);
    stop();
  });
}

test('a synchronously throwing persister reports error and can be retried',async () => {
  let attempts = 0;
  const queue = new ChecklistProgressQueue(() => {
    attempts += 1;
    if (attempts === 1) throw new Error('synchronous storage failure');
    return Promise.resolve();
  });
  const events:ChecklistProgressEvent[] = [];
  const stop = queue.subscribe(scope,event => events.push(event));
  assert.doesNotThrow(() => queue.enqueue(scope,'alpha',true));
  await queue.read(scope.resourceId,async () => undefined);
  assert.equal(attempts,1);
  assert.deepEqual(events.at(-1),{type:'status',status:'error'});
  assert.deepEqual([...queue.pending(scope)],[['alpha',true]]);
  queue.retry(scope);
  await queue.read(scope.resourceId,async () => undefined);
  assert.equal(attempts,2);
  assert.equal(queue.pending(scope).size,0);
  assert.deepEqual(events.at(-1),{type:'status',status:'saved'});
  stop();
});

test('views of the same resource and revision share changes and save status',async () => {
  const {queue,calls,call} = controlledQueue();
  const first:ChecklistProgressEvent[] = [];
  const second:ChecklistProgressEvent[] = [];
  const stopFirst = queue.subscribe(scope,event => first.push(event));
  const stopSecond = queue.subscribe({...scope},event => second.push(event));
  queue.enqueue({...scope},'alpha',true);
  await turn();
  assert.deepEqual(first,[{type:'status',status:'idle'},{type:'change',itemId:'alpha',checked:true},{type:'status',status:'saving'}]);
  assert.deepEqual(second,first);
  assert.equal(calls.length,1);
  call(0).result.resolve();
  await queue.read(scope.resourceId,async () => undefined);
  assert.deepEqual(second.at(-1),{type:'status',status:'saved'});
  assert.deepEqual(first,second);
  stopFirst();stopSecond();
});

test('resources and document revisions isolate pending edits, failures, and events',async () => {
  const {queue,calls,call} = controlledQueue();
  const revised = {...scope,documentRevision:'b'.repeat(64)};
  const other = {...scope,resourceId:'other'};
  const events:ChecklistProgressEvent[][] = [[],[],[]];
  const stops = [scope,revised,other].map((value,index) => queue.subscribe(value,event => events[index].push(event)));
  queue.enqueue(scope,'alpha',true);
  queue.enqueue(revised,'alpha',false);
  queue.enqueue(other,'alpha',true);
  await turn();
  assert.equal(calls.length,3,'An unrelated scope must not wait for another scope to save');
  assert.deepEqual([...queue.pending(scope)],[['alpha',true]]);
  assert.deepEqual([...queue.pending(revised)],[['alpha',false]]);
  assert.deepEqual([...queue.pending(other)],[['alpha',true]]);
  let loads = 0;
  const restored = queue.read(scope.resourceId,async () => { loads += 1;return 'new revision'; });
  assert.equal(await queue.read('unrelated',async () => 'independent'),'independent');
  call(0).result.reject(new Error('old revision failed'));
  await turn();
  assert.equal(loads,0,'Resource reads must wait for writes to every document revision');
  call(1).result.resolve();
  assert.equal(await restored,'new revision');
  assert.equal(loads,1,'A different resource still saving must not block this read');
  assert.deepEqual(events[0].at(-1),{type:'status',status:'error'});
  assert.deepEqual(events[1].at(-1),{type:'status',status:'saved'});
  assert.deepEqual(events[2].at(-1),{type:'status',status:'saving'});
  assert.deepEqual(events.map(list => list.filter(event => event.type === 'change')),[
    [{type:'change',itemId:'alpha',checked:true}],
    [{type:'change',itemId:'alpha',checked:false}],
    [{type:'change',itemId:'alpha',checked:true}],
  ]);
  assert.equal(queue.pending(revised).size,0);
  call(2).result.resolve();
  await queue.read(other.resourceId,async () => undefined);
  assert.deepEqual([...queue.pending(scope)],[['alpha',true]]);
  stops.forEach(stop => stop());
});

test('navigation restores queued edits through real HTTP persistence and on-disk storage',{timeout:15000},async () => {
  const directory = await mkdtemp(join(tmpdir(),'centre-checklist-queue-'));
  const originalBinary = process.env.CENTRE_CODEX_BIN;
  process.env.CENTRE_CODEX_BIN = '/centre-test/no-codex-binary';
  let service:Awaited<ReturnType<typeof createService>>|undefined;
  const release = deferred<void>();
  try {
    const store = await Store.open(directory);
    const timestamp = '2026-10-20T00:00:00.000Z';
    store.state.resources.push(resourceSchema.parse({id:scope.resourceId,kind:'diagram',subjectId:null,topicId:null,
      title:'Queue navigation',content:'<input type="checkbox" data-centre-checklist-id="alpha"><input type="checkbox" data-centre-checklist-id="beta">',
      createdAt:timestamp,updatedAt:timestamp}));
    await store.save();
    service = await createService({dataDir:directory,token:'checklist-queue-test-token'});
    const base = `http://127.0.0.1:${service.port}/api/resources/${scope.resourceId}`;
    const headers = {Authorization:`Bearer ${service.token}`,'Content-Type':'application/json'};
    const load = async () => {
      const response = await fetch(`${base}/preview`,{headers});
      assert.equal(response.status,200);
      return diagramPreviewSchema.parse(await response.json());
    };
    const initial = await load();
    const liveScope = {...scope,documentRevision:initial.documentRevision};
    const entered = deferred<void>();
    let writes = 0;
    const queue = new ChecklistProgressQueue(async (value,itemId,checked) => {
      writes += 1;
      if (writes === 1) { entered.resolve();await release.promise; }
      const response = await fetch(`${base}/checklist-progress`,{method:'POST',headers,
        body:JSON.stringify({documentRevision:value.documentRevision,itemId,checked})});
      assert.equal(response.status,200);
      return response.json();
    });
    const events:ChecklistProgressEvent[] = [];
    const unsubscribe = queue.subscribe(liveScope,event => events.push(event));
    queue.enqueue(liveScope,'alpha',true);
    await entered.promise;
    queue.enqueue(liveScope,'alpha',false);
    queue.enqueue(liveScope,'beta',true);
    unsubscribe();
    const detachedEvents = [...events];
    let loads = 0;
    const restored = queue.read(scope.resourceId,() => { loads += 1;return load(); });
    await turn();
    assert.equal(loads,0);
    release.resolve();
    const preview = await restored;
    assert.equal(loads,1);
    assert.equal(writes,3);
    assert.equal(preview.documentRevision,initial.documentRevision);
    assert.equal(preview.hasProgress,true);
    assert.deepEqual(preview.checkedItemIds,['beta']);
    assert.equal(queue.pending(liveScope).size,0);
    assert.deepEqual(events,detachedEvents);
    await service.close();service = undefined;
    const reopened = await Store.open(directory);
    assert.equal(reopened.state.interactiveResourceProgress.length,1);
    assert.deepEqual(reopened.state.interactiveResourceProgress[0]?.checkedItemIds,['beta']);
    assert.equal(reopened.state.interactiveResourceProgress[0]?.revision,3);
  } finally {
    release.resolve();
    await service?.close();
    if (originalBinary === undefined) delete process.env.CENTRE_CODEX_BIN;else process.env.CENTRE_CODEX_BIN = originalBinary;
    await rm(directory,{recursive:true,force:true});
  }
});
