import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { Codex } from './codex';

test('malformed Codex output terminates that child and late output cannot disconnect its replacement',async () => {
  const directory = await mkdtemp(join(tmpdir(),'centre-codex-lifecycle-'));
  const binary = join(directory,'codex-fixture');
  const original = process.env.CENTRE_CODEX_BIN;
  await writeFile(binary,`#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const first = !fs.existsSync('first-child');
if (first) fs.writeFileSync('first-child',String(process.pid));
if (first) process.on('SIGTERM',() => {
  setTimeout(() => process.stdout.write('late malformed output\\n'),50);
  setTimeout(() => process.exit(0),150);
});
readline.createInterface({input:process.stdin}).on('line',line => {
  const message = JSON.parse(line);
  if (!message.id) return;
  if (message.method === 'thread/start' && first) { process.stdout.write('malformed output\\n'); return; }
  const result = message.method === 'account/read' ? {account:{id:'fixture'}} : {};
  process.stdout.write(JSON.stringify({id:message.id,result})+'\\n');
});
`,{ mode:0o700 });
  process.env.CENTRE_CODEX_BIN = binary;
  const codex = new Codex(directory,[],async () => undefined);
  try {
    await codex.ready(); assert.equal(codex.status.authenticated,true);
    await assert.rejects(codex.thread('gpt-6.1-sol'),/Codex protocol error/);
    await codex.ready();
    await setTimeout(250);
    assert.equal(codex.status.available,true);
    assert.equal(codex.status.authenticated,true);
    const originalPid = Number(await readFile(join(directory,'first-child'),'utf8'));
    assert.throws(() => process.kill(originalPid,0),{ code:'ESRCH' });
  } finally {
    await codex.close();
    if (original === undefined) delete process.env.CENTRE_CODEX_BIN; else process.env.CENTRE_CODEX_BIN = original;
    await rm(directory,{ recursive:true,force:true });
  }
});

test('Codex forwards public activity, dynamic tool status, and local image inputs',async () => {
  const directory = await mkdtemp(join(tmpdir(),'centre-codex-activity-'));
  const binary = join(directory,'codex-activity-fixture');
  const original = process.env.CENTRE_CODEX_BIN;
  await writeFile(binary,`#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const threadId = 'thread-activity-fixture';
let turnStarted = false;
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
readline.createInterface({input:process.stdin}).on('line',line => {
  const message = JSON.parse(line);
  if (message.id !== undefined && message.method) {
    const result = message.method === 'account/read' ? {account:{id:'fixture'}} : message.method === 'thread/start' ? {thread:{id:threadId}} : {};
    if (message.method === 'turn/start') fs.writeFileSync('turn-start.json',JSON.stringify(message.params));
    send({id:message.id,result});
    if (message.method === 'turn/start' && !turnStarted) {
      turnStarted = true;
      send({method:'item/reasoning/summaryTextDelta',params:{threadId,turnId:'turn-1',itemId:'reasoning-1',delta:'Inspecting ',summaryIndex:0}});
      send({method:'item/reasoning/summaryTextDelta',params:{threadId,turnId:'turn-1',itemId:'reasoning-1',delta:'the picture.',summaryIndex:0}});
      send({method:'item/started',params:{threadId,item:{type:'webSearch',id:'search-1'}}});
      send({id:900,method:'item/tool/call',params:{threadId,tool:'centre_get_state',arguments:{}}});
    }
  } else if (message.id === 900 && !message.method && turnStarted) {
    send({id:901,method:'item/tool/call',params:{threadId,tool:'centre_create_topic',arguments:{}}});
  } else if (message.id === 901 && !message.method && turnStarted) {
    send({method:'item/completed',params:{threadId,item:{type:'webSearch',id:'search-1'}}});
    send({method:'item/completed',params:{threadId,item:{type:'agentMessage',id:'assistant-1',text:'Image reviewed.',phase:'final_answer'}}});
    send({method:'turn/completed',params:{threadId,turn:{status:'completed'}}});
  }
});
`,{ mode:0o700 });
  process.env.CENTRE_CODEX_BIN = binary;
  const toolCalls: Array<{ name:string; threadId?:string }> = [];
    const codex = new Codex(directory,[],async (name,_input,threadId) => {
      toolCalls.push({ name,...(threadId ? { threadId } : {}) });
      if (name === 'centre_create_topic') throw new Error('fixture secret error');
      return { ok:true };
    });
  try {
    await codex.ready();
    const threadId = await codex.thread('gpt-fixture');
    const activities: Array<{ id:string; kind:string; text:string; state:string }> = [];
    const unsubscribe = codex.onActivity(threadId,value => activities.push(value));
    const imagePath = join(directory,'image.png');
    const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+kBs0AAAAASUVORK5CYII=','base64');
    await writeFile(imagePath,image);
    const response = await codex.run(threadId,'Describe the attachment.','gpt-fixture',undefined,'medium',[imagePath]);
    unsubscribe();
    assert.equal(response,'Image reviewed.');
    assert.deepEqual(toolCalls,[{ name:'centre_get_state',threadId },{ name:'centre_create_topic',threadId }]);
    const turnStart = JSON.parse(await readFile(join(directory,'turn-start.json'),'utf8'));
    assert.equal(turnStart.summary,'auto');
    assert.deepEqual(turnStart.input.at(-1),{ type:'localImage',path:imagePath });
    assert.deepEqual(await readFile(turnStart.input.at(-1).path),image);
    assert.deepEqual(activities.map(activity => [activity.kind,activity.text,activity.state]),[
      ['summary','Inspecting ','working'],['summary','the picture.','working'],['tool','Searching the web','working'],['tool','Reading Centre study data','working'],['tool','Reading Centre study data','done'],['tool','Creating a study topic','working'],['tool','Creating a study topic failed','error'],['tool','Searching the web','done'],
    ]);
    assert.equal(activities.some(activity => activity.text.includes('fixture secret error')),false);
  } finally {
    await codex.close();
    if (original === undefined) delete process.env.CENTRE_CODEX_BIN; else process.env.CENTRE_CODEX_BIN = original;
    await rm(directory,{ recursive:true,force:true });
  }
});
