import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { handleAiRequest } from '../cloud-ai/index.ts';

// Runs the real database-owner authentication/router/entity store with isolated SQLite.
// Google keys and inference below are explicit fixtures. No deployed service is contacted.
const index=process.argv.indexOf('--database-checkout');
assert.ok(index>=0 && process.argv[index+1], 'Pass --database-checkout /path/to/database-feature-checkout');
const checkout=resolve(process.argv[index+1]);
const {createCloudTestHarness}=await import(pathToFileURL(join(checkout,'cloud/test-support.ts')).href);
const calendarIndex=process.argv.indexOf('--calendar-checkout');
const calendarCheckout=calendarIndex<0 ? null : resolve(process.argv[calendarIndex+1] ?? '');
assert.ok(calendarIndex<0 || process.argv[calendarIndex+1], 'Pass --calendar-checkout /path/to/calendar-feature-checkout');
let organato;
let upstream;
let calendarSupport;
if(calendarCheckout) {
 try {
  organato=await import(pathToFileURL(join(calendarCheckout,'cloud-organato/index.ts')).href);
  calendarSupport=await import(pathToFileURL(join(calendarCheckout,'cloud-organato/test-support.ts')).href);
 } catch(cause) { throw new Error('Calendar integration dependency unavailable. Install dependencies in --calendar-checkout before running.',{cause}); }
 upstream=new calendarSupport.Fixture();
}
const fixture=await createCloudTestHarness({extension:async(request,context)=>{
 const ai=await handleAiRequest(request,context);
 return ai ?? (organato ? await organato.handleOrganatoRequest(request,context) : null);
}});
const originalFetch=globalThis.fetch;
if(upstream) {
 for(const name of readdirSync(join(calendarCheckout,'cloud-organato/migrations')).filter(name=>name.endsWith('.sql')).sort()) fixture.db.sqlite.exec(readFileSync(join(calendarCheckout,'cloud-organato/migrations',name),'utf8'));
 fixture.env.ORGANATO_ENCRYPTION_KEYS_JSON=JSON.stringify(upstream.keys);
 fixture.env.ORGANATO_KEY_VERSION='v1';
 fixture.env.ORGANATO_ALLOWED_ORIGINS='https://organato.test';
 globalThis.fetch=upstream.fetch;
}
try {
for(const name of readdirSync('cloud-ai/migrations').filter(name=>name.endsWith('.sql')).sort()) fixture.db.sqlite.exec(readFileSync(join('cloud-ai/migrations',name),'utf8'));
let calls=0;let observed=[];
fixture.env.AI={async run(model,input){calls++;observed.push(input.messages);assert.equal(model,'@cf/meta/llama-3.1-8b-instruct-fp8');return {response:'Local inference fixture. No hosted AI was called.'};}};
const alice=await fixture.login('alice'),bob=await fixture.login('bob');
const now=new Date().toISOString(),chatId=randomUUID(),messageId=randomUUID();
const write=async(kind,id,data,token=alice.token,expectedVersion=0)=>{
 const result=await fixture.call('/v1/records','POST',{mutationId:randomUUID(),kind,id,schemaVersion:1,expectedVersion,deleted:false,data},token);
 assert.equal(result.status,200,JSON.stringify(result.value));return result.value.record;
};
await write('chat',chatId,{id:chatId,title:'Independent mobile chat',createdAt:now,updatedAt:now,deletedAt:null,pinnedAt:null,folderId:null,sortOrder:0,modelSelection:null,lineage:{schemaVersion:1,kind:'root'}});
const message=(id,role,content,time=now)=>({id,chatId,role,content,createdAt:time,responseDurationMs:null,resourceIds:[],attachmentIds:[],requestContext:{page:'chat'}});
await write('message',messageId,message(messageId,'user','Explain mitochondria.'));
const request={id:randomUUID(),chatId,messageId};
assert.equal((await fixture.call('/v1/ai/runs','POST',request)).status,401);
assert.equal((await fixture.call('/v1/ai/runs','POST',request,bob.token)).status,404);
const first=await fixture.call('/v1/ai/runs','POST',request,alice.token);
assert.equal(first.status,200,JSON.stringify(first.value));assert.equal(first.value.run.status,'completed');
assert.equal((await fixture.call('/v1/ai/runs','POST',request,alice.token)).value.run.status,'completed');assert.equal(calls,1);
assert.equal((await fixture.call(`/v1/ai/runs/${request.id}`,'GET',undefined,bob.token)).status,404);
const followupId=randomUUID();await write('message',followupId,message(followupId,'user','Explain that more simply.',new Date(Date.now()+1000).toISOString()));
assert.equal((await fixture.call('/v1/ai/runs','POST',{id:randomUUID(),chatId,messageId:followupId},alice.token)).value.run.status,'completed');
assert.ok(observed[1].some(item=>item.role==='assistant' && item.content.includes('Local inference fixture')),'Server must load bounded saved history');
const pairing=await fixture.call('/v1/pairings','POST',{},alice.token);assert.equal(pairing.status,200);
const paired=await fixture.call('/v1/auth/pair','POST',{code:pairing.value.code,deviceName:'Mobile integration fixture'});assert.equal(paired.status,200);assert.equal(paired.value.workspaceId,alice.workspaceId);
assert.notEqual((await fixture.call('/v1/auth/pair','POST',{code:pairing.value.code,deviceName:'Replay'})).status,200);
const resourceId=randomUUID(),draftId=randomUUID();
await write('resource',resourceId,{id:resourceId,subjectId:null,topicId:null,title:'Objective quiz',kind:'quiz',createdAt:now,updatedAt:now,content:'',questions:[{id:'q1',responseType:'multiple_choice',choices:['A','B'],prompt:'Choose A',answer:'A',explanation:'A is correct.',marks:1}]});
await write('practice.draft',draftId,{schemaVersion:1,id:draftId,revision:1,resourceId,answers:{q1:'B'},currentQuestion:0,createdAt:now,updatedAt:now,deletedAt:null});
const grade={id:randomUUID(),resourceId,draftId,expectedDraftRevision:1};
const marked=await fixture.call('/v1/ai/grades','POST',grade,paired.value.token);assert.equal(marked.status,200,JSON.stringify(marked.value));assert.equal(marked.value.status,'completed');assert.equal(marked.value.attempt.result.score,0);
const replay=await fixture.call('/v1/ai/grades','POST',{...grade,id:randomUUID()},alice.token);assert.equal(replay.value.attempt.id,marked.value.attempt.id);assert.equal(calls,2,'Objective grading must not call inference');
const changes=await fixture.call('/v1/changes?cursor=0&limit=100','GET',undefined,alice.token);assert.equal(changes.status,200);
assert.equal(changes.value.records.filter(record=>record.kind==='practice.attempt').length,1);
assert.equal(changes.value.records.find(record=>record.kind==='practice.draft').data.deletedAt!==null,true);
assert.equal(changes.value.records.filter(record=>record.kind==='practice.learningNeed').length,1);
assert.equal((await fixture.call('/v1/changes?cursor=0&limit=100','GET',undefined,bob.token)).value.records.length,0);
// Attachment bytes use the real central routes and real entity ownership checks.
{
const chatId=randomUUID();
await write('chat',chatId,{id:chatId,title:'Attachment parent fixture',createdAt:now,updatedAt:now,deletedAt:null,lineage:{schemaVersion:1,kind:'root'}});
const message=(id,role,content,time=now)=>({id,chatId,role,content,createdAt:time,responseDurationMs:null,resourceIds:[],attachmentIds:[],requestContext:{page:'chat'}});
const attachmentId=randomUUID(),attachmentMessageId=randomUUID();
await write('message',attachmentMessageId,{...message(attachmentMessageId,'user','Attached local fixture'),attachmentIds:[attachmentId]});
const bytes='local attachment fixture';
const digest=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(bytes))).toString('hex');
const attachmentPath=`/v1/attachments/${attachmentId}`;
const metadata={name:'fixture.txt',mimeType:'text/plain',size:Buffer.byteLength(bytes),sha256:digest,sourceChatId:chatId,chatId};
assert.equal((await fixture.call(attachmentPath,'PUT',metadata,alice.token)).status,200);
assert.equal((await fixture.call(`${attachmentPath}/chunks/0`,'PUT',{data:Buffer.from(bytes).toString('base64')},alice.token)).status,200);
assert.equal((await fixture.call(`${attachmentPath}/complete`,'POST',{mutationId:randomUUID()},alice.token)).status,200);
assert.equal((await fixture.call(`${attachmentPath}?chatId=${chatId}`,'GET',undefined,alice.token)).status,200);
assert.equal(Buffer.from((await fixture.call(`${attachmentPath}/chunks/0?chatId=${chatId}`,'GET',undefined,alice.token)).value.data,'base64').toString(),bytes);
assert.equal((await fixture.call(`${attachmentPath}?chatId=${chatId}`,'GET',undefined,bob.token)).status,404);
const wrongChatId=randomUUID(),childChatId=randomUUID(),checkpointId=randomUUID();
const chatData=(id,title,lineage={schemaVersion:1,kind:'root'})=>({id,title,createdAt:now,updatedAt:now,deletedAt:null,pinnedAt:null,folderId:null,sortOrder:0,modelSelection:null,lineage});
await write('chat',wrongChatId,chatData(wrongChatId,'Unrelated target'));
assert.equal((await fixture.call(`${attachmentPath}?chatId=${wrongChatId}`,'GET',undefined,alice.token)).status,404);
await write('message',checkpointId,message(checkpointId,'assistant','Branch checkpoint.',new Date(Date.now()+2000).toISOString()));
await write('chat',childChatId,chatData(childChatId,'Inherited attachment branch',{schemaVersion:1,kind:'branch',operation:'continue',parentChatId:chatId,sourceMessageId:checkpointId,checkpointMessageId:checkpointId,promptMessageId:null}));
const childMessageId=randomUUID();await write('message',childMessageId,{...message(childMessageId,'user','Attached local fixture'),chatId:childChatId,attachmentIds:[attachmentId]});
const childCheckpointId=randomUUID();await write('message',childCheckpointId,{...message(childCheckpointId,'assistant','Branch checkpoint.',new Date(Date.now()+2000).toISOString()),chatId:childChatId});
await write('chat',chatId,{...chatData(chatId,'Archived attachment ancestor'),deletedAt:now},alice.token,1);
assert.equal((await fixture.call(`${attachmentPath}?chatId=${chatId}`,'GET',undefined,alice.token)).status,404);
assert.equal((await fixture.call(`${attachmentPath}?chatId=${childChatId}`,'GET',undefined,alice.token)).status,200);
assert.equal(Buffer.from((await fixture.call(`${attachmentPath}/chunks/0?chatId=${childChatId}`,'GET',undefined,alice.token)).value.data,'base64').toString(),bytes);
}
let calendarReport='SKIP Organato integration: --calendar-checkout was not supplied.';
if(upstream) {
 const calendarCall=(path,method='GET',payload,token=alice.token)=>fixture.call(`/v1/organato${path}`,method,payload,token);
 const noSecret=value=>{
  const text=JSON.stringify(value);
  for(const secret of [upstream.token,...Object.values(upstream.keys)]) assert.equal(text.includes(secret),false,'Secrets must not appear in public responses or persisted plaintext');
 };
 assert.equal((await calendarCall('/connection','GET',undefined,null)).status,401);
 const provisioned=await calendarCall('/connection','POST',{apiKey:upstream.token,baseUrl:'https://organato.test/api/v1'});
 assert.equal(provisioned.status,200,JSON.stringify(provisioned.value));noSecret(provisioned);
 const connection=fixture.db.sqlite.prepare('SELECT * FROM centre_organato_connections WHERE workspace_id=?').get(alice.workspaceId);
 assert.equal(connection.key_version,'v1');noSecret(connection);assert.notEqual(connection.ciphertext,upstream.token);
 const plaintext=await crypto.subtle.decrypt({name:'AES-GCM',iv:Buffer.from(connection.iv,'base64'),additionalData:new TextEncoder().encode(JSON.stringify([alice.workspaceId,connection.connection_id,connection.base_url,connection.key_version]))},await crypto.subtle.importKey('raw',Buffer.from(upstream.keys.v1,'base64'),'AES-GCM',false,['decrypt']),Buffer.from(connection.ciphertext,'base64'));
 assert.equal(new TextDecoder().decode(plaintext),upstream.token);
 assert.equal((await calendarCall('/connection','GET',undefined,bob.token)).value.state,'unconfigured');
 upstream.items.set('imported-todo',calendarSupport.remoteItem());
 upstream.items.set('assignment',calendarSupport.remoteItem({id:'assignment',kind:'work',version:19,calendarEnabled:false}));
 const snapshot=await calendarCall('/snapshot');assert.equal(snapshot.status,200,JSON.stringify(snapshot.value));noSecret(snapshot);
 assert.equal(snapshot.value.subjects[0].id,'math');
 assert.equal(snapshot.value.assignments.find(item=>item.id==='assignment').version,19);
 assert.equal(snapshot.value.events.find(item=>item.id==='imported-todo').organatoVersion,7);
 assert.equal(upstream.externalWrites().length,0);
 const data=calendarSupport.session(),operationId=randomUUID(),create={operationId,id:data.id,data};
 const created=await calendarCall('/sessions','POST',create);assert.equal(created.status,200,JSON.stringify(created.value));assert.equal(created.value.status,'succeeded');assert.equal(created.value.record.version,1);assert.equal(created.value.event.id,data.id);noSecret(created);
 assert.deepEqual(await calendarCall('/sessions','POST',create),created);assert.equal(upstream.externalWrites().length,1);
 assert.equal((await calendarCall(`/operations/${operationId}`)).value.status,'succeeded');
 assert.equal((await calendarCall(`/operations/${operationId}`,'GET',undefined,bob.token)).status,404);
 const complete={operationId:randomUUID(),expectedVersion:created.value.record.version,expectedRevision:created.value.event.revision,completed:true};
 const completed=await calendarCall(`/sessions/${data.id}/complete`,'POST',complete);assert.equal(completed.status,200,JSON.stringify(completed.value));assert.ok(completed.value.event.completedAt);assert.equal(completed.value.record.version,2);assert.equal(completed.value.event.revision,2);
 assert.deepEqual(await calendarCall(`/sessions/${data.id}/complete`,'POST',complete),completed);
 assert.equal((await calendarCall(`/sessions/${data.id}/complete`,'POST',{...complete,operationId:randomUUID()})).status,409);
 assert.equal(upstream.externalWrites().length,2,'CAS rejection and receipt replay cannot issue upstream writes');
 const lostData=calendarSupport.session(),lostId=randomUUID(),lostRequest={operationId:lostId,id:lostData.id,data:lostData};
 let lostRemoteId;
 upstream.intercept=async remoteRequest=>{
  if(remoteRequest.method==='GET')return null;
  const body=await remoteRequest.clone().json();lostRemoteId='lost-ack-remote';
  upstream.items.set(lostRemoteId,calendarSupport.remoteItem({...body,id:lostRemoteId,version:1}));
  throw new TypeError('Simulated upstream commit with lost acknowledgement');
 };
 const unknown=await calendarCall('/sessions','POST',lostRequest);assert.equal(unknown.status,202,JSON.stringify(unknown.value));assert.equal(unknown.value.status,'unknown');assert.equal(unknown.value.reconciliationRequired,true);noSecret(unknown);
 upstream.intercept=null;
 assert.deepEqual(await calendarCall('/sessions','POST',lostRequest),unknown);
 assert.equal((await calendarCall('/sessions','POST',{...lostRequest,operationId:randomUUID()})).status,409);
 assert.equal((await calendarCall(`/operations/${lostId}`)).value.status,'unknown');
 await calendarCall('/snapshot');assert.equal((await calendarCall(`/operations/${lostId}`)).value.status,'unknown','Snapshot cannot auto-reconcile unknown writes');
 assert.equal(upstream.externalWrites().length,3);
 const reconciled=await calendarCall(`/operations/${lostId}/reconcile`,'POST',{resolution:'applied',organatoId:lostRemoteId});assert.equal(reconciled.status,200,JSON.stringify(reconciled.value));assert.equal(reconciled.value.status,'succeeded');assert.equal(reconciled.value.event.id,lostData.id);
 assert.equal(upstream.externalWrites().length,3,'Explicit read-only reconciliation cannot repeat an upstream write');
 assert.equal((await calendarCall('/sessions','POST',lostRequest)).value.status,'succeeded');
 noSecret(await calendarCall(`/operations/${lostId}`));
 calendarReport=`PASS actual authenticated Organato hook: encrypted connection, workspace isolation, snapshot, create/receipt replay, completion CAS, unknown lost-ACK replay prevention and explicit read-only reconciliation. Simulated upstream writes: ${upstream.externalWrites().length}.`;
}
process.stdout.write(`PASS actual Centre Worker auth/router + two-workspace data isolation + one-use pairing + durable chat/history retry + atomic quiz/draft/evidence commit + attachment upload/scoped reads/inherited archived ancestor. Inference fixture calls: ${calls}.\n${calendarReport}\nGoogle identity, inference and Organato upstream were simulated; no production or hosted-provider verification. Desktop service was not used.\n`);
} finally {
 globalThis.fetch=originalFetch;
 upstream?.db.close();
 fixture.db.sqlite.close();
}
