/** Real-account check using temporary local data. No Organato credentials are supplied. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chatSchema, snapshotSchema } from '../shared/schema';
import { createService } from './index';
import { Store } from './store';

const directory = await mkdtemp(join(tmpdir(), 'centre-live-interactions-'));
const output = resolve('.runtime/live-interactions');
await mkdir(output, { recursive:true });
const store = await Store.open(directory);
store.state.subjects.push({ id:'math', name:'Mathematics', shortName:'Maths', color:'#8ea6e8', icon:'book' });
store.state.topics.push({ id:'algebra', subjectId:'math', name:'Algebra', description:'' });
await store.save();
const service = await createService({ dataDir:directory });
const request = async (path:string, method = 'GET', body?:unknown) => {
  const response = await fetch(`http://127.0.0.1:${service.port}/api${path}`, {
    method,
    signal:AbortSignal.timeout(240_000),
    headers:{ Authorization:`Bearer ${service.token}`, 'Content-Type':'application/json' },
    ...(body === undefined ? {} : { body:JSON.stringify(body) }),
  });
  const value:unknown = await response.json();
  assert.equal(response.status, 200, JSON.stringify(value));
  return value;
};
const cases = [
  { name:'explicit-checklist', prompt:'Make it a list I can check off: 23 Oct Maths checkpoint; 27 Oct English cue cards; 9 Nov Maths assessment. Keep it personal, outside school subjects.', kind:'diagram' },
  { name:'proactive-checklist', prompt:'Help me keep track of these tasks: buy coffee beans, clean the grinder, descale the kettle.', kind:'diagram' },
  { name:'five-questions', prompt:'Give me 5 short-response practice questions about coffee extraction.', kind:'quiz' },
  { name:'plain-text', prompt:'Give me a plain text list of these personal tasks, no interactive resource: buy coffee beans, clean the grinder, descale the kettle.', kind:null },
];

try {
  // Also checks that the production model catalog is accessible before running cases.
  await request('/models');
  for (const example of cases) {
    const chat = chatSchema.parse(await request('/chats', 'POST', {}));
    await request(`/chats/${chat.id}/messages`, 'POST', { content:example.prompt, context:{ page:'chat' } });
    const state = snapshotSchema.parse(await request('/state'));
    const conversation = state.chats.find(item => item.id === chat.id);
    const reply = conversation?.messages.at(-1);
    const linkedIds = new Set(conversation?.messages.flatMap(message => message.resourceIds));
    const created = state.resources.filter(resource => linkedIds.has(resource.id));
    if (example.kind === null) assert.equal(created.length, 0, 'Plain text should stay plain text');
    else {
      const resource = created.find(resource => resource.kind === example.kind);
      assert.ok(resource, `${example.name} did not create its interactive resource: ${reply?.content}`);
      assert.equal(resource.subjectId, null, 'Personal activities must remain outside school subjects');
      assert.equal(resource.topicId, null);
      if (resource.kind === 'quiz') assert.equal(resource.questions.length, 5);
      else {
        assert.match(resource.content, /<input\b[^>]*type=["']checkbox["']/i);
        assert.doesNotMatch(resource.content, /<input\b[^>]*\bdisabled\b/i);
        await writeFile(join(output, `${example.name}.html`), resource.content);
      }
    }
    if (example.name === 'explicit-checklist') {
      const content = created[0]?.content ?? '';
      for (const task of ['23 Oct', '27 Oct', '9 Nov', 'Maths checkpoint', 'English cue cards', 'Maths assessment']) assert.ok(content.includes(task), `Missing ${task}`);
    }
    console.log(`PASS ${example.name}`);
  }
  console.log(`Generated HTML saved to ${output} for browser control checks.`);
} finally {
  await service.close();
  await rm(directory, { recursive:true, force:true });
}
