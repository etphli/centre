/** Rerunnable fixture render; --live replays graphing generation with the real model in isolated data. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { questionSchema, type Resource } from '../shared/schema';
import { paperTemplate } from '../server/test-paper';
import { graphSvg } from '../shared/paper-graph';
import { Store } from '../server/store';
import { Codex } from '../server/codex';
import { Resources, safeLatex } from '../server/resources';

const output = resolve('.runtime/paper-verification',process.argv.includes('--live')?'live':'fixture');
await mkdir(output,{recursive:true});
let title = 'Parabola graphing: layout verification';
let questions:Resource['questions'];
if (process.argv.includes('--live')) {
  const store = await Store.open(await mkdtemp(join(output,'isolated-data-')));
  await mkdir(join(output,'isolated-codex'),{recursive:true});
  const codex = new Codex(join(output,'isolated-codex'),[],async()=>{throw new Error('No app writes are allowed in this verification.');});
  try {
    await codex.ready();
    assert.ok(codex.status.authenticated,'Sign in to the Codex CLI before live verification.');
    const model = 'gpt-6.1-sol', effort = 'medium';
    const threadId = await codex.thread(model,null,false,effort);
    const imageIndex = process.argv.indexOf('--image');
    const imagePaths = imageIndex >= 0 ? [resolve(process.argv[imageIndex+1]!)] : [];
    const instructions = 'In that time I did 1 math paper, on chapter 7 - parabolas for my upcoming year 10 adv exam, all my answers were correct, although I need to work on my graph work. I have attached two questions, so make a test paper with about 10 questions all similar to those, make them quite hard. Use long response questions. The reference asks to factorise y=x^2-2x-8, find its turning point by symmetry and sketch; then complete the square for y=x^2-4x+7 and sketch.';
    const resource = await new Resources(store,codex).generate({kind:'test',subjectId:null,topicId:null,instructions,difficulty:'challenging',questionTypes:['long_response'],testLength:{mode:'questions',questionCount:10}},{threadId,selection:{model,effort},context:instructions,imagePaths,checkActive:()=>{}});
    title=resource.title; questions=resource.questions;
    await writeFile(join(output,'resource.json'),JSON.stringify(resource,null,2));
    console.log(`Real model: ${model}, effort: ${effort}, images: ${imagePaths.length}`);
  } finally { await codex.close(); }
} else {
  const axes = {xMin:-3,xMax:7,yMin:-12,yMax:10,curves:[],points:[]};
  questions = [
    questionSchema.parse({id:'crossing',responseType:'long_response',marks:6,prompt:'For $y=x^{2}-2x-8$:\\begin{enumerate}[label=(\\alph*)]\\item Factorise to find the $x$-intercepts. [2 marks]\\item Use symmetry to find the turning point. [2 marks]\\item Sketch, labelling the intercepts and turning point. [2 marks]\\end{enumerate}',answer:'$y=(x-4)(x+2)$. Roots $(-2,0)$, $(4,0)$. Vertex $(1,-9)$.',explanation:'The symmetry axis is $x=1$. The $y$-intercept is $(0,-8)$.',paperLayout:{workingSpace:{kind:'lines',lines:7},graphPlacement:'beside',questionGraph:axes,answerGraph:{...axes,curves:[{a:1,b:-2,c:-8,label:'y'}],points:[{x:-2,y:0,label:'(-2, 0)'},{x:4,y:0,label:'(4, 0)'},{x:1,y:-9,label:'(1, -9)'},{x:0,y:-8,label:'(0, -8)'}]},startOnNewPage:false}}),
    questionSchema.parse({id:'no-roots',responseType:'long_response',marks:5,prompt:'For $y=2x^{2}-8x+11$:\\begin{enumerate}[label=(\\alph*)]\\item Complete the square and find the turning point. [3 marks]\\item Sketch, explaining why there are no real roots. [2 marks]\\end{enumerate}',answer:'$y=2(x-2)^{2}+3$. Vertex $(2,3)$.',explanation:'The minimum is $3>0$, so there are no real $x$-intercepts.',paperLayout:{workingSpace:{kind:'lines',lines:5},graphPlacement:'below',questionGraph:{...axes,xMin:-2,xMax:6,yMin:-2,yMax:15},answerGraph:{...axes,xMin:-2,xMax:6,yMin:-2,yMax:15,curves:[{a:2,b:-8,c:11,label:'y'}],points:[{x:2,y:3,label:'(2, 3)'},{x:0,y:11,label:'(0, 11)'}]},startOnNewPage:true}}),
    questionSchema.parse({id:'short',responseType:'short_response',marks:2,prompt:'State the axis of symmetry of $y=-3(x+2)^{2}+5$.',answer:'$x=-2$.',paperLayout:{workingSpace:{kind:'lines',lines:2},graphPlacement:'below',questionGraph:null,answerGraph:null,startOnNewPage:false}}),
  ];
}
assert.ok(questions.every(question=>question.paperLayout),'New papers must use model-selected layout metadata.');
for (const question of questions) for (const fragment of [question.prompt,question.answer,question.explanation,...question.choices]) safeLatex(fragment);
const graphQuestions=questions.filter(question=>question.paperLayout?.questionGraph);
assert.ok(graphQuestions.length>=2,'Graphing practice needs usable axes.');
for(const question of graphQuestions) {
  assert.equal(question.paperLayout?.questionGraph?.curves.length,0,'Sketching workspace must not reveal the solution.');
  assert.ok(question.paperLayout?.answerGraph?.curves.length,'A graphing answer needs a plotted curve.');
  for(const p of question.paperLayout!.answerGraph!.points) {
    assert.ok(question.paperLayout!.answerGraph!.curves.some(c=>Math.abs(c.a*p.x*p.x+c.b*p.x+c.c-p.y)<0.03),`Point ${p.label} is not on an answer curve.`);
  }
}
const source=paperTemplate(title,'Year 10 Mathematics Advanced',questions,{mode:'questions',questionCount:questions.length},'Chapter 7: Parabolas');
await writeFile(join(output,'paper.tex'),source);
await writeFile(join(output,'questions.json'),JSON.stringify(questions,null,2));
await writeFile(join(output,'graphs.html'),`<!doctype html><meta charset="utf-8"><title>Graph verification</title><style>body{font:16px system-ui;max-width:900px;margin:40px auto}section{break-inside:avoid;display:grid;grid-template-columns:1fr 1fr;gap:24px;border-bottom:1px solid #ccc;padding:24px}svg{width:100%}</style><h1>${title.replaceAll('<','&lt;')}</h1>${graphQuestions.map((q,index)=>`<h2>Question ${index+1}</h2><section><div><h3>Student workspace</h3>${graphSvg(q.paperLayout!.questionGraph!)}</div><div><h3>Answer graph</h3>${graphSvg(q.paperLayout!.answerGraph!)}</div></section>`).join('')}`);
console.log(`${questions.length} questions; ${graphQuestions.length} graph workspaces and plotted answers; ${questions.reduce((sum,q)=>sum+q.marks,0)} marks. Output: ${output}`);
