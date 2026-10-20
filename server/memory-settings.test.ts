import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assistantMemorySchema, snapshotSchema } from '../shared/schema';
import { proxyRequest } from '../electron/proxy';
import { createService } from './index';
import { remember } from './assistant-memory';
import { Store } from './store';

test('memory settings edits and forgetting work through desktop IPC and survive restarts', async () => {
  const directory = await mkdtemp(join(tmpdir(),'centre-memory-settings-'));
  const store = await Store.open(directory);
  const memory = await remember(store,{ key:'learning.examples',content:'Use pictures.' });
  const other = await remember(store,{ key:'study.goal',content:'Practise fractions.' });
  let service = await createService({ dataDir:directory });
  const request = (id:string, content:unknown, token = service.token) => fetch(`http://127.0.0.1:${service.port}/api/assistant-memories/${id}`,{
    method:'PATCH', headers:{ authorization:`Bearer ${token}`,'content-type':'application/json' }, body:JSON.stringify(content),
  });
  try {
    assert.equal((await request(memory.id,{content:'Unauthorized change'},'invalid')).status,401);
    for (const input of [{content:'   '},{content:'x'.repeat(1001)},{content:'Changed',key:other.key},{content:42}]) {
      assert.equal((await request(memory.id,input)).status,400);
    }
    assert.equal((await request('invalid-id',{content:'Changed'})).status,400);
    assert.equal((await request(randomUUID(),{content:'Changed'})).status,404);
    const updated = assistantMemorySchema.parse(await proxyRequest(service,'PATCH',`/assistant-memories/${memory.id}`,{ content:'  Use worked examples.  ' }));
    assert.equal(updated.id,memory.id);
    assert.equal(updated.key,memory.key);
    assert.equal(updated.createdAt,memory.createdAt);
    assert.equal(updated.content,'Use worked examples.');
    await service.close();
    service = await createService({ dataDir:directory });
    let state = snapshotSchema.parse(await proxyRequest(service,'GET','/state',undefined));
    assert.deepEqual(state.assistantMemories,[updated,other]);
    await proxyRequest(service,'POST',`/assistant-memories/${memory.id}/forget`,{});
    assert.equal((await request(memory.id,{content:'Must not recreate a forgotten fact'})).status,404);
    await assert.rejects(proxyRequest(service,'POST',`/assistant-memories/${memory.id}/forget`,{}),/not found/);
    await service.close();
    service = await createService({ dataDir:directory });
    state = snapshotSchema.parse(await proxyRequest(service,'GET','/state',undefined));
    assert.deepEqual(state.assistantMemories,[other]);
  } finally {
    await service.close();
    await rm(directory,{ recursive:true,force:true });
  }
});
