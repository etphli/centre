import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir,mkdtemp,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname,join,resolve } from 'node:path';
import { pathToFileURL,fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)),'..');
const runtime = join(root,'.runtime','interaction-qa');
const temporary = await mkdtemp(join(tmpdir(),'centre-interaction-qa-'));
await mkdir(runtime,{recursive:true});
await mkdir(join(temporary,'data'),{recursive:true});
const now = new Date().toISOString();
await writeFile(join(temporary,'data','state.json'),JSON.stringify({
  subjects:[{id:'science',name:'Synthetic Science',shortName:'Science',color:'#8ea6e8',icon:'book'}],
  topics:[{id:'electricity',subjectId:'science',name:'Electricity',description:''}],
  resources:[],chats:[],events:[],memories:[],assignments:[],settings:{nickname:'QA',theme:'dark'},
  codex:{available:false,authenticated:false,message:'Connecting'},lastSyncedAt:null,
}));

// A deterministic CLI peer exercises the real service, IPC and production renderer.
function fixtureCodex() {
  const readline = require('node:readline');
  let threads = 0, sequence = 100;
  const waiting = new Map(), stopped = new Set();
  const send = value => process.stdout.write(JSON.stringify(value)+'\n');
  const complete = (threadId,text) => {
    if (stopped.has(threadId)) return;
    send({method:'item/completed',params:{threadId,item:{type:'agentMessage',id:'answer',phase:'final_answer',text:JSON.stringify({response:{kind:'message',content:text}})}}});
    send({method:'turn/completed',params:{threadId,turn:{status:'completed'}}});
  };
  const call = (threadId,tool,args,after) => {const id = ++sequence; waiting.set(id,after); send({id,method:'item/tool/call',params:{threadId,tool,arguments:args}});};
  const save = (threadId,kind,personal = false) => {
    if (stopped.has(threadId)) return;
    const generated = kind === 'quiz' ? {title:'Electricity quiz',content:'',questions:Array.from({length:5},(_,index) => ({responseType:'short_response',choices:[],prompt:`Explain circuit idea ${index + 1}.`,answer:'A complete circuit carries current.',explanation:'A closed path is needed.',marks:1}))}
      : {title:'Coffee extraction explorer',content:'<style>main{padding:20px}button{padding:10px}h2{color:var(--centre-text)}</style><main><h2>Coffee extraction</h2><p>Change the grind to explore surface area.</p><button id="explore" onclick="this.textContent=\'Finer grind: more surface area\'">Try a finer grind</button></main>',questions:[]};
    call(threadId,'centre_save_resource',{kind,subjectId:personal ? null : 'science',topicId:personal ? null : 'electricity',instructions:'Verification fixture',...(kind === 'quiz' ? {questionCount:5,questionTypes:['short_response']} : {}),generated},result => complete(threadId,result.success ? 'Your resource is ready.' : 'The fixture save failed.'));
  };
  readline.createInterface({input:process.stdin}).on('line',line => {
    const message = JSON.parse(line);
    if (!message.method && waiting.has(message.id)) {const after = waiting.get(message.id); waiting.delete(message.id); after(message.result); return;}
    if (!message.id) return;
    let result = {};
    if (message.method === 'account/read') result = {account:{id:'fixture'}};
    if (message.method === 'model/list') result = {data:['gpt-6.1-sol','gpt-6-luna'].map(model => ({model,displayName:model,hidden:false,supportedReasoningEfforts:['low','medium','high'].map(reasoningEffort => ({reasoningEffort})),defaultReasoningEffort:'medium'})),nextCursor:null};
    if (message.method === 'thread/start') result = {thread:{id:'thread-'+(++threads)}};
    send({id:message.id,result});
    if (message.method === 'turn/start') {
      const threadId = message.params.threadId;
      stopped.delete(threadId);
      const prompt = message.params.input[0].text;
      const text = prompt.split('Student message:\n')[1] ?? '';
      send({method:'turn/started',params:{threadId,turn:{id:'turn-'+sequence}}});
      send({method:'item/reasoning/summaryTextDelta',params:{threadId,itemId:'reasoning',summaryIndex:0,delta:'Checking the request and choosing a useful learning activity.'}});
      if (prompt.includes('The student answered your popup.')) complete(threadId,'You chose Yes.');
      else if (/like blue/i.test(text)) {
        const response = {kind:'questions',questions:[{id:'blue',header:'Colour',question:'Do you like blue?',options:[{label:'Yes',description:''},{label:'No',description:''}]}]};
        send({method:'item/completed',params:{threadId,item:{type:'agentMessage',id:'answer',phase:'final_answer',text:JSON.stringify({response})}}});
        send({method:'turn/completed',params:{threadId,turn:{status:'completed'}}});
      }
      else if (/take your time/i.test(text)) {
        send({method:'item/completed',params:{threadId,item:{type:'agentMessage',id:'update',phase:'commentary',text:'I am checking how current flows through a series circuit.'}}});
        setTimeout(() => complete(threadId,'Current is the same through every part of a series circuit.'),9000);
      } else if (/interactive|\/diagram/i.test(text)) save(threadId,'diagram',true);
      else {
        const questions = [{id:'format',header:'Quiz format',question:'Use five short-response questions for this five-minute electricity quiz?',options:[{label:'Five short responses',description:'Practise explaining each idea in your own words.'},{label:'Choose another format',description:'Tell me your preferred format.'}]}];
        if (/two questions/i.test(text)) questions.push({id:'level',header:'Difficulty',question:'How challenging should it be?',options:[]});
        call(threadId,'centre_ask_question',{questions},result => {if (result.success) save(threadId,'quiz');});
      }
    }
    if (message.method === 'turn/interrupt') {stopped.add(message.params.threadId); send({method:'turn/completed',params:{threadId:message.params.threadId,turn:{status:'interrupted'}}});}
  });
}

async function electronRunner(config) {
  const {app,BrowserWindow,dialog} = require('electron');
  const {writeFile} = require('node:fs/promises');
  const assert = require('node:assert/strict');
  app.setPath('userData',config.userData);
  dialog.showErrorBox = (title,message) => {console.error(title,message);app.exit(1);};
  const errors = [], checks = [];
  let window,finished = false;
  const pause = ms => new Promise(resolve => setTimeout(resolve,ms));
  const evaluate = code => window.webContents.executeJavaScript(code);
  const check = (name,value) => {assert.ok(value,name);checks.push(name);console.log('PASS '+name);};
  const waitFor = async code => {for(let i = 0;i < 200;i++){if(await evaluate(code))return;await pause(100);}throw new Error('Timed out: '+code);};
  const click = async selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const clickText = async (selector,text) => evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})].find(node=>node.textContent.includes(${JSON.stringify(text)})).click()`);
  const type = async (selector,value) => evaluate(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(Object.getPrototypeOf(node),'value').set.call(node,${JSON.stringify(value)});node.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const state = () => evaluate("window.centre.request('GET','/state')");
  const screenshot = async name => {
    for(let attempt=0;attempt<3;attempt++){
      await pause(250);
      try {await writeFile(config.runtime+'/'+name+'.png',(await window.webContents.capturePage()).toPNG());return;}
      catch(error){if(attempt===2 || !String(error).includes('UnknownVizError'))throw error;}
    }
  };
  const send = async text => {await type('textarea[aria-label="Message Centre"]',text);await click('button[aria-label="Send"]');};
  const newChat = async () => {await click('.sidebar button[aria-label="New chat"], nav[aria-label="Main"] button');await waitFor("Boolean(document.querySelector('.home textarea'))");};
  const finish = async error => {
    if (finished) return;finished = true;
    await writeFile(config.runtime+'/results.json',JSON.stringify({passed:!error,checks,errors,error:error?.stack},null,2));
    if(error){console.error(error);app.exit(1);}else app.quit();
  };
  app.on('browser-window-created',(_event,created) => {
    if(window)return;window = created;
    window.webContents.setBackgroundThrottling(false);
    window.webContents.on('console-message',(_event,...args) => {const detail = args[0];if(detail?.level === 'error')errors.push(detail.message);});
    window.webContents.once('did-finish-load',async () => {
      try {
        await waitFor("Boolean(document.querySelector('.home textarea') && window.centre)");
        check('Production desktop renderer is meaningful and isolated',await evaluate("document.title === 'Centre' && typeof require === 'undefined' && document.body.innerText.includes('QA')"));
        await click('button[aria-label="Choose model"]');await waitFor("document.querySelectorAll('[role=menuitemradio]').length === 2");
        await clickText('[role=menuitemradio]','Luna');
        check('A one-chat model choice leaves the saved default unchanged',(await state()).settings.chatModel === 'gpt-6.1-sol');
        await send('Make a 5 minute quiz for my science yearly for electricity');
        await waitFor("Boolean(document.querySelector('.question-dialog[open]'))");
        check('The AI asks in a modal with explicit choice and custom answer',await evaluate("document.querySelectorAll('.question-dialog input[type=radio]').length === 3 && document.querySelectorAll('.question-dialog input:checked').length === 0 && document.querySelector('.question-dialog button[type=submit]').disabled"));
        await screenshot('question-popup');
        await click('.question-dialog input[type=radio]');await click('.question-dialog button[type=submit]');
        await waitFor("!document.querySelector('.question-dialog') && Boolean(document.querySelector('.thread-resources'))");
        let snapshot = await state();
        check('Answer resumes the original turn and saves a subject quiz',snapshot.chats[0].messages.length === 3 && snapshot.resources[0].kind === 'quiz' && snapshot.resources[0].subjectId === 'science');
        check('Chat model is scoped to the conversation',snapshot.chats[0].modelSelection.model === 'gpt-6-luna' && snapshot.settings.chatModel === 'gpt-6.1-sol');
        check('Applied skills are visible',await evaluate("document.querySelector('.skill-usage').textContent.includes('Ask questions')"));
        await send('Explain series circuits, take your time');await waitFor("Boolean(document.querySelector('.activity-row'))");
        await click('.thinking-details--live>summary');await pause(5000);
        check('Thinking has one expandable row, elapsed time and rotating words',await evaluate("document.querySelectorAll('.activity-row').length === 1 && document.querySelector('.thinking-details--live[open]') && document.querySelector('.working__time').textContent.includes('s') && document.querySelector('.thinking-label').textContent !== 'Thinking it through'"));
        check('Expanded thinking stays above the composer',await evaluate("document.querySelector('.thinking-details--live').getBoundingClientRect().bottom <= document.querySelector('.chat-page__composer').getBoundingClientRect().top"));
        await screenshot('thinking-activity');
        await waitFor("!document.querySelector('.activity-row')");
        await newChat();
        check('A fresh chat returns to the saved default',await evaluate("document.querySelector('button[aria-label=\"Choose model\"]').textContent.includes('Sol')"));
        await send('Ask me a question as a test, like do you like blue');
        await waitFor("Boolean(document.querySelector('.question-dialog[open]'))");
        check('Structured final questions open the popup without a question-tool call',(await state()).chats[0].activity.some(step=>step.id.startsWith('question:')));
        await screenshot('structured-question-popup');
        await click('.question-dialog input[type=radio]');await click('.question-dialog button[type=submit]');
        await waitFor("!document.querySelector('.question-dialog') && document.querySelector('.thread')?.textContent.includes('You chose Yes.')");
        check('Structured popup answers resume the original request',(await state()).chats[0].messages.at(-1).content === 'You chose Yes.');
        await newChat();
        await send('/diagram coffee extraction for personal learning');
        await waitFor("Boolean(document.querySelector('.thread-resources__diagram'))");
        snapshot = await state();
        check('Slash diagram keeps the original user prompt visible',snapshot.chats[0].messages[0].content === '/diagram coffee extraction for personal learning');
        check('The diagram skill loads automatically and personal learning has no fake subject',snapshot.resources[0].subjectId === null && snapshot.resources[0].topicId === null && snapshot.chats[0].messages.at(-1).activity.some(step => step.kind === 'skill' && step.text === 'Study diagrams'));
        await waitFor("Boolean(document.querySelector('.thread-resources__diagram iframe'))");
        for(let i=0;i<50 && !window.webContents.mainFrame.frames.some(frame=>frame.url.includes('/artifacts/'));i++)await pause(100);
        const diagramFrame = window.webContents.mainFrame.frames.find(frame => frame.url.includes('/artifacts/'));
        check('A real diagram frame is embedded',Boolean(diagramFrame));
        for(let i=0;i<50 && !await diagramFrame.executeJavaScript("Boolean(document.getElementById('explore'))");i++)await pause(100);
        await diagramFrame.executeJavaScript("document.getElementById('explore').click()");
        check('Diagram controls work inside the sandbox',await diagramFrame.executeJavaScript("document.getElementById('explore').textContent.includes('surface area')"));
        await newChat();await send('Make something interactive about coffee extraction outside school');
        await waitFor("Boolean(document.querySelector('.thread-resources__diagram'))");
        check('Interactive wording automatically creates a diagram',(await state()).resources[0].kind === 'diagram');
        await clickText('nav[aria-label=Main] button','Resources');await waitFor("Boolean(document.querySelector('.personal-resources'))");
        await screenshot('personal-resources');
        const before = (await state()).resources.length;
        await click('.personal-resources button[title="Delete resource"]');await waitFor("Boolean(document.querySelector('dialog[open]'))");
        await clickText('dialog[open] .dialog__footer button','Delete resource');await waitFor("!document.querySelector('dialog[open]')");
        check('Deleting a resource updates the real store',(await state()).resources.length === before - 1);
        await clickText('.toast button','Undo');await waitFor(`window.centre.request('GET','/state').then(state=>state.resources.length===${before})`);
        check('Undo restores the deleted resource',(await state()).resources.length === before);
        await newChat();await send('Ask two questions before my quiz');await waitFor("Boolean(document.querySelector('.question-dialog'))");
        await clickText('.question-choice','Something else');await type('.question-dialog textarea','Five questions, short response');await clickText('.question-dialog button','Next');
        await waitFor("document.querySelector('.question-dialog legend')?.textContent.includes('challenging')");await type('.question-dialog textarea','A little challenging');
        await clickText('.question-dialog button','Back');
        check('Custom answers survive navigation between questions',await evaluate("document.querySelector('.question-dialog textarea').value === 'Five questions, short response'"));
        await clickText('.question-dialog button','Next');await clickText('.question-dialog button','Send answer');await waitFor("!document.querySelector('.question-dialog')");
        await newChat();await send('Another electricity quiz');await waitFor("Boolean(document.querySelector('.question-dialog'))");
        await evaluate("location.reload()");await waitFor("Boolean(document.querySelector('.question-dialog'))");
        check('Pending popup survives a renderer reload',(await state()).pendingQuestions.length === 1);
        window.setMinimumSize(380,600);window.setSize(430,800);await pause(200);
        check('Question popup fits a narrow window',await evaluate("(()=>{const r=document.querySelector('.question-dialog').getBoundingClientRect();return r.left>=0 && r.right<=innerWidth && r.bottom<=innerHeight})()"));
        await screenshot('question-narrow');
        await clickText('.question-dialog button','Stop response');await waitFor("!document.querySelector('.question-dialog')");
        check('Stopping a popup clears the active question',(await state()).pendingQuestions.length === 0);
        check('No renderer errors',errors.length === 0);
        await finish();
      }catch(error){await screenshot('failure').catch(()=>{});await finish(error);}
    });
  });
  setTimeout(() => {void finish(new Error('Verification exceeded two minutes.'));},120000).unref();
  require(config.main);
}

const binary = join(temporary,'codex-fixture');
await writeFile(binary,'#!/usr/bin/env node\n('+fixtureCodex.toString()+')();\n',{mode:0o700});
const entry = join(runtime,'runner.cjs');
await writeFile(entry,'('+electronRunner.toString()+')('+JSON.stringify({runtime,userData:join(temporary,'user'),main:join(root,'dist-electron/main.cjs')})+');\n');
const environment = {...process.env,CENTRE_DATA_DIR:join(temporary,'data'),CENTRE_CODEX_BIN:binary,CENTRE_DISABLE_UPDATES:'1',CENTRE_RENDERER_URL:pathToFileURL(join(root,'dist/index.html')).href};
delete environment.ELECTRON_RUN_AS_NODE;
try {
  const child = spawn(require('electron'),[entry],{cwd:root,env:environment,stdio:'inherit'});
  process.exitCode = await new Promise((accept,reject) => {child.once('exit',code => accept(code ?? 1));child.once('error',reject);});
} finally {await rm(temporary,{recursive:true,force:true});}
