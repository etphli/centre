import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { emptySnapshot } from '../server/store.ts';
import { resourceSchema } from '../shared/schema.ts';
const require = createRequire(import.meta.url);
const root = resolve('.'), runtime = join(root,'.runtime/notifications');
const temporary = await mkdtemp(join(tmpdir(),'centre-notifications-ui-'));
const data = join(temporary,'data'); await mkdir(data); await mkdir(runtime,{recursive:true});
const state = emptySnapshot(); state.settings.theme = 'light'; const now = new Date().toISOString();
state.subjects.push({id:'science',name:'Science',shortName:'Science',icon:'book',color:'#8ea6e8'});
state.resources.push(resourceSchema.parse({id:'notice',kind:'notes',subjectId:'science',topicId:null,title:'Ecosystems assessment: Notification',createdAt:now,updatedAt:now,content:'Year 9 Science assessment notification\n\nDate: 5 November 2026\n\nBring a ruler. Explain energy flow in an ecosystem.',notification:{itemId:'assignment',attachmentId:'attachment',fileName:'notification.txt',contentType:'text/plain',downloadPath:'/attachments/attachment/file'}}));
await writeFile(join(data,'state.json'),JSON.stringify(state));
function runner(config) {
  const {app} = require('electron'); const {writeFile} = require('node:fs/promises'); const assert = require('node:assert/strict');
  app.setPath('userData',config.userData); let window;
  const pause = ms => new Promise(resolve=>setTimeout(resolve,ms));
  const evaluate = code => window.webContents.executeJavaScript(code);
  async function wait(code) { for(let i=0;i<150;i++){if(await evaluate(code))return;await pause(100);}throw new Error(`Timed out: ${code}`); }
  async function screenshot(name) { window.show();window.focus();window.webContents.invalidate();await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');await pause(500);await writeFile(`${config.runtime}/${name}.png`,(await window.webContents.capturePage()).toPNG()); }
  app.on('browser-window-created',(_event,created)=>{ window=created;window.webContents.setBackgroundThrottling(false); window.setSize(1280,800);window.webContents.once('did-finish-load',async()=>{
    try {
      await wait("Boolean(document.querySelector('.sidebar'))");
      await pause(4500);
      await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Resources').click()");
      await wait("Boolean([...document.querySelectorAll('button')].find(b=>b.textContent==='Notifications'))");
      await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='Notifications').click()");
      assert.equal(await evaluate("document.querySelectorAll('.resource-card').length"),1);
      assert.equal(await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='Notifications').getAttribute('aria-pressed')"),'true');
      await screenshot('library-light');
      await evaluate("document.querySelector('.resource-card__open').click()");
      await wait("Boolean(document.querySelector('.notes')) && document.querySelector('.notes').textContent.includes('Bring a ruler.')");
      await screenshot('reader-light');
      await evaluate("window.centre.request('PATCH','/settings',{theme:'dark'})"); await pause(4500);
      await screenshot('reader-dark');
      window.setSize(620,800);await screenshot('reader-narrow');
      window.show();window.focus();window.webContents.focus();
      window.webContents.sendInputEvent({type:'keyDown',keyCode:'Tab'});window.webContents.sendInputEvent({type:'keyUp',keyCode:'Tab'});
      await pause(250);assert.ok(await evaluate("document.activeElement.tagName !== 'BODY'"));
      await writeFile(`${config.runtime}/report.json`,JSON.stringify({passed:true,checks:['Notifications category filters imported resources','Saved notification text opens in reader','Light and dark reader captured','Narrow layout captured','Keyboard focus reaches a control'],fixture:true,unsigned:true},null,2));
      app.quit();
    } catch(error) {console.error(error);await screenshot('failure');app.exit(1);}
  });});
  setTimeout(()=>app.exit(1),60000).unref();require(config.main);
}
const entry=join(runtime,'runner.cjs');await writeFile(entry,`(${runner.toString()})(${JSON.stringify({runtime,userData:join(temporary,'user'),main:join(root,'dist-electron/main.cjs')})});`);
const env={...process.env,CENTRE_DATA_DIR:data,CENTRE_CODEX_BIN:join(temporary,'missing-codex'),CENTRE_DISABLE_UPDATES:'1',CENTRE_RENDERER_URL:pathToFileURL(join(root,'dist/index.html')).href};delete env.ELECTRON_RUN_AS_NODE;
try { const child=spawn(require('electron'),[entry],{cwd:root,env,stdio:'inherit'});process.exitCode=await new Promise((resolve,reject)=>{child.once('exit',code=>resolve(code??1));child.once('error',reject);}); }
finally {await rm(temporary,{recursive:true,force:true});}
