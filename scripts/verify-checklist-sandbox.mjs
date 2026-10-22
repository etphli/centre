// Run: CENTRE_PLAYWRIGHT_MODULE=/tmp/pw-check/node_modules/playwright/index.mjs node --import tsx scripts/verify-checklist-sandbox.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer as createViteServer } from 'vite';
import react from '@vitejs/plugin-react';
import { createService } from '../server/index.ts';
import { Store } from '../server/store.ts';

const evidence = process.env.CENTRE_SANDBOX_EVIDENCE || await mkdtemp('/tmp/centre-sandbox-');
await mkdir(evidence,{recursive:true});
const dataDir = join(evidence,'store');
const report = { evidence, browser:null, fallbackReasons:[
  'Preview automation client server-browser disconnected during click. (parent: aria-ref=t3-fb9d2c92-8n-e52)',
  'Preview automation client server-browser disconnected during click. (parent: role=button[name="Tomorrow’s study plan"])',
], cases:[], controls:[], console:[], failures:[] };
const sourceFiles=['server/diagram.ts','server/index.ts','server/store.ts','server/checklist-progress.ts','src/ui/DiagramFrame.tsx','src/ui/diagram.css','src/data/client.ts','shared/checklist-progress.ts','shared/checklist-progress-queue.ts'];
const sourceHashes=async()=>Object.fromEntries(await Promise.all(sourceFiles.map(async file=>[file,createHash('sha256').update(await readFile(file)).digest('hex')])));
report.sourceHashes=await sourceHashes();
const hits = [];
const canary = createServer((req,res) => {
  hits.push({url:req.url,method:req.method,time:Date.now()});
  res.setHeader('Access-Control-Allow-Origin','*');
  res.end('<!doctype html><p id="landed">Canary navigation landed</p>');
});
await new Promise(resolve => canary.listen(0,'127.0.0.1',resolve));
const canaryOrigin = `http://127.0.0.1:${canary.address().port}`;
const cases = ['self-assign','self-replace','self-href','parent-navigation','top-navigation','link-self','link-parent','link-top','link-blank','form-self','form-parent','form-top','fetch','beacon','image','style-link','style-import','style-image','nested-frame','wrong-frame-outer','wrong-frame-app','wrong-scope','extra-keys'];
// These handlers execute inside generated HTML. Each case gets a fresh loaded document.
const attack = function(name,base) {
  window.attackTriggered=name;
  window.__recordSandboxAttempt?.(name);
  const url = base+'/'+name;
  const link = target => {const a=document.createElement('a');a.href=url;a.target=target;document.body.append(a);a.click();};
  const form = target => {const f=document.createElement('form');f.action=url;f.target=target;document.body.append(f);f.requestSubmit();};
  const message = {type:'centre:checklist-change',...window.attackScope,itemId:'study',checked:true};
  try {
    switch(name) {
      case 'self-assign': location.assign(url);break;
      case 'self-replace': location.replace(url);break;
      case 'self-href': location.href=url;break;
      case 'parent-navigation': parent.location=url;break;
      case 'top-navigation': top.location=url;break;
      case 'link-self': link('_self');break;
      case 'link-parent': link('_parent');break;
      case 'link-top': link('_top');break;
      case 'link-blank': link('_blank');break;
      case 'form-self': form('_self');break;
      case 'form-parent': form('_parent');break;
      case 'form-top': form('_top');break;
      case 'fetch': fetch(url).catch(e=>window.attackErrors.push(String(e)));break;
      case 'beacon': window.beaconResult=navigator.sendBeacon(url,'attack');break;
      case 'image': {const image=new Image();image.src=url;document.body.append(image);break;}
      case 'style-link': {const l=document.createElement('link');l.rel='stylesheet';l.href=url;document.head.append(l);break;}
      case 'style-import': {const s=document.createElement('style');s.textContent='@import url("'+url+'");';document.head.append(s);break;}
      case 'style-image': document.body.style.backgroundImage='url("'+url+'")';break;
      case 'nested-frame': {const f=document.createElement('iframe');f.src=url;document.body.append(f);break;}
      case 'wrong-frame-outer': {const f=document.createElement('iframe');f.srcdoc='<script>parent.parent.postMessage('+JSON.stringify(message)+',"*");parent.postMessage({attackChildExecuted:true},"*")<'+ '/script>';document.body.append(f);break;}
      case 'wrong-frame-app': top.postMessage(message,'*');break;
      case 'wrong-scope': parent.postMessage({...message,resourceId:'different-resource'},'*');break;
      case 'extra-keys': parent.postMessage({...message,extra:true},'*');break;
    }
  } catch(e) {window.attackErrors.push(String(e));}
  window.attackTriggered=name;
};
const content = `<h1>Independent sandbox verification</h1><label><input type="checkbox" data-centre-checklist-id="study">Study checkbox</label><p id="ready">not ready</p>${cases.map(name=>`<button id="${name}" onclick="runAttack('${name}')">${name}</button>`).join('')}<script>window.attackErrors=[];window.violations=[];addEventListener('securitypolicyviolation',e=>violations.push({directive:e.effectiveDirective,blockedURI:e.blockedURI}));addEventListener('message',e=>{if(e.data?.attackChildExecuted)window.attackChildExecuted=true;if(e.source===parent&&e.data?.type==='centre:checklist-restore')window.attackScope={resourceId:e.data.resourceId,documentRevision:e.data.documentRevision}});window.runAttack=name=>(${attack.toString()})(name,${JSON.stringify(canaryOrigin+'/attack')});document.getElementById('ready').textContent='generated script executing';</script>`;
const resource = {id:'sandbox-verification',subjectId:null,topicId:null,title:'Sandbox verification',kind:'diagram',createdAt:'2026-10-20T00:00:00.000Z',updatedAt:'2026-10-20T00:00:00.000Z',content,questions:[],questionTypes:['multiple_choice','short_response','long_response'],testLength:null,durationMinutes:null,completedAt:null};
let service, vite, browser, electronApp;
const count = path => hits.filter(hit=>new URL(hit.url,canaryOrigin).pathname===path).length;
const disk = async () => JSON.parse(await readFile(join(dataDir,'state.json'),'utf8'));
try {
  process.env.CENTRE_CODEX_BIN='/centre-test/no-codex-binary';
  const store = await Store.open(dataDir);store.state.resources.push(resource);await store.save();
  service = await createService({dataDir});
  const allocation=createServer();await new Promise(resolve=>allocation.listen(0,'127.0.0.1',resolve));
  const vitePort=allocation.address().port;await new Promise(resolve=>allocation.close(resolve));
  let saves=0;
  vite = await createViteServer({configFile:false,root:resolve('.'),cacheDir:join(evidence,'vite-cache'),plugins:[react(),{
    name:'sandbox-verification-fixture',
    resolveId(id) {if(id==='/__sandbox-entry.jsx')return '\0sandbox-entry';},
    load(id) {if(id==='\0sandbox-entry')return `import React from 'react';import {createRoot} from 'react-dom/client';import {DiagramFrame} from '/src/ui/DiagramFrame.tsx';createRoot(document.getElementById('root')).render(React.createElement(DiagramFrame,{resource:${JSON.stringify(resource)}}));`;},
    configureServer(server) {server.middlewares.use('/__sandbox',async (req,res,next)=>{if(req.url && req.url!=='/' && !req.url.startsWith('?'))return next();res.setHeader('Content-Type','text/html');res.end(await server.transformIndexHtml('/__sandbox','<!doctype html><div id="root"></div><script type="module" src="/\u0040vite/client"></script><script type="module" src="/__sandbox-entry.jsx"></script>'));});},
  }],server:{host:'127.0.0.1',port:vitePort,strictPort:true,proxy:{'/api':{target:`http://127.0.0.1:${service.port}`,configure(proxy){proxy.on('proxyReq',req=>{req.setHeader('Authorization',`Bearer ${service.token}`);if(req.path.endsWith('/checklist-progress'))saves++;});}}}}});
  await vite.listen();
  const origin=`http://127.0.0.1:${vite.httpServer.address().port}`;
  const module = process.env.CENTRE_PLAYWRIGHT_MODULE;
  const {chromium,_electron}=await import(module ? pathToFileURL(resolve(module)).href : 'playwright');
  let context,newPage;
  if(process.env.CENTRE_SANDBOX_ENGINE==='electron') {
    const entry=join(evidence,'electron-main.cjs');
    await writeFile(entry,`const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>{new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,webSecurity:true,backgroundThrottling:false}}).loadURL('about:blank')});`);
    const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
    electronApp=await _electron.launch({executablePath:createRequire(import.meta.url)('electron'),args:[entry],env});
    context=electronApp.context();report.browser=await electronApp.evaluate(()=>({electron:process.versions.electron,chromium:process.versions.chrome}));
    newPage=async()=>{
      const event=electronApp.waitForEvent('window');
      await electronApp.evaluate(({BrowserWindow})=>{new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,webSecurity:true,backgroundThrottling:false}}).loadURL('about:blank');});
      return event;
    };
  } else {
    browser=await chromium.launch({headless:true,...(process.env.CENTRE_CHROMIUM_EXECUTABLE ? {executablePath:process.env.CENTRE_CHROMIUM_EXECUTABLE} : {})});report.browser=browser.version();
    context=await browser.newContext();newPage=()=>context.newPage();
  }
  const attempts=[];
  await context.exposeBinding('__recordSandboxAttempt',({frame},name)=>attempts.push({name,frameUrl:frame.url()}));
  context.setDefaultTimeout(15000);const page=electronApp ? await electronApp.firstWindow() : await newPage();
  page.on('console',message=>{if(message.type()==='error'||message.type()==='warning')report.console.push(message.text().replace(/\/artifacts\/[^/\s]+\/[^?\s"']+/g,'/artifacts/REDACTED'));});
  const loaded=async()=>{
    await page.goto(origin+'/__sandbox/');
    const outer=await (await page.locator('iframe.diagram-embed').elementHandle()).contentFrame();
    await outer.locator('#diagram').waitFor();
    const inner=await (await outer.locator('#diagram').elementHandle()).contentFrame();
    await inner.locator('#ready').filter({hasText:'generated script executing'}).waitFor();
    await inner.getByRole('checkbox').waitFor({state:'visible'});
    await inner.waitForFunction(()=>window.attackScope?.documentRevision,null,{timeout:15000});
    return {outer,inner};
  };
  for(const name of cases) {
    console.log('Testing '+name);
    const {outer,inner}=await loaded();const before=saves;const consoleStart=report.console.length;
    const beforeDocument=await inner.evaluate(()=>({ready:document.querySelector('#ready')?.textContent,checkboxVisible:document.querySelector('input').getBoundingClientRect().width>0,origin:origin}));
    if(name==='self-assign')await page.screenshot({path:join(evidence,'loaded-before-self-navigation.png'),fullPage:true});
    const path='/attack/'+name;const beforeHits=count(path);
    const beforeAttempts=attempts.filter(attempt=>attempt.name===name).length;
    await inner.locator('#'+name).press('Enter');await page.waitForTimeout(450);
    let observed;
    try {observed=await inner.evaluate(()=>({triggered:window.attackTriggered,errors:window.attackErrors,violations:window.violations,beaconResult:window.beaconResult,ready:document.querySelector('#ready')?.textContent,scope:window.attackScope,attackChildExecuted:window.attackChildExecuted}));}catch(e){observed={lostDocument:true,error:String(e)};}
    const result={name,loadedExecutingBefore:true,beforeDocument,executionRecords:attempts.filter(attempt=>attempt.name===name).length-beforeAttempts,httpHits:count(path)-beforeHits,saveRequests:saves-before,topStayed:page.url()===origin+'/__sandbox/',browserReasons:report.console.slice(consoleStart),observed,afterFrameUrl:inner.url()};
    report.cases.push(result);
    const recoveryExpected=['self-assign','self-replace','self-href','link-self'].includes(name);
    if(recoveryExpected){
      result.recovery={noticeVisible:await outer.locator('#navigation-blocked').isVisible(),frameUrl:inner.url(),heading:await inner.locator('h1').textContent(),checkboxVisible:await inner.getByRole('checkbox').isVisible()};
      if(!result.recovery.noticeVisible||result.recovery.heading!=='Checklist'||!result.recovery.checkboxVisible||inner.url()!=='about:srcdoc')report.failures.push(name+':recovery-not-loaded');
      const checked=await inner.getByRole('checkbox').isChecked();
      const expected=(await disk()).interactiveResourceProgress[0]?.checkedItemIds.includes('study')??false;
      assert.equal(checked,expected,'Recovery retains durable state');
      await inner.getByRole('checkbox').setChecked(!checked);
      const deadline=Date.now()+15000;
      while(((await disk()).interactiveResourceProgress[0]?.checkedItemIds.includes('study')??false)===checked&&Date.now()<deadline)await page.waitForTimeout(50);
      assert.equal((await disk()).interactiveResourceProgress[0].checkedItemIds.includes('study'),!checked);
      result.recovery.trustedClickSaved=true;result.recovery.saveRequests=saves-before;
      assert.equal(result.recovery.saveRequests,1,'Recovery must not replay progress or reset itself');
      await page.screenshot({path:join(evidence,name+'-recovered.png'),fullPage:true});
    }
    if(result.httpHits || result.saveRequests || !result.topStayed || result.executionRecords!==1 || (!recoveryExpected&&observed.triggered!==name))report.failures.push(name);
    if(name==='wrong-frame-outer'&&!observed.attackChildExecuted)report.failures.push('wrong-frame-outer:child-did-not-execute');
    if(!observed.ready)await page.screenshot({path:join(evidence,name+'-after.png'),fullPage:true});
  }
  // An unrestricted document executes the same attack functions. HTTP counts prove
  // the canary and the navigation/resource triggers are live, independently per case.
  for(const name of cases.filter(name=>!name.startsWith('wrong-')&&name!=='extra-keys')) {
    const control=await newPage();const path='/control/'+name;const before=count(path);
    await control.setContent(`<p>Unrestricted positive control</p><button id="go">Go</button>`);
    await control.evaluate(({source,base,name})=>{window.attackErrors=[];document.querySelector('#go').onclick=()=>Function('return ('+source+')')()(name,base);},{source:attack.toString(),base:canaryOrigin+'/control',name});
    await control.locator('#go').press('Enter');await page.waitForTimeout(450);
    const observed=count(path)-before;report.controls.push({name,httpHits:observed});
    if(!observed)report.failures.push('positive-control:'+name);
    await control.close();
  }
  const {inner}=await loaded();const before=saves;
  await inner.getByRole('checkbox').check();
  const deadline=Date.now()+15000;let state;
  do {state=await disk();if(state.interactiveResourceProgress[0]?.checkedItemIds.includes('study'))break;await page.waitForTimeout(50);}while(Date.now()<deadline);
  assert.deepEqual(state.interactiveResourceProgress[0]?.checkedItemIds,['study']);
  assert.equal(saves,before+1);
  const saved=page.locator('.diagram-progress__saved');await saved.waitFor();
  report.design={savedCaption:await saved.textContent()};
  await page.screenshot({path:join(evidence,'saved-caption.png'),fullPage:true});
  await page.waitForTimeout(2300);report.design.savedRemoved=await saved.count()===0;assert.equal(report.design.savedRemoved,true);
  const restartConnection={port:service.port,token:service.token};
  await service.close();service=await createService({dataDir,...restartConnection});
  const reloaded=await loaded();assert.equal(await reloaded.inner.getByRole('checkbox').isChecked(),true);
  await reloaded.inner.locator('#self-assign').focus();await page.keyboard.press('Shift+Tab');
  report.design.checkbox=await reloaded.inner.getByRole('checkbox').evaluate(input=>({appearance:getComputedStyle(input).appearance,fill:getComputedStyle(input).backgroundColor,checkmarkOpacity:getComputedStyle(input,'::after').opacity,focusVisible:input.matches(':focus-visible'),outline:getComputedStyle(input).outline}));
  assert.equal(report.design.checkbox.appearance,'none');assert.equal(report.design.checkbox.focusVisible,true);
  await page.screenshot({path:join(evidence,'persisted-reload.png'),fullPage:true});
  await page.emulateMedia({forcedColors:'active'});
  report.design.forcedColorsAppearance=await reloaded.inner.getByRole('checkbox').evaluate(input=>getComputedStyle(input).appearance);
  assert.equal(report.design.forcedColorsAppearance,'auto');
  await page.screenshot({path:join(evidence,'forced-colors.png'),fullPage:true});
  report.persistence={trustedClickSaved:true,diskCheckedItemIds:state.interactiveResourceProgress[0].checkedItemIds,reloadChecked:true,serviceRestartChecked:true,saveRequests:saves-before};
  if(report.failures.length)process.exitCode=1;
} catch(error) {report.failures.push(String(error));process.exitCode=1;}
finally {
  await electronApp?.close();await browser?.close();await vite?.close();await service?.close();await new Promise(resolve=>canary.close(resolve));
  report.finalSourceHashes=await sourceHashes();
  if(JSON.stringify(report.sourceHashes)!==JSON.stringify(report.finalSourceHashes)){report.failures.push('implementation-changed-during-verification');process.exitCode=1;}
  report.hits=hits;await writeFile(join(evidence,'report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({evidence,browser:report.browser,cases:report.cases.length,controls:report.controls.length,failures:report.failures,persistence:report.persistence},null,2));
}
