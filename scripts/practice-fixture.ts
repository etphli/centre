import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { Store } from '../server/store';
import { createService } from '../server/index';
import { resourceSchema } from '../shared/schema';

// An isolated real Centre service and renderer, with a deterministic CLI boundary.
const directory = await mkdtemp(join(tmpdir(), 'centre-practice-ui-'));
const binary = join(directory, 'fixture-codex.cjs');
await writeFile(binary, `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
let thread = 0;
readline.createInterface({input:process.stdin}).on('line', line => {
  const message = JSON.parse(line); if (!message.id) return;
  const p = message.params;
  let result = {};
  if (message.method === 'account/read') result = {account:{id:'practice-ui-fixture'}};
  if (message.method === 'model/list') result = {data:['gpt-6.1-sol','gpt-6-luna'].map(model => ({model,displayName:model,supportedReasoningEfforts:[{reasoningEffort:'medium'}],defaultReasoningEffort:'medium'})),nextCursor:null};
  if (message.method === 'thread/start') result = {thread:{id:'fixture-thread-'+(++thread)}};
  send({id:message.id,result});
  if (message.method !== 'turn/start') return;
  fs.appendFileSync('turns.jsonl',JSON.stringify(p)+'\\n');
  const grading = Boolean(p.outputSchema?.properties?.feedback);
  if (grading && fs.existsSync('fail-grade')) {
    send({method:'turn/completed',params:{threadId:p.threadId,turn:{status:'failed',error:{message:'Fixture marking is temporarily unavailable.'}}}});return;
  }
  let output;
  if (grading) {
    const prompt = p.input.find(item => item.type === 'text').text;
    const resource = JSON.parse(prompt.match(/Resource: (.*)\\nStudent answers:/s)[1]);
    const answers = JSON.parse(prompt.split('Student answers: ')[1]);
    const feedback = resource.questions.map(q => ({questionId:q.id,concept:q.concept,score:answers[q.id] === q.answer ? q.marks : 0,maxScore:q.marks,feedback:answers[q.id] === q.answer ? 'Correct. You applied the inverse operation.' : 'Undo the multiplication by dividing both sides by the same number.',needsReview:answers[q.id] !== q.answer}));
    output = {score:feedback.reduce((n,f)=>n+f.score,0),total:feedback.reduce((n,f)=>n+f.maxScore,0),feedback};
  } else if (p.outputSchema?.properties?.response) output = {response:{kind:'message',content:'Let us practise inverse operations using the recent feedback.'}};
  else output = {title:'Inverse operations practice',content:'',practiceFocus:['Inverse operations'],questions:[{concept:'Inverse operations',responseType:'multiple_choice',choices:['x = 3','x = 4','x = 6'],prompt:'Solve 3x = 12.',answer:'x = 4',explanation:'Divide both sides by 3.',marks:1},{concept:'Inverse operations',responseType:'short_response',choices:[],prompt:'Solve 5y = 30 and explain your first step.',answer:'y = 6',explanation:'Divide both sides by 5.',marks:2}]};
  setTimeout(() => {send({method:'item/completed',params:{threadId:p.threadId,item:{id:'answer',type:'agentMessage',phase:'final_answer',text:JSON.stringify(output)}}});send({method:'turn/completed',params:{threadId:p.threadId,turn:{status:'completed'}}});},grading && fs.existsSync('slow-grade') ? 10000 : 150);
});
`, { mode: 0o700 });
process.env.CENTRE_CODEX_BIN = binary;
const store = await Store.open(directory);
const now = new Date().toISOString();
store.state.subjects.push({ id:'math', name:'Mathematics', shortName:'Maths', color:'#b7a27a', icon:'book' });
store.state.topics.push({ id:'algebra', subjectId:'math', name:'Algebra', description:'Solving equations with inverse operations.' }, { id:'geometry', subjectId:'math', name:'Geometry', description:'Angles and shapes.' });
store.state.resources.push(resourceSchema.parse({ id:'evidence-quiz', subjectId:'math', topicId:'algebra', title:'Earlier equation practice', kind:'quiz', createdAt:now, updatedAt:now, content:'', questions:[{id:'q1',concept:'Inverse operations',prompt:'Solve 2x = 8.',answer:'4',marks:1}] }), resourceSchema.parse({ id:'geometry-quiz', subjectId:'math', topicId:'geometry', title:'Geometry practice', kind:'quiz', createdAt:now, updatedAt:now, content:'', questions:[{id:'g1',concept:'Triangle angles',prompt:'Two angles in a triangle are 60° and 70°. Find the third angle.',answer:'50°',marks:1}] }));
await store.save();
const service = await createService({ dataDir:directory });
async function post(path: string, input: unknown) {
  const response = await fetch(`http://127.0.0.1:${service.port}/api${path}`, {method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${service.token}`},body:JSON.stringify(input)});
  const value = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(value));
  return value;
}
await post('/quiz/grade', {resourceId:'evidence-quiz',answers:{q1:'3'}});
const generated = resourceSchema.parse(await post('/resources/generate', {kind:'quiz',subjectId:'math',topicId:'algebra',questionCount:2,questionTypes:['multiple_choice','short_response'],instructions:'Practise inverse operations.',difficulty:'standard'}));
const vite = await createServer({configFile:false,root:process.cwd(),plugins:[react(),{name:'fixture-csp',transformIndexHtml:html=>html.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")}],server:{host:'127.0.0.1',port:Number(process.env.CENTRE_PRACTICE_PORT ?? 5387),strictPort:true,proxy:{'/api':{target:`http://127.0.0.1:${service.port}`,headers:{Authorization:`Bearer ${service.token}`}}}}});
await vite.listen();
const info = {url:vite.resolvedUrls?.local[0],directory,quizId:generated.id,pid:process.pid,fixture:'Real local Store, routes, grade and generation; deterministic fake CLI provider; no live user data.'};
await mkdir('.runtime',{recursive:true});
await writeFile('.runtime/practice-ui-info.json',JSON.stringify(info,null,2));
process.stdout.write(JSON.stringify(info,null,2)+'\n');
const close = () => { void Promise.all([vite.close(),service.close()]).then(()=>process.exit(0)); };
process.once('SIGINT',close);process.once('SIGTERM',close);
