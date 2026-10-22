import assert from 'node:assert/strict';
import test from 'node:test';
import { canShareChatAttachment } from '../shared/chat-lineage';
import { chatSchema, messageSchema, type Chat } from '../shared/schema';
import { createChatBranch } from './chat-branches';

const firstAttachment = '0b7ebea0-fc3d-46ea-a05d-61bde4b6cfc5';
const laterAttachment = '89381280-e330-44e0-933e-77119e9f1465';
const now = '2026-10-22T00:00:00.000Z';
function root(id = 'parent'):Chat {
  return chatSchema.parse({id,title:id,createdAt:now,updatedAt:now,messages:[
    messageSchema.parse({id:`${id}-u1`,role:'user',content:'First prompt',createdAt:now,attachmentIds:[firstAttachment],resourceIds:['source-resource'],requestContext:{page:'resource',resourceId:'source-resource'}}),
    messageSchema.parse({id:`${id}-a1`,role:'assistant',content:'First answer',createdAt:now}),
    messageSchema.parse({id:`${id}-u2`,role:'user',content:'Later prompt',createdAt:now,attachmentIds:[laterAttachment]}),
    messageSchema.parse({id:`${id}-a2`,role:'assistant',content:'Later answer',createdAt:now}),
  ]});
}
function share(chats:readonly Chat[], from:Chat, to:Chat, attachment = firstAttachment) {
  return canShareChatAttachment(chats.map(chat => ({workspaceId:'workspace-a',chat})),attachment,{workspaceId:'workspace-a',chatId:from.id},{workspaceId:'workspace-a',chatId:to.id});
}
function branch(parent:Chat, operation:'continue'|'edit'|'regenerate', messageIndex:number):Chat {
  const selected = parent.messages[messageIndex]; assert.ok(selected);
  return createChatBranch(parent,operation === 'edit' ? {operation,messageId:selected.id,content:'Changed prompt'} : {operation,messageId:selected.id}).chat;
}

test('actual continue, edit, regenerate, sibling and nested inheritance shares attachments',() => {
  const parent = root();
  const continued = branch(parent,'continue',0);
  const edited = branch(parent,'edit',0);
  const regenerated = branch(parent,'regenerate',1);
  const nested = branch(continued,'continue',1);
  const chats = [parent,continued,edited,regenerated,nested];
  for (const child of [continued,edited,regenerated,nested]) {
    assert.equal(share(chats,parent,child),true);
    assert.equal(share(chats,child,parent),true);
  }
  assert.equal(share(chats,edited,regenerated),true);
  assert.equal(share(chats,nested,edited),true);
  const lateEdit = branch(parent,'edit',2);
  assert.equal(share([...chats,lateEdit],parent,lateEdit,laterAttachment),true);
  assert.equal(share([...chats,lateEdit],parent,lateEdit,firstAttachment),true);
});

test('ownership is required and an abandoned later attachment cannot cross an earlier branch boundary',() => {
  const parent = root(), continued = branch(parent,'continue',1);
  assert.equal(share([parent,continued],parent,continued,laterAttachment),false);
  continued.messages.push(messageSchema.parse({id:'later-child-message',role:'user',content:'Forged reuse',createdAt:now,attachmentIds:[laterAttachment]}));
  assert.equal(share([parent,continued],parent,continued,laterAttachment),false);
  assert.equal(share([parent,continued],parent,continued,firstAttachment),true);
  assert.equal(share([parent],parent,parent),true);
  assert.equal(share([parent],parent,parent,'missing-attachment'),false);
  assert.equal(canShareChatAttachment([{workspaceId:'workspace-a',chat:parent}],firstAttachment,{workspaceId:'workspace-a',chatId:'missing-chat'},{workspaceId:'workspace-a',chatId:parent.id}),false);
});

test('archived owners remain traversable but unrelated roots sharing an attachment ID stay isolated',() => {
  const parent = root(), child = branch(parent,'continue',1), sibling = branch(parent,'edit',0);
  parent.deletedAt = now;
  assert.equal(share([parent,child,sibling],parent,child),true);
  assert.equal(share([parent,child,sibling],child,sibling),true);
  assert.equal(share([parent,child,sibling],child,parent),false);
  assert.equal(share([parent],parent,parent),false);
  assert.equal(share([parent,child,sibling],parent,parent),false);
  const unrelated = root('unrelated');
  assert.equal(share([parent,child,sibling,unrelated],unrelated,child),false);
  assert.equal(share([parent,child,sibling,unrelated],parent,unrelated),false);
});

test('missing ancestors, duplicate chat/message IDs and cyclic ancestry fail closed',() => {
  const parent = root(), child = branch(parent,'continue',1);
  assert.equal(share([child],parent,child),false);
  const nested = branch(child,'continue',1);
  assert.equal(share([child,nested],child,nested),false);
  assert.equal(share([parent,child,{...parent}],parent,child),false);
  const duplicateMessages = root('duplicate');
  const original = parent.messages[0], duplicate = duplicateMessages.messages[0]; assert.ok(original); assert.ok(duplicate);
  duplicate.id = original.id;
  assert.equal(share([parent,child,duplicateMessages],parent,child),false);
  const cyclic = root('cycle'); cyclic.messages = cyclic.messages.slice(0,2);
  const cyclicChild = branch(cyclic,'continue',1);
  const checkpoint = cyclicChild.messages[1]; assert.ok(checkpoint);
  cyclic.lineage = {schemaVersion:1,kind:'branch',operation:'continue',parentChatId:cyclicChild.id,sourceMessageId:checkpoint.id,checkpointMessageId:checkpoint.id,promptMessageId:null};
  assert.equal(share([cyclic,cyclicChild],cyclic,cyclicChild),false);
  assert.equal(share([cyclic,cyclicChild],cyclicChild,cyclicChild),false);
  assert.equal(share([child,nested],child,child),false);
});

test('forged source/checkpoint references, boundaries, child prompt anchors and copied prefixes fail closed',() => {
  const parent = root(), unrelated = root('unrelated');
  const cases:((child:Chat) => void)[] = [
    child => { if (child.lineage.kind === 'branch') child.lineage.sourceMessageId = 'unrelated-u1'; },
    child => { if (child.lineage.kind === 'branch') child.lineage.checkpointMessageId = 'unrelated-a1'; },
    child => { if (child.lineage.kind === 'branch') child.lineage.checkpointMessageId = 'parent-a2'; },
    child => { if (child.lineage.kind === 'branch') child.lineage.promptMessageId = child.messages[0]?.id ?? 'missing'; },
    child => { const copied = child.messages[0]; assert.ok(copied); copied.content = 'Altered retained history'; },
    child => { const copied = child.messages[0]; assert.ok(copied); copied.resourceIds = []; },
    child => { const copied = child.messages[0]; assert.ok(copied); copied.attachmentIds.push(laterAttachment); },
    child => { const copied = child.messages[0]; assert.ok(copied); copied.role = 'assistant'; },
    child => { child.messages.splice(0,1); },
  ];
  for (const mutate of cases) {
    const child = branch(parent,'continue',1); mutate(child);
    assert.equal(share([parent,child,unrelated],parent,child),false);
  }
  const edited = branch(parent,'edit',2);
  if (edited.lineage.kind === 'branch') edited.lineage.promptMessageId = edited.messages[0]?.id ?? 'missing';
  assert.equal(share([parent,edited],parent,edited),false);
  const changedAttachments = branch(parent,'edit',0);
  const prompt = changedAttachments.messages[0]; assert.ok(prompt); prompt.attachmentIds = [laterAttachment];
  assert.equal(share([parent,changedAttachments],parent,changedAttachments,laterAttachment),false);
});

test('workspace scope rejects foreign owners and foreign-only parents while ignoring foreign records',() => {
  const parent = root(), child = branch(parent,'continue',1);
  const from = {workspaceId:'workspace-a',chatId:parent.id};
  const to = {workspaceId:'workspace-a',chatId:child.id};
  const local = [{workspaceId:'workspace-a',chat:parent},{workspaceId:'workspace-a',chat:child}];
  assert.equal(canShareChatAttachment(local,firstAttachment,from,{...to,workspaceId:'workspace-b'}),false);
  assert.equal(canShareChatAttachment(local,firstAttachment,{...from,workspaceId:'workspace-b'},to),false);
  assert.equal(canShareChatAttachment([{workspaceId:'workspace-b',chat:parent},{workspaceId:'workspace-a',chat:child}],firstAttachment,to,to),false);
  const nested = branch(child,'continue',1);
  assert.equal(canShareChatAttachment([{workspaceId:'workspace-b',chat:parent},{workspaceId:'workspace-a',chat:child},{workspaceId:'workspace-a',chat:nested}],firstAttachment,to,{workspaceId:'workspace-a',chatId:nested.id}),false);
  assert.equal(canShareChatAttachment([...local,{workspaceId:'workspace-b',chat:parent},{workspaceId:'workspace-b',chat:parent}],firstAttachment,from,to),true);
  assert.equal(canShareChatAttachment([{workspaceId:'workspace-b',chat:parent},{workspaceId:'workspace-b',chat:child}],firstAttachment,from,to),false);
});
