import assert from 'node:assert/strict';
import test from 'node:test';
import { createCloudTestHarness as harness } from './test-support';
import { cloudRecordSchema, type CloudMutation } from '../shared/cloud';
import { preferencesSchema } from '../shared/schema';
import { emptySnapshot } from '../server/store';
import { applyStudyRecord, projectStudyData } from '../server/cloud-projection';

const mutation = (expectedVersion: number, data: CloudMutation['data']): CloudMutation => ({mutationId:crypto.randomUUID(),kind:'preferences',id:'preferences',schemaVersion:1,expectedVersion,deleted:false,data});
test('real worker retains omitted preferences, roundtrips projection, and preserves strict CAS and retry receipts',async () => {
  const h = await harness();
  const token = String((await h.login('alice')).token);
  const post = (m: CloudMutation) => h.call('/v1/records','POST',m,token);
  const first = await post(mutation(0,{readingFont:'serif',defaultFlashcardCountMode:'fixed',defaultFlashcardCount:13}));
  assert.equal(first.status,200);
  const old = mutation(1,{theme:'light',nickname:'Older client'});
  const updated = await post(old);
  assert.equal(updated.status,200);
  const accepted = cloudRecordSchema.parse(updated.value.record);
  assert.equal(accepted.data?.readingFont,'serif');
  assert.equal(accepted.data?.defaultFlashcardCount,13);
  assert.equal(accepted.data?.theme,'light');
  assert.equal((await post(mutation(1,{readingFont:'sans'}))).status,409);
  assert.equal((await post(mutation(2,{futureSetting:true}))).status,400);
  assert.equal((await post(mutation(2,{defaultFlashcardCount:0}))).status,400);
  assert.deepEqual(await post(old),updated);
  assert.equal((await post({...old,data:{theme:'dark'}})).status,409);
  const state = emptySnapshot();
  applyStudyRecord(state,accepted);
  const projected = projectStudyData(state).find(row => row.kind === 'preferences');
  assert.ok(projected);
  const roundtrip = await post(mutation(2,projected.data));
  assert.equal(roundtrip.status,200);
  assert.deepEqual(cloudRecordSchema.parse(roundtrip.value.record).data,preferencesSchema.parse(state.settings));
  const cleared = await post(mutation(3,preferencesSchema.parse({})));
  assert.equal(cleared.status,200);
  assert.deepEqual(cloudRecordSchema.parse(cleared.value.record).data,preferencesSchema.parse({}));
  h.db.sqlite.close();
});

test('missing preferences initialize defaults and a race after merge still conflicts in the transaction',async () => {
  const h = await harness();
  const token = String((await h.login('alice')).token);
  const post = (m: CloudMutation) => h.call('/v1/records','POST',m,token);
  const first = await post(mutation(0,{}));
  assert.equal(first.status,200);
  assert.deepEqual(cloudRecordSchema.parse(first.value.record).data,preferencesSchema.parse({}));
  const batch = h.db.batch.bind(h.db);
  let race = true;
  h.db.batch = async statements => {
    if (race) {
      race = false;
      assert.equal((await post(mutation(1,{readingFont:'serif',defaultFlashcardCount:13}))).status,200);
    }
    return batch(statements);
  };
  assert.equal((await post(mutation(1,{theme:'light'}))).status,409);
  const latest = await post(mutation(2,{}));
  assert.equal(latest.status,200);
  const data = cloudRecordSchema.parse(latest.value.record).data;
  assert.equal(data?.theme,'dark');
  assert.equal(data?.readingFont,'serif');
  assert.equal(data?.defaultFlashcardCount,13);
  h.db.sqlite.close();
});
