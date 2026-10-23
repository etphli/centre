import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const root = resolve('.'), runtime = join(root, '.runtime');
await mkdir(runtime, { recursive: true });
const directory = await mkdtemp(join(tmpdir(), 'centre-attempt-ui-'));
const data = join(directory, 'data');
await mkdir(data);
const now = '2026-10-22T00:00:00.000Z';
const question = (id, prompt, answer, marks) => ({ id, prompt, answer, marks, explanation: 'Use inverse operations.', responseType: 'short_response', choices: [], concept: 'Linear equations' });
const quiz = { id:'history-quiz', subjectId:'math', topicId:'algebra', title:'Linear equations', kind:'quiz', createdAt:now, updatedAt:now, content:'', questions:[question('q1','Solve $2x = 8$.','4',2),question('q2','Solve $3x + 2 = 11$.','3',2),question('q3','Solve $x - 1 = 4$.','5',1)] };
const attempt = (index, scores, answers = {q1:'3',q2:'2',q3:''}, resourceId = quiz.id) => ({ schemaVersion:1, revision:1, id:`00000000-0000-4000-8000-${String(index).padStart(12,'0')}`, sourceDraftId:null, resourceId, answers, createdAt:`2026-10-${index === 3 ? '21' : String(19+index)}T00:00:00.000Z`, result:{ score:scores.reduce((a,b)=>a+b,0), total:5, feedback:scores.map((score,i)=>({questionId:`q${i+1}`,concept:'Linear equations',score,maxScore:i===2?1:2,feedback:i===0 && score===2?'Correct. Dividing both sides gives $x=4$.':i===1?'Subtract 2 before dividing by 3.':'Show each step before finding x.',needsReview:score<(i===2?1:2)}))} });
const attempts = [attempt(1,[0,0,0]),attempt(2,[0,1,0]),attempt(3,[2,1,0],{q1:'4',q2:'2',q3:''})];
const changed = attempt(4,[2,1,0],{q1:'4',q2:'2',q4:''});
changed.createdAt='2026-10-22T01:00:00.000Z';changed.result.total=6;changed.result.feedback[0].maxScore=3;changed.result.feedback[2].questionId='q4';
attempts.push(changed,attempt(5,[1,0,0],{q1:'Light',q2:'',q3:''},'sparse-quiz'));
const fixture = { subjects:[{id:'math',name:'Mathematics',shortName:'Maths',color:'#b6a1c7',icon:'book'},{id:'science',name:'Science',shortName:null,color:'#a2b9a6',icon:'book'}],topics:[{id:'algebra',subjectId:'math',name:'Algebra',description:''}],resources:[quiz,{...quiz,id:'sparse-quiz',title:'Light and waves',subjectId:'science',topicId:null}],chats:[],events:[],memories:[{id:'review-q2',subjectId:'math',topicId:'algebra',resourceId:quiz.id,question:quiz.questions[1].prompt,note:'Subtract before dividing.',createdAt:now,nextReviewAt:now,resolvedAt:null}],assignments:[],attempts,settings:{theme:'dark',timeZone:'Australia/Sydney'},codex:{available:false,authenticated:false,message:'Synthetic local verification.'},lastSyncedAt:null };
await writeFile(join(data,'state.json'),JSON.stringify(fixture));
if (process.argv.includes('--serve')) {
  process.env.CENTRE_CODEX_BIN='/centre-verification/no-codex';
  const {createService} = await import('../server/index.ts');
  const service = await createService({dataDir:data});
  await writeFile(join(runtime,'comparison-connection.json'),JSON.stringify({port:service.port,token:service.token}),{mode:0o600});
  console.log(`Synthetic comparison service: http://127.0.0.1:${service.port}`);
  const close=()=>{void service.close().then(()=>rm(directory,{recursive:true,force:true})).then(()=>process.exit(0));};
  process.once('SIGTERM',close);process.once('SIGINT',close);
} else {
  const entry = join(runtime,`verify-attempt-comparison-${process.pid}.cjs`);
  const evidence = join(runtime,'attempt-comparison');
  await mkdir(evidence,{recursive:true});
  const source = `
const {app,dialog}=require('electron');
const {readFile,writeFile}=require('node:fs/promises');
const assert=require('node:assert/strict');
app.disableHardwareAcceleration();app.setPath('userData',${JSON.stringify(join(directory,'user'))});
dialog.showErrorBox=(title,message)=>{console.error(title+': '+message);app.exit(1);};
let win,done=false;const checks=[],errors=[];
const evaluate=source=>win.webContents.executeJavaScript(source,true);
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function wait(source){for(let i=0;i<150;i++){if(await evaluate(source))return;await delay(100);}throw new Error('Timed out '+source+'\\n'+await evaluate('document.body.innerText'));}
async function check(name,source){assert.ok(await evaluate(source),name);checks.push(name);console.log('PASS '+name);}
async function click(text){await evaluate('(()=>{const b=[...document.querySelectorAll("button")].find(b=>b.textContent.trim()==='+JSON.stringify(text)+');if(!b)throw new Error("Missing button "+'+JSON.stringify(text)+');b.click();})()');}
async function choose(label,index){await evaluate('document.querySelector('+JSON.stringify('[role="combobox"][aria-label="'+label+'"]')+').click()');await wait('document.querySelectorAll("[role=option]").length>'+index);await evaluate('[...document.querySelectorAll("[role=option]")]['+index+'].dispatchEvent(new MouseEvent("mousedown",{bubbles:true,cancelable:true}))');}
async function shot(name){await evaluate('document.querySelector(".attempt-history")?.scrollIntoView({block:"start"})');await delay(300);await writeFile(${JSON.stringify(evidence)}+'/'+name+'.png',(await win.webContents.capturePage()).toPNG());}
async function finish(error){if(done)return;done=true;if(error)console.error(error);await writeFile(${JSON.stringify(evidence)}+'/'+process.env.CENTRE_COMPARISON_PHASE+'.json',JSON.stringify({passed:!error,checks,errors,error:error?.message},null,2));error?app.exit(1):app.quit();}
app.on('browser-window-created',(_event,w)=>{if(win)return;win=w;win.setSize(1280,1000);win.webContents.setBackgroundThrottling(false);win.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message);});win.webContents.once('did-finish-load',async()=>{try{
 await wait('Boolean(window.centre)&&Boolean(document.querySelector(".study-timer button:not(:disabled)"))');
 await click('Log');await click('Attempts');await wait('Boolean(document.querySelector(".attempt-summary"))');
 await check('Production Log comparison through real Electron IPC','document.title==="Centre"&&document.querySelector("h1").textContent==="Log"');
 const state=await evaluate('window.centre.request("GET","/state")');assert.deepEqual(state.attempts,${JSON.stringify(attempts)});checks.push('All saved attempts retain exact content');
 if(process.env.CENTRE_COMPARISON_PHASE==='restart'){
  await choose('Attempt subject',4);await wait('document.querySelector(".attempt-links")?.textContent.includes("Resource unavailable")');
  await check('Archived resource history survives app restart','document.querySelectorAll(".attempt-trend tbody tr").length===4');
  await shot('desktop-restart-archived');await evaluate('window.centre.request("POST","/resources/history-quiz/restore",{})');
  const disk=JSON.parse(await readFile(${JSON.stringify(join(data,'state.json'))},'utf8'));assert.deepEqual(disk.attempts,${JSON.stringify(attempts)});assert.equal(disk.memories[0].resourceId,'history-quiz');checks.push('Archive and restart preserve attempts and review links');
  assert.deepEqual(errors,[]);await finish();return;
 }
 await choose('Attempt resource',0);await wait('document.querySelectorAll(".attempt-trend tbody tr").length===1');
 await check('Sparse history explains how to compare','document.querySelector(".attempt-history").textContent.includes("One saved attempt so far")');
 await choose('Attempt subject',1);await wait('document.querySelector(".study-empty h3")?.textContent.includes("No attempts match")');
 await check('Empty subject gives a resource action','document.querySelector(".study-empty").textContent.includes("Open resources")');
 await choose('Attempt subject',2);await wait('document.querySelectorAll(".attempt-trend tbody tr").length===4');
 await evaluate('[...document.querySelectorAll("[role=combobox]")].find(e=>e.getAttribute("aria-label")==="Attempt subject").focus()');
 win.focus();win.webContents.sendInputEvent({type:'keyDown',keyCode:'Down'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Down'});
 await wait('Boolean(document.querySelector("[role=listbox]"))');
 await check('Keyboard opens the subject picker','document.activeElement?.getAttribute("aria-expanded")==="true"');
 await shot('desktop-keyboard');
 win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});await wait('!document.querySelector("[role=listbox]")');
 await check('Different totals and sets show caveat','document.querySelector(".attempt-delta").textContent.includes("mark allocations differ")');
 await shot('desktop-changed-marks');
 await choose('Attempt to review',2);await wait('document.querySelector(".attempt-summary").textContent.includes("60%")');
 await evaluate('document.querySelectorAll(".attempt-question").forEach(q=>q.open=true)');
 await check('Improvement repeated mistakes and unanswered are distinct','document.querySelector(".attempt-questions").textContent.includes("Higher saved score")&&document.querySelector(".attempt-questions").textContent.includes("Needs work again")&&document.querySelector(".attempt-summary").textContent.includes("1 unanswered")');
 await shot('desktop-dark');
 await evaluate('document.querySelector(".attempt-questions").scrollIntoView({block:"start"})');await delay(300);await writeFile(${JSON.stringify(evidence)}+'/desktop-answers.png',(await win.webContents.capturePage()).toPNG());
 await choose('Earlier attempt',0);await wait('document.querySelector(".attempt-delta").textContent.includes("60 percentage points higher")');
 await choose('Attempt to review',1);await wait('document.querySelector(".attempt-summary").textContent.includes("20%")');
 await check('Chronological picker retains tie order','[...document.querySelectorAll("[role=combobox]")].find(e=>e.getAttribute("aria-label")==="Attempt to review").textContent.includes("Attempt 2")');
 await choose('Attempt to review',2);await choose('Earlier attempt',0);
 await click('Open Linear equations');await wait('Boolean(document.querySelector(".quiz"))');await click('Compare attempts');await wait('Boolean(document.querySelector(".attempt-summary"))');
 await check('Resource links return directly to its comparison','document.querySelector(".attempt-trend tbody").textContent.includes("50%")');
 await evaluate('window.centre.request("PATCH","/settings",{theme:"light",textSize:"large"})');await wait('document.documentElement.dataset.theme==="light"&&document.documentElement.dataset.textSize==="large"');await check('Saved light theme and large text actually render','getComputedStyle(document.documentElement).colorScheme==="light"');await shot('desktop-light-large');
 win.setMinimumSize(600,660);win.setSize(760,1000);await wait('innerWidth===760');await shot('desktop-narrow');
 await check('Comparison contains no page-width overflow','document.documentElement.scrollWidth<=window.innerWidth');
 await evaluate('window.centre.request("POST","/resources/history-quiz/archive",{})');await delay(1300);
 await choose('Attempt subject',4);await wait('document.querySelector(".attempt-links")?.textContent.includes("Resource unavailable")');
 await shot('desktop-archived');
 assert.deepEqual(errors,[]);checks.push('No renderer console errors');await finish();
}catch(error){await finish(error);}});});
setTimeout(()=>finish(new Error('Comparison verification timed out')),60000).unref();
require(${JSON.stringify(join(root,'dist-electron/main.cjs'))});
`;
  await writeFile(entry,source);
  let failed=false;
  try {
    for (const phase of ['initial','restart']) {
      const env={...process.env,CENTRE_COMPARISON_PHASE:phase,CENTRE_DATA_DIR:data,CENTRE_USER_DATA_DIR:join(directory,'user'),CENTRE_RENDERER_URL:pathToFileURL(join(root,'dist/index.html')).href,CENTRE_CODEX_BIN:'/centre-verification/no-codex'};
      delete env.ELECTRON_RUN_AS_NODE;
      const child=spawn(require('electron'),[entry],{env,cwd:root,stdio:'inherit'});
      const code=await new Promise((accept,reject)=>{child.once('error',reject);child.once('exit',accept);});
      if(code!==0){failed=true;break;}
    }
  } finally { await rm(entry,{force:true});await rm(directory,{recursive:true,force:true}); }
  if(failed)process.exitCode=1;
}
