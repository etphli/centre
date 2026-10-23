import assert from 'node:assert/strict';
import test from 'node:test';
import { emptySnapshot } from './store';
import { applyStudyRecord, projectStudyData } from './cloud-projection';
import { cloudRecordSchema } from '../shared/cloud';
import { preferencesSchema } from '../shared/schema';

const record = (data: unknown) => cloudRecordSchema.parse({kind:'preferences',id:'preferences',schemaVersion:1,version:1,cursor:'1',deleted:false,updatedAt:'2026-10-23T00:00:00.000Z',data});
test('old preference projection preserves omitted fields, new full payload roundtrips and unknown keys reject',() => {
  const state = emptySnapshot();
  Object.assign(state.settings,{readingFont:'serif',defaultFlashcardCountMode:'fixed',defaultFlashcardCount:13,defaultQuizQuestions:19,chatModel:'local-only'});
  assert.equal(applyStudyRecord(state,record({theme:'light'})),true);
  assert.equal(state.settings.theme,'light');
  assert.equal(state.settings.readingFont,'serif');
  assert.equal(state.settings.defaultFlashcardCount,13);
  assert.equal(state.settings.defaultQuizQuestions,19);
  assert.equal(state.settings.chatModel,'local-only');
  const before = structuredClone(state);
  assert.throws(() => applyStudyRecord(state,record({theme:'dark',futureSetting:true})));
  assert.deepEqual(state,before);
  assert.throws(() => applyStudyRecord(state,record({defaultFlashcardCount:0})));
  const outgoing = projectStudyData(state).find(row => row.kind === 'preferences');
  assert.ok(outgoing);
  const fresh = emptySnapshot();
  applyStudyRecord(fresh,record(outgoing.data));
  assert.deepEqual(preferencesSchema.parse(fresh.settings),preferencesSchema.parse(state.settings));
  applyStudyRecord(state,record(preferencesSchema.parse({})));
  assert.deepEqual(preferencesSchema.parse(state.settings),preferencesSchema.parse({}));
  assert.equal(state.settings.chatModel,'local-only');
});

test('empty preferences payload retains existing values and defaults on a fresh replica',() => {
  const state = emptySnapshot();
  state.settings.readingWidth = 'wide';
  applyStudyRecord(state,record({}));
  assert.equal(state.settings.readingWidth,'wide');
  const fresh = emptySnapshot();
  applyStudyRecord(fresh,record({}));
  assert.deepEqual(preferencesSchema.parse(fresh.settings),preferencesSchema.parse({}));
});
