import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Organato } from './organato';
import { Store } from './store';
import { Credentials } from './credentials';
import { assignmentNotificationContext } from '../shared/notification-context';
import { projectStudyData } from './cloud-projection';
import { parseCloudEntity } from '../shared/cloud-entities';

test('notification sync downloads readable resources, refreshes without duplicates, preserves cached failures and deletion',async () => {
  const directory = await mkdtemp(join(tmpdir(),'centre-notifications-'));
  const previousKey = process.env.ORGANATO_API_KEY;
  process.env.ORGANATO_API_KEY = 'org_fixture_notification';
  let fail = false; let text = 'Exam on ecosystems. Bring a ruler.'; let brief = true;
  const upstream = createServer((request,response) => {
    assert.equal(request.headers.authorization,'Bearer org_fixture_notification');
    const path = new URL(request.url ?? '/','http://localhost').pathname;
    if (path.endsWith('/file')) {
      if (fail) { response.writeHead(503).end(); return; }
      response.setHeader('Content-Type','text/plain'); response.setHeader('Content-Disposition','attachment; filename="notice.txt"'); response.end(text); return;
    }
    response.setHeader('Content-Type','application/json');
    if (path.endsWith('/subjects')) response.end(JSON.stringify({subjects:[{id:'science',displayName:'Science',shortName:'Science',colour:'#fff',active:true}]}));
    else response.end(JSON.stringify({items:[{id:'assignment',displayName:'Ecosystems assessment',kind:'work',subjectId:'science',dueDateLocal:'2026-11-05',dueAt:null,workingStatus:'not_started',version:1,attachments:[{id:'notice',label:'Assessment notification',url:'kv://private-notice',linkType:brief ? 'brief' : 'reference',createdAt:'2026-10-30T00:00:00Z'}]}],nextCursor:null}));
  });
  await new Promise<void>(resolve => upstream.listen(0,'127.0.0.1',resolve));
  const address = upstream.address(); assert.ok(address && typeof address !== 'string');
  try {
    const store = await Store.open(directory);
    store.state.settings.organatoBaseUrl = `http://127.0.0.1:${address.port}/api/v1`;
    const organato = new Organato(store,new Credentials(directory));
    brief = false; await organato.sync(); assert.equal(store.state.resources.length,0);
    brief = true; await organato.sync(); assert.equal(store.state.resources.length,1);
    const resource = store.state.resources[0]; assert.ok(resource.notification); assert.equal(resource.kind,'notes'); assert.equal(resource.content,text); assert.equal(resource.notification.itemId,'assignment');
    resource.updatedAt = '2026-10-01T00:00:00Z'; await organato.sync(); assert.equal(resource.updatedAt,'2026-10-01T00:00:00Z');
    text = 'Updated exam. Bring a calculator.'; await organato.sync(); assert.equal(store.state.resources.length,1); assert.equal(resource.content,text);
    const context = assignmentNotificationContext(store.state,'help with my Science assignment');
    assert.equal(context[0]?.untrustedContent,text);
    assert.equal(assignmentNotificationContext(store.state,'help with Geography').length,0);
    assert.equal(assignmentNotificationContext(store.state,'help with ecosystems')[0]?.id,resource.id);
    assert.equal(assignmentNotificationContext(store.state,'show my notifications')[0]?.id,resource.id);
    assert.equal(assignmentNotificationContext(store.state,'Ecosystems assessment')[0]?.id,resource.id);
    const projected = projectStudyData(store.state).find(row => row.kind === 'resource'); assert.ok(projected);
    assert.deepEqual(parseCloudEntity('resource',projected.data).notification,resource.notification);
    fail = true; await organato.sync(); assert.equal(resource.content,text); assert.match(store.state.syncError ?? '',/HTTP 503/);
    const reopened = await Store.open(directory); assert.equal(reopened.state.resources[0].content,text);
    resource.deletedAt = new Date().toISOString(); await organato.sync(); assert.ok(resource.deletedAt);
    assert.equal(assignmentNotificationContext(store.state,'Science').length,0);
  } finally {
    if (previousKey === undefined) delete process.env.ORGANATO_API_KEY; else process.env.ORGANATO_API_KEY = previousKey;
    await new Promise<void>((resolve,reject) => upstream.close(error => error ? reject(error) : resolve()));
    await rm(directory,{recursive:true,force:true});
  }
});

test('chat supplies assignment notification text and returns the existing reader resource',async () => {
  const {writeFile} = await import('node:fs/promises');
  const {createService} = await import('./index');
  const {resourceSchema,chatSchema} = await import('../shared/schema');
  const directory = await mkdtemp(join(tmpdir(),'centre-notice-chat-'));
  const previousBinary = process.env.CENTRE_CODEX_BIN;
  const binary = join(directory,'fixture-codex');
  await writeFile(binary,`#!/usr/bin/env node
const readline=require('node:readline');
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{
const message=JSON.parse(line);if(!message.id)return;
let result={};
if(message.method==='account/read')result={account:{id:'fixture'}};
if(message.method==='model/list')result={data:[{model:'gpt-6.1-sol',displayName:'Sol',supportedReasoningEfforts:[{reasoningEffort:'medium'}],defaultReasoningEffort:'medium'}],nextCursor:null};
if(message.method==='thread/start')result={thread:{id:'fixture-thread'}};
send({id:message.id,result});
if(message.method==='turn/start'){
const prompt=message.params.input[0].text;
const found=prompt.includes('SOURCE_NOTICE_BRING_RULER')&&prompt.includes('assignmentNotifications')&&prompt.includes('untrustedContent');
send({method:'item/completed',params:{threadId:message.params.threadId,item:{id:'answer',type:'agentMessage',phase:'final_answer',text:JSON.stringify({response:{kind:'message',content:found?'Notice included':'Notice missing',resourceIds:found?['notice']:[]}})}}});
send({method:'turn/completed',params:{threadId:message.params.threadId,turn:{status:'completed'}}});
}});
`,{mode:0o700});
  process.env.CENTRE_CODEX_BIN = binary;
  const store = await Store.open(directory); const now = new Date().toISOString();
  store.state.resources.push(resourceSchema.parse({id:'notice',kind:'notes',subjectId:null,topicId:null,title:'Ecosystems assessment notification',content:'SOURCE_NOTICE_BRING_RULER',createdAt:now,updatedAt:now,notification:{itemId:'ecosystems',attachmentId:'attachment',fileName:'notice.txt',contentType:'text/plain',downloadPath:'/attachments/attachment/file'}}));
  store.state.assignments.push({id:'ecosystems',title:'Ecosystems assessment',kind:'work',subjectId:null,dueDate:null,status:'not_started',version:1}); await store.save();
  const service = await createService({dataDir:directory});
  const request = async (path:string,body:unknown) => {
    const response = await fetch(`http://127.0.0.1:${service.port}/api${path}`,{method:'POST',headers:{Authorization:`Bearer ${service.token}`,'Content-Type':'application/json'},body:JSON.stringify(body)});
    const result = await response.json(); assert.equal(response.status,200,JSON.stringify(result)); return result;
  };
  try {
    const chat = chatSchema.parse(await request('/chats',{}));
    const result = chatSchema.parse(await request(`/chats/${chat.id}/messages`,{content:'Show the ecosystems notification',context:{page:'chat'}}));
    assert.equal(result.messages.at(-1)?.content,'Notice included');
    assert.deepEqual(result.messages.at(-1)?.resourceIds,['notice']);
  } finally {
    await service.close();
    if(previousBinary===undefined)delete process.env.CENTRE_CODEX_BIN;else process.env.CENTRE_CODEX_BIN=previousBinary;
    await rm(directory,{recursive:true,force:true});
  }
});
