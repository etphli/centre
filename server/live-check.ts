/** Optional real account verification. Uses temporary local data and never writes to Organato. */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { Codex } from './codex';
import { Store } from './store';
import { Resources, generatedResourceSchema } from './resources';
import { allResponseTypes } from '../shared/schema';
const directory = process.env.CENTRE_LIVE_DATA_DIR ?? await mkdtemp(join(tmpdir(),'centre-live-check-'));
const store = await Store.open(directory);
store.state.subjects.push({ id:'math', name:'Mathematics', shortName:'Maths',color:'#c67b5c',icon:'book' });
store.state.topics.push({ id:'algebra',subjectId:'math',name:'Linear equations',description:'Solve one and two step equations.' });
const saveSchema = z.object({ generated:generatedResourceSchema });
let saves = 0;
const codex: Codex = new Codex(directory,[{ type:'function',name:'centre_save_notes',description:'Save actual complete study notes into this temporary verification workspace.',inputSchema:z.toJSONSchema(saveSchema) }],async (name,input): Promise<unknown> => {
  assert.equal(name,'centre_save_notes'); const parsed = saveSchema.parse(input);
  const saved = await resources.saveGenerated({ kind:'notes',subjectId:'math',topicId:'algebra',instructions:'',difficulty:'standard' },parsed.generated); saves++; return saved;
});
const resources: Resources = new Resources(store,codex);
try {
  await codex.ready(); process.stdout.write(`${JSON.stringify(codex.status)}\n`);
  const thread = await codex.thread('gpt-6.1-sol');
  const reply = await codex.run(thread,'Write a concise explanation of solving 2x + 3 = 11. Save it as real study notes using centre_save_notes, with title, complete Markdown content and an empty questions array. Then confirm what you saved.','gpt-6.1-sol');
  process.stdout.write(`Dynamic tool response: ${reply}\n`); assert.equal(saves,1); assert.match(store.state.resources[0]?.content ?? '',/4/); process.stdout.write(`Actual dynamic tool saved notes. Reply: ${reply}\n`);
  const quiz = await resources.generate({ kind:'quiz',subjectId:'math',topicId:'algebra',instructions:'Two short linear equation questions.',questionCount:2,questionTypes:allResponseTypes,difficulty:'gentle' });
  assert.equal(quiz.questions.length,2); process.stdout.write(`Generated quiz: ${quiz.title}, ${quiz.questions.length} questions.\n`);
  const answers = Object.fromEntries(quiz.questions.map((q,index) => [q.id,index === 0 ? q.answer : 'I do not know.']));
  const grade = await resources.grade(quiz.id,answers); assert.ok(grade.total > 0); assert.equal(grade.feedback.length,2); assert.equal(store.state.attempts.length,1); assert.ok(store.state.memories.length > 0);
  const reopened = await Store.open(directory); assert.equal(reopened.state.attempts[0]?.result.score,grade.score); assert.equal(reopened.state.attempts[0]?.answers[quiz.questions[0]?.id ?? ''],quiz.questions[0]?.answer);
  process.stdout.write(`Graded with gpt-6-luna medium: ${grade.score}/${grade.total}; attempt, answers and ${store.state.memories.length} weakness memory persisted.\n`);
  const paper = await resources.generate({ kind:'test',subjectId:'math',topicId:'algebra',instructions:'Two short questions. Keep LaTeX simple.',questionTypes:allResponseTypes,testLength:{mode:'time',minutes:20},difficulty:'gentle' });
  assert.match(paper.content,/\\documentclass\[11pt,a4paper\]/); assert.match(paper.content,/\\end\{document\}/); process.stdout.write(`Generated LaTeX paper: ${paper.title}.\n`);
  const diagram = await resources.generate({ kind:'diagram',subjectId:'math',topicId:'algebra',instructions:'Simple balancing-scale visual for linear equations. Include one small interactive button.',difficulty:'gentle' });
  assert.match(diagram.content,/Content-Security-Policy/); process.stdout.write(`Generated HTML diagram: ${diagram.title}.\n`);
} finally { await codex.close(); if (!process.env.CENTRE_LIVE_DATA_DIR) await rm(directory,{ recursive:true,force:true }); else process.stdout.write(`Verification data retained at ${directory}\n`); }
