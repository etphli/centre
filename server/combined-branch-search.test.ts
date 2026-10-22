import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chatSchema } from '../shared/schema';
import { searchResultsSchema } from '../shared/search';
import { AttachmentStore } from './attachments';
import { createService } from './index';
import { Store } from './store';

test('a real continued branch is searchable immediately and retains its attachment after the parent is archived', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'centre-combined-branch-search-'));
  let service: Awaited<ReturnType<typeof createService>> | undefined;
  try {
    const store = await Store.open(directory);
    const attachment = await new AttachmentStore(directory).upload({ name: 'combined.txt', mimeType: 'text/plain', data: Buffer.from('combinedattachmentphrase').toString('base64') });
    const now = new Date().toISOString();
    const parent = chatSchema.parse({ id: randomUUID(), title: 'Original', createdAt: now, updatedAt: now, messages: [
      { id: randomUUID(), role: 'user', content: 'combinedpromptphrase', attachmentIds: [attachment.id], createdAt: now },
      { id: randomUUID(), role: 'assistant', content: 'Retained answer', createdAt: now },
    ] });
    store.state.chats.push(parent);
    await store.save();
    service = await createService({ dataDir: directory });
    const baseUrl = `http://127.0.0.1:${service.port}/api`;
    const token = service.token;
    const request = async (path: string, method = 'GET', body?: unknown): Promise<unknown> => {
      const response = await fetch(baseUrl + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      assert.equal(response.status, 200, `${method} ${path}`);
      return response.json();
    };
    const reply = parent.messages[1];
    assert.ok(reply);
    const child = chatSchema.parse(await request(`/chats/${parent.id}/branch`, 'POST', { operation: 'continue', messageId: reply.id }));
    const targets = async (query: string) => searchResultsSchema.parse(await request(`/search?q=${query}`)).flatMap(hit => hit.target.kind === 'chat' ? [hit.target.chatId] : []);
    assert.ok((await targets('combinedpromptphrase')).includes(child.id), 'new branch text is indexed before another mutation or restart');
    assert.ok((await targets('combinedattachmentphrase')).includes(child.id), 'new retained attachment is indexed immediately');
    await request(`/chats/${parent.id}/archive`, 'POST', {});
    assert.deepEqual(new Set(await targets('combinedattachmentphrase')), new Set([child.id]));
    await service.close();
    service = await createService({ dataDir: directory });
    const reloaded = new AttachmentStore(directory);
    const persisted = await Store.open(directory);
    assert.doesNotThrow(() => reloaded.assertMessageOwnership(persisted.state.chats, [attachment.id], child.id));
    assert.throws(() => reloaded.assertMessageOwnership(persisted.state.chats, [attachment.id], parent.id));
  } finally {
    await service?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
