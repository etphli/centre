import test from 'node:test';
import assert from 'node:assert/strict';
import { chatSchema, type Chat } from './schema';
import { canShareChatAttachment, type ScopedChatLineage } from './chat-lineage';

const attachment = 'f11d13d6-978c-4480-a72d-52e0d889dff8';
const later = 'd90d03a0-86f9-4c37-afb3-224fe327f277';
const now = '2026-10-22T00:00:00.000Z';
function root(id = 'root'):Chat {
  return chatSchema.parse({id,title:id,createdAt:now,updatedAt:now,messages:[
    {id:`${id}-prompt`,role:'user',content:'Retained prompt',createdAt:now,attachmentIds:[attachment]},
    {id:`${id}-reply`,role:'assistant',content:'Retained answer',createdAt:now},
    {id:`${id}-later`,role:'user',content:'Later prompt',createdAt:now,attachmentIds:[later]},
    {id:`${id}-last`,role:'assistant',content:'Later answer',createdAt:now},
  ]});
}
function child(parent:Chat,id:string):Chat {
  return chatSchema.parse({id,title:id,createdAt:now,updatedAt:now,
    messages:parent.messages.slice(0,2).map((message,index)=>({...structuredClone(message),id:`${id}-${index}`})),
    lineage:{schemaVersion:1,kind:'branch',operation:'continue',parentChatId:parent.id,sourceMessageId:parent.messages[1]?.id,checkpointMessageId:parent.messages[1]?.id,promptMessageId:null},
  });
}
const scoped = (chats:Chat[],workspaceId = 'workspace-a'):ScopedChatLineage[] => chats.map(chat=>({workspaceId,chat}));
const owner = (chat:Chat,workspaceId = 'workspace-a') => ({workspaceId,chatId:chat.id});

test('portable inheritance permits active child and siblings after their source is archived',()=>{
  const parent=root(),a=child(parent,'a'),b=child(parent,'b');
  parent.deletedAt=now;
  assert.equal(canShareChatAttachment(scoped([parent,a,b]),attachment,owner(parent),owner(a)),true);
  assert.equal(canShareChatAttachment(scoped([parent,a,b]),attachment,owner(a),owner(b)),true);
  a.deletedAt=now;
  assert.equal(canShareChatAttachment(scoped([parent,a,b]),attachment,owner(parent),owner(a)),false);
});

test('unrelated reuse and an attachment beyond the checkpoint cannot gain access',()=>{
  const parent=root(),a=child(parent,'a'),unrelated=root('unrelated');
  a.messages.push({...structuredClone(parent.messages[2]!),id:'forged-later'});
  assert.equal(canShareChatAttachment(scoped([parent,a,unrelated]),later,owner(parent),owner(a)),false);
  assert.equal(canShareChatAttachment(scoped([parent,a,unrelated]),attachment,owner(unrelated),owner(a)),false);
  assert.equal(canShareChatAttachment(scoped([parent,a]),attachment,owner(parent),owner(a)),true);
});

test('workspace boundaries and missing or cyclic ancestry fail closed',()=>{
  const parent=root(),a=child(parent,'a');
  assert.equal(canShareChatAttachment([...scoped([parent]),...scoped([a],'workspace-b')],attachment,owner(parent),owner(a,'workspace-b')),false);
  assert.equal(canShareChatAttachment([...scoped([parent],'workspace-b'),...scoped([a])],attachment,owner(a),owner(a)),false);
  parent.lineage={schemaVersion:1,kind:'branch',operation:'continue',parentChatId:a.id,sourceMessageId:a.messages[1]!.id,checkpointMessageId:a.messages[1]!.id,promptMessageId:null};
  assert.equal(canShareChatAttachment(scoped([parent,a]),attachment,owner(parent),owner(a)),false);
});

test('lineage references cannot authorize altered copied history',()=>{
  const parent=root(),a=child(parent,'a');
  if(a.lineage.kind==='branch')a.lineage.checkpointMessageId=parent.messages[3]!.id;
  assert.equal(canShareChatAttachment(scoped([parent,a]),attachment,owner(parent),owner(a)),false);
  const b=child(parent,'b');b.messages[0]!.attachmentIds.push(later);
  assert.equal(canShareChatAttachment(scoped([parent,b]),attachment,owner(parent),owner(b)),false);
});
