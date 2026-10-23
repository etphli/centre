import test from 'node:test';
import assert from 'node:assert/strict';
import { MobileStore, type Persistence, type PersistedMobileState } from './data/store';
test('the default browser fetch retains its global receiver', async()=>{
  let state:PersistedMobileState={schemaVersion:1,origin:'',revision:0,activeWorkspaceId:null,lastWorkspaceId:null,workspaces:{}};
  const persistence:Persistence={async read(){return structuredClone(state);},async transact(update){const next=update(structuredClone(state));state=next.state;return next.result;}};
  const original=globalThis.fetch;
  try {
    globalThis.fetch=async function(this:unknown){assert.equal(this,globalThis);return Response.json({token:'fixture-token',deviceId:crypto.randomUUID(),workspaceId:'fixture',expiresAt:new Date(Date.now()+60_000).toISOString()});};
    const store=new MobileStore({origin:'https://centre.example',persistence});
    await store.open();await store.pair('x'.repeat(64));
    assert.equal(store.getSnapshot().session?.workspaceId,'fixture');
  } finally {globalThis.fetch=original;}
});
