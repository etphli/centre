/** Optional signed-in model check. Uses synthetic facts and isolated local data. */
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chatSchema,snapshotSchema } from '../shared/schema';
import { Store } from './store';
import { createService } from './index';

const directory = process.env.CENTRE_LIVE_DATA_DIR ?? await mkdtemp(join(tmpdir(),'centre-live-memory-'));
let service = await createService({dataDir:directory});
async function request(path:string,method = 'GET',body?:unknown):Promise<unknown> {
  const response = await fetch(`http://127.0.0.1:${service.port}/api${path}`,{method,headers:{Authorization:`Bearer ${service.token}`,'Content-Type':'application/json'},...(body === undefined ? {} : {body:JSON.stringify(body)})});
  const result:unknown = await response.json();
  assert.equal(response.status,200,JSON.stringify(result)); return result;
}
async function newChat() { return chatSchema.parse(await request('/chats','POST',{})); }
async function send(id:string,content:string) {
  const chat = chatSchema.parse(await request(`/chats/${id}/messages`,'POST',{content,context:{page:'chat'}}));
  const reply = chat.messages.at(-1)?.content ?? '';
  process.stdout.write(`Student: ${content}\nCentre: ${reply}\n`); return reply;
}
async function restart() {
  await service.close(); service = await createService({dataDir:directory});
  process.stdout.write('Service restarted with the same isolated data directory.\n');
}
try {
  const first = await newChat();
  await send(first.id,'Remember that my custom study mnemonic is cobalt otter 7382. Save it with the key study.mnemonic. This is a synthetic verification fact; please save it as requested. Just confirm, no questions or resources.');
  let disk = await Store.open(directory);
  assert.ok(disk.state.assistantMemories.some(memory => /cobalt otter 7382/i.test(memory.content)));
  process.stdout.write('PASS: real model called the memory tool and the fact reached disk.\n');
  await restart();
  const second = await newChat(); assert.notEqual(first.id,second.id);
  assert.match(await send(second.id,'What is my custom study mnemonic? Answer with its exact words and number. No questions or resources.'),/cobalt otter 7382/i);
  process.stdout.write('PASS: a new chat recalled the fact after service restart.\n');
  await send(second.id,'Correct my saved study mnemonic to silver heron 9284, replacing the old value under study.mnemonic. Just confirm.');
  disk = await Store.open(directory);
  assert.equal(disk.state.assistantMemories.length,1);
  assert.match(disk.state.assistantMemories[0].content,/silver heron 9284/i);
  await restart();
  const third = await newChat();
  assert.match(await send(third.id,'What is my custom study mnemonic now? Answer with its exact words and number. No questions or resources.'),/silver heron 9284/i);
  process.stdout.write('PASS: the corrected fact replaced the old value and survived another restart.\n');
  await send(third.id,'Forget my saved study mnemonic. Remove that entry from persistent memory. Just confirm.');
  await restart();
  assert.deepEqual(snapshotSchema.parse(await request('/state')).assistantMemories,[]);
  const fourth = await newChat();
  const forgotten = await send(fourth.id,'Do you remember my custom study mnemonic? Say if you do not know it. No questions or resources.');
  assert.doesNotMatch(forgotten,/silver heron 9284|cobalt otter 7382/i);
  process.stdout.write('PASS: forgetting removed the entry from disk and from a new chat after restart.\n');
} finally {
  await service.close();
  if (!process.env.CENTRE_LIVE_DATA_DIR) await rm(directory,{recursive:true,force:true});
}
