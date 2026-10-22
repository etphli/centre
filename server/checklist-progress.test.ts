import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  diagramPreviewSchema, interactiveResourceProgressId, interactiveResourceProgressSchema,
  MAX_CHECKLIST_BRIDGE_MESSAGE_BYTES, mergeInteractiveResourceProgress,
  validateChecklistBridgeMessage, validateInteractiveResourceProgress,
} from '../shared/checklist-progress';
import { resourceSchema, snapshotSchema } from '../shared/schema';
import { checklistDocumentRevision, checklistPreview, updateChecklistProgress } from './checklist-progress';
import { prepareChecklistContent } from './diagram';
import { createService } from './index';
import { emptySnapshot, Store } from './store';

const timestamp = '2026-10-20T00:00:00.000Z';
const documentRevision = 'a'.repeat(64);
const entity = {
  schemaVersion:1, id:'12345678-1234-4123-8123-123456789012', revision:1,
  resourceId:'checklist', documentRevision, checkedItemIds:['alpha','beta'],
  createdAt:timestamp, updatedAt:timestamp, deletedAt:null,
};
const content = '<h1>Revision</h1><input type="checkbox" data-centre-checklist-id="alpha" checked><input type="checkbox" data-centre-checklist-id="beta"><input type="checkbox" data-centre-checklist-id="gamma">';

function diagram(id = 'checklist', html = content) {
  return resourceSchema.parse({ id, kind:'diagram', subjectId:null, topicId:null,
    title:'Revision checklist', content:html, createdAt:timestamp, updatedAt:timestamp });
}

test('progress accepts canonical strict v1 entities and rejects invalid persisted records',() => {
  assert.deepEqual(validateInteractiveResourceProgress(entity),entity);
  const invalid:unknown[] = [
    {...entity,schemaVersion:2}, {...entity,extra:true}, {...entity,id:'not-a-uuid'},
    {...entity,revision:0}, {...entity,revision:1.5}, {...entity,resourceId:''},
    {...entity,resourceId:'x'.repeat(201)}, {...entity,documentRevision:'A'.repeat(64)},
    {...entity,documentRevision:'abc'}, {...entity,checkedItemIds:['beta','alpha']},
    {...entity,checkedItemIds:['alpha','alpha']}, {...entity,checkedItemIds:['Invalid']},
    {...entity,checkedItemIds:Array.from({length:101},(_,index) => `item-${String(index).padStart(3,'0')}`)},
    {...entity,createdAt:'yesterday'}, {...entity,updatedAt:null}, {...entity,deletedAt:'invalid'},
  ];
  for (const value of invalid) assert.equal(interactiveResourceProgressSchema.safeParse(value).success,false,JSON.stringify(value));
});

test('progress IDs are deterministic UUID v8 values scoped to resource and content revision',async () => {
  const id = await interactiveResourceProgressId('checklist',documentRevision);
  assert.equal(await interactiveResourceProgressId('checklist',documentRevision),id);
  assert.match(id,/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(await interactiveResourceProgressId('other',documentRevision),id);
  assert.notEqual(await interactiveResourceProgressId('checklist','b'.repeat(64)),id);
  assert.equal(validateInteractiveResourceProgress({...entity,id}).id,id);
  await assert.rejects(interactiveResourceProgressId('',documentRevision));
  await assert.rejects(interactiveResourceProgressId('checklist','invalid'));
});

test('merge orders domain revisions and exposes equal divergent edits as conflicts',() => {
  const higher = {...entity,revision:2,checkedItemIds:[],updatedAt:'2020-01-01T00:00:00.000Z'};
  assert.deepEqual(mergeInteractiveResourceProgress(entity,higher),{kind:'incoming',value:higher});
  assert.deepEqual(mergeInteractiveResourceProgress(higher,entity),{kind:'local',value:higher});
  assert.deepEqual(mergeInteractiveResourceProgress(entity,{...entity,updatedAt:'2030-01-01T00:00:00.000Z'}),{kind:'same',value:entity});
  for (const incoming of [{...entity,checkedItemIds:[]},{...entity,deletedAt:timestamp}]) {
    assert.deepEqual(mergeInteractiveResourceProgress(entity,incoming),{kind:'conflict',reason:'equal-revision',local:entity,incoming});
  }
  for (const incoming of [{...entity,id:'22345678-1234-4123-8123-123456789012'},{...entity,resourceId:'other'}]) {
    assert.deepEqual(mergeInteractiveResourceProgress(entity,incoming),{kind:'conflict',reason:'record-identity',local:entity,incoming});
  }
  const incoming = {...entity,documentRevision:'b'.repeat(64),revision:99};
  assert.deepEqual(mergeInteractiveResourceProgress(entity,incoming),{kind:'conflict',reason:'document-revision',local:entity,incoming});
  assert.throws(() => mergeInteractiveResourceProgress(entity,{...entity,revision:0}));
});

test('static checklist IDs exclude inert content and remain deterministic for legacy checkboxes',() => {
  const html = `<!-- <input type="checkbox" checked> -->
    <script>const sample = '<input type="checkbox" checked>';</script>
    <style>/* <input type="checkbox" checked> */</style>
    <p>&lt;input type="checkbox" checked&gt;</p>
    <div data-example="<input type='checkbox' checked>">An HTML example</div>
    <input type="text" data-example="type='checkbox'">
    <template><input type="checkbox"><template><input type="checkbox"></template></template>
    <input type="text"><input TYPE='CHECKBOX' checked>
    <input type=checkbox data-centre-checklist-id="explicit">
    <input type="checkbox" data-centre-checklist-id="duplicate">
    <input type="checkbox" data-centre-checklist-id="duplicate">
    <input type="checkbox" data-centre-checklist-id="legacy-1">
    <input type="checkbox" data-centre-checklist-id="Invalid">`;
  const prepared = prepareChecklistContent(html);
  assert.deepEqual(prepared.itemIds,['legacy-1','explicit','legacy-3','legacy-4','legacy-5','legacy-6']);
  assert.deepEqual(prepared.checkedItemIds,['legacy-1']);
  assert.deepEqual(prepareChecklistContent(html),prepared);
  assert.deepEqual(prepareChecklistContent(prepared.content).itemIds,prepared.itemIds);
  assert.equal(prepareChecklistContent('<input type="checkbox">'.repeat(101)).itemIds.length,100);
  assert.equal(checklistDocumentRevision('abc'),'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.notEqual(checklistDocumentRevision(html),checklistDocumentRevision(prepared.content));
  const rawText = '<script>const example = "</scriptx><input type=checkbox>";</script><input type=checkbox>';
  const preparedRawText = prepareChecklistContent(rawText);
  assert.deepEqual(preparedRawText.itemIds,['legacy-1']);
  assert.ok(preparedRawText.content.includes('const example = "</scriptx><input type=checkbox>";'));
  assert.deepEqual(prepareChecklistContent('<input type="check&#98;ox">').itemIds,['legacy-1']);
  const bridgeText = '<script>const example="<!--centre:bridge--><input type=checkbox><!--/centre:bridge-->";</script><input type=checkbox>';
  const preparedBridgeText = prepareChecklistContent(bridgeText);
  assert.deepEqual(preparedBridgeText.itemIds,['legacy-1']);
  assert.ok(preparedBridgeText.content.includes('const example="<!--centre:bridge--><input type=checkbox><!--/centre:bridge-->";'));
});

test('old snapshot files acquire an empty progress collection and persist the schema default',async () => {
  const directory = await mkdtemp(join(tmpdir(),'centre-legacy-checklists-'));
  try {
    const {interactiveResourceProgress:omitted,...legacy} = emptySnapshot();
    assert.deepEqual(omitted,[]);
    await writeFile(join(directory,'state.json'),JSON.stringify(legacy));
    const store = await Store.open(directory);
    assert.deepEqual(store.state.interactiveResourceProgress,[]);
    await store.save();
    assert.deepEqual(JSON.parse(await readFile(join(directory,'state.json'),'utf8')).interactiveResourceProgress,[]);
  } finally { await rm(directory,{recursive:true,force:true}); }
});

test('parent bridge validator rejects forged windows, wrong scope, IDs and malformed or oversized messages',() => {
  const frame = {};
  const ready = {type:'centre:checklist-ready',resourceId:'checklist',documentRevision};
  const change = {type:'centre:checklist-change',resourceId:'checklist',documentRevision,itemId:'alpha',checked:true};
  const validate = (value:unknown,source:unknown = frame,expected:unknown = frame) => validateChecklistBridgeMessage(source,expected,value,'checklist',documentRevision,new Set(['alpha']));
  assert.deepEqual(validate(ready),{type:'ready'});
  assert.deepEqual(validate(change),{type:'change',itemId:'alpha',checked:true});
  assert.deepEqual(validate({...change,checked:false}),{type:'change',itemId:'alpha',checked:false});
  assert.equal(validate(change,{}),null);
  assert.equal(validate(change,null,null),null);
  const invalid:unknown[] = [null,[],true,'message',{}, {...ready,resourceId:'other'},
    {...ready,documentRevision:'b'.repeat(64)}, {...change,resourceId:'other'},
    {...change,documentRevision:'b'.repeat(64)}, {...change,itemId:'beta'},
    {...change,itemId:'Invalid'}, {...change,checked:'true'}, {...change,checked:undefined},
    {...change,extra:true}, {...change,checked:{value:true}}, {...change,type:'centre:checklist-restore'},
    {...change,resourceId:'x'.repeat(MAX_CHECKLIST_BRIDGE_MESSAGE_BYTES + 1)},
    {...change,resourceId:'😀'.repeat(600)},
  ];
  for (const value of invalid) assert.equal(validate(value),null,JSON.stringify(value));
});

test('authenticated progress API persists defaults, isolates resources and restores after archive and service restart',async () => {
  const directory = await mkdtemp(join(tmpdir(),'centre-checklist-api-'));
  const originalBinary = process.env.CENTRE_CODEX_BIN;
  process.env.CENTRE_CODEX_BIN = '/centre-test/no-codex-binary';
  let service:Awaited<ReturnType<typeof createService>>|undefined;
  try {
    const store = await Store.open(directory);
    store.state.resources.push(diagram(),diagram('other'),resourceSchema.parse({...diagram('notes'),kind:'notes'}));
    await store.save();
    service = await createService({dataDir:directory,token:'checklist-test-token'});
    const request = (path:string,method = 'GET',body?:unknown,authenticated = true) => {
      assert.ok(service);
      return fetch(`http://127.0.0.1:${service.port}/api${path}`,{method,
        headers:{...(authenticated ? {Authorization:`Bearer ${service.token}`} : {}),'Content-Type':'application/json'},
        ...(body === undefined ? {} : {body:JSON.stringify(body)})});
    };
    const preview = async (id = 'checklist') => {
      const response = await request(`/resources/${id}/preview`); assert.equal(response.status,200);
      return diagramPreviewSchema.parse(await response.json());
    };
    const initial = await preview();
    assert.equal(initial.documentRevision,checklistDocumentRevision(content));
    assert.deepEqual(initial.itemIds,['alpha','beta','gamma']);
    assert.deepEqual(initial.checkedItemIds,['alpha']); assert.equal(initial.hasProgress,false);
    const update = {documentRevision:initial.documentRevision,itemId:'beta',checked:true};
    assert.equal((await request('/resources/checklist/checklist-progress','POST',update,false)).status,401);
    assert.equal((await request('/resources/notes/checklist-progress','POST',update)).status,400);
    assert.equal((await request('/resources/missing/checklist-progress','POST',update)).status,404);
    for (const body of [{...update,itemId:'unknown'},{...update,checked:'true'},{...update,extra:true}]) {
      assert.equal((await request('/resources/checklist/checklist-progress','POST',body)).status,400);
    }
    assert.equal((await request('/resources/checklist/checklist-progress','POST',{...update,extra:'x'.repeat(17000)})).status,413);
    const artifact = await fetch(initial.url);
    assert.equal(artifact.status,200);
    const html = await artifact.text();
    assert.ok(html.includes(JSON.stringify(prepareChecklistContent(content).content).slice(1,-1).replace(/</g,'\\u003c'))); assert.ok(html.includes(initial.documentRevision));
    assert.match(html,/centre:checklist-ready/); assert.match(html,/centre:checklist-change/); assert.match(html,/centre:checklist-restore/);
    const otherArtifact = new URL(initial.url); otherArtifact.pathname = otherArtifact.pathname.replace('/checklist/','/other/');
    assert.equal((await fetch(otherArtifact)).status,403);
    assert.equal((await fetch(initial.url,{method:'POST'})).status,405);

    // A source-default no-op must not create a progress record.
    assert.equal((await request('/resources/checklist/checklist-progress','POST',{...update,itemId:'alpha'})).status,200);
    assert.equal((await Store.open(directory)).state.interactiveResourceProgress.length,0);
    const results = await Promise.all(['beta','gamma'].map(itemId => request('/resources/checklist/checklist-progress','POST',{...update,itemId})));
    assert.deepEqual(results.map(result => result.status),[200,200]);
    const saved = (await Store.open(directory)).state.interactiveResourceProgress;
    assert.equal(saved.length,1); const record = saved[0]; assert.ok(record);
    assert.deepEqual(record.checkedItemIds,['alpha','beta','gamma']); assert.equal(record.revision,2);
    assert.equal(record.id,await interactiveResourceProgressId('checklist',initial.documentRevision));
    assert.equal((await request('/resources/checklist/checklist-progress','POST',update)).status,200);
    assert.deepEqual((await Store.open(directory)).state.interactiveResourceProgress,saved);
    assert.deepEqual((await preview('other')).checkedItemIds,['alpha']);
    assert.equal((await preview('other')).hasProgress,false);
    assert.equal((await request('/resources/checklist/checklist-progress','POST',{...update,itemId:'alpha',checked:false})).status,200);
    assert.deepEqual((await preview()).checkedItemIds,['beta','gamma']);

    const blockedSave = join(directory,'state.json.tmp');
    await mkdir(blockedSave);
    assert.equal((await request('/resources/checklist/archive','POST',{})).status,500);
    assert.deepEqual((await preview()).checkedItemIds,['beta','gamma']);
    assert.equal((await Store.open(directory)).state.resources.find(item => item.id === 'checklist')?.deletedAt,undefined);
    await rm(blockedSave,{recursive:true});
    assert.equal((await request('/resources/checklist/archive','POST',{})).status,200);
    assert.equal((await request('/resources/checklist/preview')).status,404);
    assert.equal((await request('/resources/checklist/checklist-progress','POST',update)).status,404);
    assert.equal((await fetch(initial.url)).status,404);
    const hidden = snapshotSchema.parse(await (await request('/state')).json());
    assert.equal(hidden.interactiveResourceProgress.length,0);
    assert.equal((await Store.open(directory)).state.interactiveResourceProgress.length,1);
    await mkdir(blockedSave);
    assert.equal((await request('/resources/checklist/restore','POST',{})).status,500);
    assert.equal((await request('/resources/checklist/preview')).status,404);
    await rm(blockedSave,{recursive:true});
    await service.close(); service = undefined;
    service = await createService({dataDir:directory,token:'checklist-test-token'});
    assert.equal((await request('/resources/checklist/restore','POST',{})).status,200);
    assert.deepEqual((await preview()).checkedItemIds,['beta','gamma']);
    assert.equal((await preview()).hasProgress,true);
    assert.equal(snapshotSchema.parse(await (await request('/state')).json()).interactiveResourceProgress.length,1);

    await service.close(); service = undefined;
    const revisedStore = await Store.open(directory);
    const resource = revisedStore.state.resources.find(item => item.id === 'checklist'); assert.ok(resource);
    resource.content += '<p>Revised content, same checklist IDs.</p>';
    await revisedStore.save();
    service = await createService({dataDir:directory,token:'checklist-test-token'});
    const revised = await preview();
    assert.notEqual(revised.documentRevision,initial.documentRevision);
    assert.equal(revised.hasProgress,false); assert.deepEqual(revised.checkedItemIds,['alpha']);
    assert.equal((await request('/resources/checklist/checklist-progress','POST',update)).status,409);
    const staleArtifact = new URL(initial.url); staleArtifact.port = String(service.port);
    assert.equal((await fetch(staleArtifact)).status,403);
    assert.equal((await fetch(revised.url)).status,200);
    assert.equal((await request('/resources/checklist/checklist-progress','POST',{...update,documentRevision:revised.documentRevision})).status,200);
    const revisions = (await Store.open(directory)).state.interactiveResourceProgress;
    assert.equal(revisions.length,2); assert.notEqual(revisions[0]?.id,revisions[1]?.id);
    assert.deepEqual(revisions.find(item => item.documentRevision === initial.documentRevision)?.checkedItemIds,['beta','gamma']);
  } finally {
    await service?.close();
    if (originalBinary === undefined) delete process.env.CENTRE_CODEX_BIN; else process.env.CENTRE_CODEX_BIN = originalBinary;
    await rm(directory,{recursive:true,force:true});
  }
});

test('real disk save failures roll back new and existing progress and allow queued retries',async () => {
  const directory = await mkdtemp(join(tmpdir(),'centre-checklist-failure-'));
  try {
    const store = await Store.open(directory); const resource = diagram();
    store.state.resources.push(resource); await store.save();
    const update = {documentRevision:checklistDocumentRevision(content),itemId:'beta',checked:true};
    const temporary = join(directory,'state.json.tmp');
    await mkdir(temporary);
    await assert.rejects(updateChecklistProgress(store,resource.id,update),{code:'EISDIR'});
    assert.equal(store.state.interactiveResourceProgress.length,0);
    assert.deepEqual((await Store.open(directory)).state.interactiveResourceProgress,[]);
    assert.deepEqual(checklistPreview(store,resource).checkedItemIds,['alpha']);
    await rm(temporary,{recursive:true});
    await updateChecklistProgress(store,resource.id,update);
    const before = structuredClone(store.state.interactiveResourceProgress);
    await mkdir(temporary);
    await assert.rejects(updateChecklistProgress(store,resource.id,{...update,itemId:'gamma'}),{code:'EISDIR'});
    assert.deepEqual(store.state.interactiveResourceProgress,before);
    assert.deepEqual((await Store.open(directory)).state.interactiveResourceProgress,before);
    await rm(temporary,{recursive:true});
    await updateChecklistProgress(store,resource.id,{...update,itemId:'gamma'});
    assert.equal(store.state.interactiveResourceProgress.length,1);
    assert.equal(store.state.interactiveResourceProgress[0]?.revision,2);
    assert.deepEqual((await Store.open(directory)).state.interactiveResourceProgress[0]?.checkedItemIds,['alpha','beta','gamma']);
    await Promise.all(['alpha','beta','gamma'].map(itemId => updateChecklistProgress(store,resource.id,{...update,itemId,checked:false})));
    const reopened = await Store.open(directory);
    assert.deepEqual(checklistPreview(reopened,resource).checkedItemIds,[]);
    assert.equal(checklistPreview(reopened,resource).hasProgress,true);
    const emptyProgress = structuredClone(reopened.state.interactiveResourceProgress);
    await updateChecklistProgress(store,resource.id,{...update,checked:false});
    assert.deepEqual((await Store.open(directory)).state.interactiveResourceProgress,emptyProgress);
  } finally { await rm(directory,{recursive:true,force:true}); }
});
