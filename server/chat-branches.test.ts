import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chatSchema, messageSchema, type Chat, type Message } from '../shared/schema';
import { projectChatForSync, projectMessageForSync, syncedChatSchema, syncedMessageSchema } from '../shared/chat-sync';
import { createChatBranch, branchInputSchema } from './chat-branches';
import { Store, emptySnapshot } from './store';

const now = '2026-10-22T00:00:00.000Z';
const attachmentId = 'd07295d1-bb3f-4c1d-af2a-d05b624a8770';
function message(id: string, role: Message['role'], fields: Partial<Message> = {}): Message {
  return messageSchema.parse({ id, role, content:id, createdAt:now, ...fields });
}
function parent(): Chat {
  return chatSchema.parse({
    id:'parent', title:'Biology', createdAt:now, updatedAt:now, codexThreadId:'provider-thread',
    pinnedAt:now, folderId:'science', modelSelection:{model:'test-model',effort:'high'},
    activity:[{id:'public',kind:'summary',text:'Historical summary',state:'done'}],
    messages:[
      message('u1','user',{attachmentIds:[attachmentId],resourceIds:['prompt-resource'],requestContext:{page:'resource',resourceId:'source'}}),
      message('a1','assistant',{resourceIds:['r1'],codexTurns:[{turnId:'t1',promptMessageId:'u1'}],activity:[{id:'saved',kind:'tool',text:'Saved notes',state:'done'}]}),
      message('u2','user'), message('a2','assistant',{codexTurns:[{turnId:'t2',promptMessageId:'u2'}]}),
    ],
  });
}

test('early edits retain context and attachments, omit later history, and never mutate the parent', () => {
  const original = parent();
  const snapshot = structuredClone(original);
  const result = createChatBranch(original,{operation:'edit',messageId:'u1',content:'New question'});
  assert.deepEqual(original,snapshot);
  assert.deepEqual(result.chat.messages.map(message => message.content),['New question']);
  assert.deepEqual(result.chat.messages[0]?.attachmentIds,[attachmentId]);
  assert.deepEqual(result.chat.messages[0]?.resourceIds,[]);
  assert.deepEqual(result.chat.messages[0]?.requestContext,{page:'resource',resourceId:'source'});
  assert.equal(result.promptMessageId,result.chat.messages[0]?.id);
  assert.deepEqual(result.fork,{kind:'before',turnId:'t1'});
  assert.deepEqual(result.chat.lineage,{schemaVersion:1,kind:'branch',operation:'edit',parentChatId:'parent',sourceMessageId:'u1',checkpointMessageId:null,promptMessageId:result.promptMessageId});
  assert.notEqual(result.chat.id,original.id);
  assert.notEqual(result.chat.messages[0]?.id,original.messages[0]?.id);
  assert.equal(result.chat.codexThreadId,null);
  assert.equal(result.chat.responseError,null);
  assert.equal(result.chat.folderId,original.folderId);
  assert.equal(result.chat.pinnedAt,original.pinnedAt);
  assert.deepEqual(result.chat.modelSelection,original.modelSelection);
});

test('continue checkpoints user or assistant replies, clones associations and historical activity, and clears local turns', () => {
  const original = parent();
  const result = createChatBranch(original,{operation:'continue',messageId:'u1'});
  assert.deepEqual(result.chat.messages.map(message => message.content),['u1','a1']);
  assert.deepEqual(result.fork,{kind:'through',turnId:'t1'});
  assert.equal(result.promptMessageId,null);
  assert.equal(result.chat.lineage.kind === 'branch' && result.chat.lineage.promptMessageId,null);
  assert.deepEqual(result.chat.messages[1]?.resourceIds,['r1']);
  assert.deepEqual(result.chat.messages[1]?.activity,original.messages[1]?.activity);
  assert.notEqual(result.chat.messages[1]?.activity,original.messages[1]?.activity);
  assert.deepEqual(result.chat.activity,[]);
  assert.deepEqual(result.chat.messages.map(message => message.codexTurns),[[],[]]);
  assert.equal(result.chat.lineage.kind === 'branch' && result.chat.lineage.checkpointMessageId,'a1');
  const viaAssistant = createChatBranch(original,{operation:'continue',messageId:'a1'});
  assert.deepEqual(viaAssistant.chat.messages.map(message => message.content),['u1','a1']);
  const nextBranch = createChatBranch(result.chat,{operation:'continue',messageId:result.chat.messages[1]?.id ?? ''});
  assert.equal(nextBranch.fork,null);
});

test('regenerate preserves original prompt and clarification history and forks before the first turn', () => {
  const original = parent();
  original.messages.splice(1,0,message('clarification','user',{content:'Blue'}));
  const reply = original.messages.find(message => message.id === 'a1');
  assert.ok(reply);
  reply.codexTurns.push({turnId:'t1-answer',promptMessageId:'clarification'});
  const result = createChatBranch(original,{operation:'regenerate',messageId:'a1'});
  assert.deepEqual(result.chat.messages.map(message => message.content),['u1','Blue']);
  assert.equal(result.promptMessageId,result.chat.messages[1]?.id);
  assert.equal(result.chat.lineage.kind === 'branch' && result.chat.lineage.promptMessageId,result.chat.messages[1]?.id);
  assert.deepEqual(result.fork,{kind:'before',turnId:'t1'});
  const continuation = createChatBranch(original,{operation:'continue',messageId:'a1'});
  assert.deepEqual(continuation.fork,{kind:'through',turnId:'t1-answer'});
});

test('branch inputs reject unknown, foreign, wrong-role, incomplete and malformed selections', () => {
  const original = parent();
  assert.throws(() => createChatBranch(original,{operation:'continue',messageId:'foreign'}),/not found/);
  assert.throws(() => createChatBranch(original,{operation:'edit',messageId:'a1',content:'Edited'}),/Only user/);
  assert.throws(() => createChatBranch(original,{operation:'regenerate',messageId:'u1'}),/completed assistant/);
  original.messages.push(message('incomplete','assistant',{content:''}));
  assert.throws(() => createChatBranch(original,{operation:'continue',messageId:'incomplete'}),/completed assistant/);
  assert.throws(() => createChatBranch(original,{operation:'regenerate',messageId:'incomplete'}),/completed assistant/);
  original.messages.push(message('pending','user'));
  assert.throws(() => createChatBranch(original,{operation:'edit',messageId:'pending',content:'Edited'}),/completed assistant/);
  assert.equal(branchInputSchema.safeParse({operation:'edit',messageId:'u1',content:' '}).success,false);
  assert.equal(branchInputSchema.safeParse({operation:'continue',messageId:'u1',extra:true}).success,false);
});

test('Store upgrades legacy messages and preserves lineage and context across restart', async () => {
  const directory = await mkdtemp(join(tmpdir(),'centre-branches-'));
  try {
    await writeFile(join(directory,'state.json'),JSON.stringify({...emptySnapshot(),chats:[{
      id:'legacy',title:'Old',createdAt:now,updatedAt:now,messages:[{id:'old-user',role:'user',content:'Old prompt',createdAt:now},{id:'old-reply',role:'assistant',content:'Old reply',createdAt:now}],
    }]}));
    const store = await Store.open(directory);
    const legacy = store.state.chats[0];
    assert.ok(legacy);
    assert.deepEqual(legacy.lineage,{schemaVersion:1,kind:'root'});
    assert.equal(legacy.responseError,null);
    assert.equal(legacy.messages[0]?.requestContext,null);
    assert.deepEqual(legacy.messages[0]?.codexTurns,[]);
    const oldBranch = chatSchema.parse({...legacy,id:'old-branch',lineage:{schemaVersion:1,kind:'branch',operation:'edit',parentChatId:'missing-parent',sourceMessageId:'missing-message',checkpointMessageId:null}});
    assert.equal(oldBranch.lineage.kind === 'branch' && oldBranch.lineage.promptMessageId,null);
    store.state.chats.push(oldBranch);
    const child = createChatBranch(legacy,{operation:'continue',messageId:'old-reply'}).chat;
    store.state.chats.push(child);
    await store.save();
    const reopened = await Store.open(directory);
    assert.deepEqual(reopened.state.chats[1],oldBranch);
    assert.deepEqual(reopened.state.chats[2],child);
  } finally { await rm(directory,{recursive:true,force:true}); }
});

test('strict portable projections contain exactly canonical fields and strip provider and local state', () => {
  const original = parent();
  original.responseError = 'Local failure';
  const chat = projectChatForSync(original);
  assert.deepEqual(Object.keys(chat).sort(),['id','title','createdAt','updatedAt','deletedAt','pinnedAt','folderId','sortOrder','modelSelection','lineage'].sort());
  assert.equal(syncedChatSchema.safeParse({...chat,codexThreadId:'secret'}).success,false);
  const prompt = original.messages[0];
  assert.ok(prompt);
  const withLocalContext = {...prompt,requestContext:{page:'resource',resourceId:'source',localPath:'/private/file'}};
  const portable = projectMessageForSync(withLocalContext,original.id);
  assert.deepEqual(Object.keys(portable).sort(),['id','chatId','role','content','createdAt','responseDurationMs','resourceIds','attachmentIds','requestContext'].sort());
  assert.deepEqual(portable.requestContext,{page:'resource',resourceId:'source'});
  assert.equal(syncedMessageSchema.safeParse({...portable,codexTurns:[]}).success,false);
  assert.equal(syncedMessageSchema.safeParse({...portable,requestContext:{page:'resource',localPath:'/private/file'}}).success,false);
  assert.equal(JSON.stringify(chat).includes('provider-thread'),false);
  assert.equal(JSON.stringify(chat).includes('Historical summary'),false);
});
