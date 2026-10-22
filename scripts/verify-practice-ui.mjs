import { chromium } from '../.runtime/ui-tools/node_modules/playwright/index.mjs';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
const info = JSON.parse(await readFile('.runtime/practice-ui-info.json','utf8'));
const evidence='docs/evidence/practice';
await mkdir(evidence,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true,timeout:60000});
const context=await browser.newContext({viewport:{width:1440,height:1000},recordVideo:{dir:'.runtime/practice-videos',size:{width:1440,height:1000}}});
const page=await context.newPage();page.setDefaultTimeout(60000);
const errors=[];page.on('pageerror',error=>errors.push(error.message));
const steps=[];
async function step(name,check){await check();steps.push(name);console.log('PASS '+name);}
async function shot(name){await page.screenshot({path:`${evidence}/${name}.png`});}
async function open(title='Inverse operations practice') {await page.getByRole('button',{name:'Resources',exact:true}).first().click();await page.getByRole('button',{name:title,exact:true}).click();}
async function saved(){await page.getByText('Draft saved on this device.',{exact:true}).waitFor();}
async function state(){return page.evaluate(async()=>{const r=await fetch('/api/state');return r.json();});}
let failureDirectory=false;
try {
 await page.goto(info.url,{waitUntil:'domcontentloaded',timeout:60000});
 await open();
 if(await page.getByRole('button',{name:'Try again',exact:true}).count()) {await page.getByRole('button',{name:'Try again',exact:true}).click();await saved();}
 await page.locator('.quiz__dot').first().click();
 console.log('QUIZ '+await page.locator('.quiz').innerText());
 await step('adaptive focus is backed by actual fixture grade and generation',async()=>{await page.getByText('Practice focus from recent feedback: Inverse operations.',{exact:true}).waitFor();const s=await state();assert.ok(s.learningNeeds.some(n=>n.conceptLabel==='Inverse operations'&&n.evidence.some(e=>e.source==='grade')));});
 await page.getByRole('radio').first().check();await saved();
 await shot('selected-and-saved');
 await page.getByRole('button',{name:'Next',exact:true}).click();
 await page.locator('textarea.question__answer').fill('y = 5. I divided both sides by 5.');await saved();
 const firstDraft=(await state()).practiceDrafts.find(d=>d.resourceId===info.quizId&&!d.deletedAt);
 await step('different resources retain separate answers and question positions',async()=>{await open('Geometry practice');await page.locator('textarea.question__answer').fill('Still working on the missing angle.');await saved();await open();assert.equal(await page.locator('textarea.question__answer').inputValue(),'y = 5. I divided both sides by 5.');await page.getByText('Question 2 of 2',{exact:false}).waitFor();});
 await step('reload resumes the durable draft at question two',async()=>{await page.reload({waitUntil:'domcontentloaded'});await open();assert.equal(await page.locator('textarea.question__answer').inputValue(),'y = 5. I divided both sides by 5.');const s=await state();assert.equal(s.practiceDrafts.find(d=>d.id===firstDraft.id).currentQuestion,1);});
 await shot('resumed');
 await step('failed saves preserve local inputs across navigation and reload',async()=>{await mkdir(info.directory+'/state.json.tmp');failureDirectory=true;await page.locator('textarea.question__answer').fill('Retained after a failed save.');await page.getByText('Draft not saved. Your answers are still here.',{exact:true}).waitFor();await shot('failed-save');await open('Geometry practice');await open();assert.equal(await page.locator('textarea.question__answer').inputValue(),'Retained after a failed save.');await page.reload({waitUntil:'domcontentloaded'});await open();assert.equal(await page.locator('textarea.question__answer').inputValue(),'Retained after a failed save.');await rm(info.directory+'/state.json.tmp',{recursive:true});failureDirectory=false;await page.getByRole('button',{name:'Retry save',exact:true}).click();await saved();const s=await state();assert.ok(Object.values(s.practiceDrafts.find(d=>d.id===firstDraft.id).answers).includes('Retained after a failed save.'));});
 await step('failed marking retains all saved inputs and the active draft',async()=>{await writeFile(info.directory+'/fail-grade','');await page.getByRole('button',{name:'Submit for marking',exact:true}).click();await page.getByText('Grading didn’t finish. Your answers are still here, so you can try again.',{exact:true}).waitFor();assert.equal(await page.locator('textarea.question__answer').inputValue(),'Retained after a failed save.');assert.equal((await state()).practiceDrafts.find(d=>d.id===firstDraft.id).deletedAt,null);await shot('failed-marking');await rm(info.directory+'/fail-grade');});
 await step('successful grading survives navigation and clears only the submitted draft',async()=>{await writeFile(info.directory+'/slow-grade','');await page.getByRole('button',{name:'Submit for marking',exact:true}).click();await open('Geometry practice');await open();await page.getByRole('button',{name:'Try again',exact:true}).waitFor();await rm(info.directory+'/slow-grade');const s=await state();assert.ok(s.practiceDrafts.find(d=>d.id===firstDraft.id).deletedAt);assert.ok(s.practiceDrafts.some(d=>d.resourceId==='geometry-quiz'&&!d.deletedAt));assert.equal(s.attempts.filter(a=>a.sourceDraftId===firstDraft.id).length,1);await shot('marked');});
 await step('Try again starts empty and never prefills the graded submission',async()=>{await page.getByRole('button',{name:'Try again',exact:true}).click();await saved();assert.equal(await page.locator('.resource-header .done-pill').count(),0,'An unfinished quiz must not be labelled Done.');assert.equal(await page.locator('input[type=radio]:checked').count(),0);await page.getByRole('button',{name:'Next',exact:true}).click();assert.equal(await page.locator('textarea.question__answer').inputValue(),'');await page.locator('textarea.question__answer').fill('Discard this unfinished answer.');await saved();});
 await step('explicit start-over confirms and creates a separate empty draft',async()=>{const before=(await state()).practiceDrafts.find(d=>d.resourceId===info.quizId&&!d.deletedAt);await page.getByRole('button',{name:'Start over',exact:true}).click();await page.getByText('Discard all answers in this draft?',{exact:true}).waitFor();await shot('start-over-confirmation');await page.getByRole('button',{name:'Discard and start over',exact:true}).click();await saved();await page.getByRole('radio').first().waitFor();assert.equal(await page.locator('input[type=radio]:checked').count(),0);const s=await state();assert.ok(s.practiceDrafts.find(d=>d.id===before.id).deletedAt);const after=s.practiceDrafts.find(d=>d.resourceId===info.quizId&&!d.deletedAt);assert.notEqual(after.id,before.id);assert.deepEqual(after.answers,{});await shot('new-attempt');});
 for(const theme of ['light','midnight','dark']) {
   await page.evaluate(async theme=>{const r=await fetch('/api/settings',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({theme,textSize:theme==='light'?'large':'standard',density:theme==='light'?'comfortable':'compact'})});if(!r.ok)throw new Error(await r.text());},theme);
   await page.setViewportSize({width:theme==='light'?1024:1440,height:1000});
   await page.reload({waitUntil:'domcontentloaded'});await open();await page.getByRole('radio').first().check();await saved();
   await step(`${theme} theme selected control and layout`,async()=>{assert.equal(await page.evaluate(()=>document.documentElement.dataset.theme),theme);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));const colors=await page.getByRole('radio').first().evaluate(node=>({accent:getComputedStyle(node).accentColor,text:getComputedStyle(document.documentElement).getPropertyValue('--text').trim()}));console.log('CONTROL '+JSON.stringify({theme,...colors}));await page.getByRole('radio').first().focus();await shot(theme==='light'?'light-large-selected':theme+'-selected');});
 }
 await page.getByRole('button',{name:'Next',exact:true}).click();await page.locator('textarea.question__answer').fill('I want to check which inverse operation to use.');await saved();await shot('review-ready');
 assert.deepEqual(errors,[]);
 console.log('PASS no uncaught browser errors');
 await writeFile(`${evidence}/ui-proof.json`,JSON.stringify({url:info.url,fixture:info.fixture,viewport:'1440x1000; light/large/comfortable 1024x1000',browser:'Playwright + installed Chrome after T3 preview and CUA unavailable',steps,errors},null,2)+'\n');
} finally {
 if(failureDirectory)await rm(info.directory+'/state.json.tmp',{recursive:true});
 await rm(info.directory+'/fail-grade',{force:true});
 await rm(info.directory+'/slow-grade',{force:true});
 await context.close();await browser.close();
}
