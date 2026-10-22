import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir,mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resourceSchema,snapshotSchema } from '../shared/schema';
import { createService } from './index';
import { Store } from './store';
import { Resources } from './resources';
import { Codex } from './codex';

test('a failed disk save leaves no resource behind and a retry saves exactly one',async () => {
  const directory = await mkdtemp(join(tmpdir(),'centre-resource-disk-failure-'));
  const store = await Store.open(directory);
  const codex = new Codex(directory,[],async () => undefined);
  const resources = new Resources(store,codex);
  const input = {kind:'notes',subjectId:null,topicId:null,instructions:'',difficulty:'standard'} as const;
  const generated = {title:'Circuits',content:'A closed circuit carries current.',questions:[]};
  try {
    await store.save();
    await mkdir(join(directory,'state.json.tmp'));
    await assert.rejects(resources.saveGenerated(input,generated),{code:'EISDIR'});
    assert.equal(store.state.resources.length,0);
    assert.equal((await Store.open(directory)).state.resources.length,0);
    await rm(join(directory,'state.json.tmp'),{recursive:true});
    await resources.saveGenerated(input,generated);
    assert.equal((await Store.open(directory)).state.resources.length,1);
  } finally { await codex.close(); await rm(directory,{recursive:true,force:true}); }
});

test('personal resources save, export, move into subjects and delete with recoverable history',async () => {
  const directory = await mkdtemp(join(tmpdir(),'centre-resource-lifecycle-'));
  const original = process.env.CENTRE_CODEX_BIN; process.env.CENTRE_CODEX_BIN = '/centre-test/no-codex';
  const store = await Store.open(directory);
  const codex = new Codex(directory,[],async () => undefined);
  const resources = new Resources(store,codex);
  let service:Awaited<ReturnType<typeof createService>>|undefined;
  try {
    const diagram = await resources.saveGenerated({kind:'diagram',subjectId:null,topicId:null,instructions:'Learn about coffee.',difficulty:'standard'},{title:'Coffee extraction',content:'<h1>Coffee</h1><button>Explore</button>',questions:[]});
    assert.equal(diagram.subjectId,null); assert.match(resources.export(diagram.id).content,/Coffee/);
    const quiz = await resources.saveGenerated({kind:'quiz',subjectId:null,topicId:null,instructions:'',difficulty:'standard',questionCount:1,questionTypes:['short_response']},{title:'Coffee quiz',content:'',questions:[{prompt:'What changes extraction?',answer:'Grind size.',explanation:'Surface area.',responseType:'short_response',choices:[],marks:1}]});
    await resources.feedback(quiz.id,'Review extraction.',[],false);
    assert.equal(store.state.memories[0]?.subjectId,null);
    await assert.rejects(resources.saveGenerated({kind:'diagram',subjectId:'missing',topicId:null,instructions:'',difficulty:'standard'},{title:'Invalid',content:'<p>Invalid</p>',questions:[]}),/together/);
    store.state.subjects.push({id:'science',name:'Science',shortName:null,color:'#fff',icon:'book'});
    store.state.topics.push({id:'extraction',subjectId:'science',name:'Extraction',description:''});
    await resources.relocate(quiz.id,{subjectId:'science',topicId:'extraction'});
    assert.equal(store.state.memories[0]?.subjectId,'science');
    await resources.relocate(quiz.id,{subjectId:null,topicId:null});
    await store.save(); await codex.close();
    service = await createService({dataDir:directory});
    const request = async (path:string,method = 'GET',body?:unknown) => {
      assert.ok(service);
      const response = await fetch(`http://127.0.0.1:${service.port}/api${path}`,{method,headers:{Authorization:`Bearer ${service.token}`,'Content-Type':'application/json'},...(body === undefined ? {} : {body:JSON.stringify(body)})});
      return {status:response.status,body:await response.json()};
    };
    assert.equal((await request(`/resources/${quiz.id}/archive`,'POST',{})).status,200);
    assert.equal((await request(`/resources/${quiz.id}/archive`,'POST',{})).status,200);
    const hidden = snapshotSchema.parse((await request('/state')).body);
    assert.equal(hidden.resources.some(resource => resource.id === quiz.id),false); assert.equal(hidden.memories.length,0);
    assert.equal((await request(`/resources/${quiz.id}/export`)).status,404);
    assert.equal((await request(`/resources/${quiz.id}/restore`,'POST',{})).status,200);
    const restored = snapshotSchema.parse((await request('/state')).body);
    assert.equal(restored.memories.length,1); assert.equal(resourceSchema.parse(restored.resources.find(resource => resource.id === quiz.id)).subjectId,null);
    const reopened = await Store.open(directory); assert.equal(reopened.state.resources.length,2); assert.equal(reopened.state.memories.length,1);
  } finally {
    await service?.close(); await codex.close();
    if (original === undefined) delete process.env.CENTRE_CODEX_BIN; else process.env.CENTRE_CODEX_BIN = original;
    await rm(directory,{recursive:true,force:true});
  }
});
