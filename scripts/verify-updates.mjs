import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {emptySnapshot} from '../server/store.ts';
const require=createRequire(import.meta.url),root=resolve('.'),out=join(root,'.runtime/update-verification');
const temporary=await mkdtemp(join(tmpdir(),'centre-update-ui-')),data=join(temporary,'data');
await mkdir(data);await mkdir(out,{recursive:true});
const state=emptySnapshot();state.settings.theme='light';await writeFile(join(data,'state.json'),JSON.stringify(state));
function runner(config){
 const {app,ipcMain,shell}=require('electron'),assert=require('node:assert/strict'),{writeFile}=require('node:fs/promises');
 app.setPath('userData',config.user);const opened=[],checks=[];shell.openExternal=async url=>{opened.push(url);};let window;
 const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));const evaluate=code=>window.webContents.executeJavaScript(code);
 async function wait(code){for(let i=0;i<250;i++){if(await evaluate(code))return;await pause(100);}throw new Error('Timed out: '+code);}
 async function shot(name){window.show();window.focus();window.webContents.invalidate();await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');await pause(500);await writeFile(`${config.out}/${name}.png`,(await window.webContents.capturePage()).toPNG());}
 async function button(label){await evaluate(`[...document.querySelectorAll('button')].find(button=>button.textContent.trim()===${JSON.stringify(label)}).click()`);}
 app.on('browser-window-created',(_event,created)=>{window=created;window.setSize(1280,800);window.webContents.setBackgroundThrottling(false);window.webContents.once('did-finish-load',async()=>{
 try{
  await wait("Boolean(document.querySelector('[aria-label=Settings]'))");await pause(500);
  assert.equal(await evaluate("Boolean(document.querySelector('.app-updates--compact'))"),false);checks.push('Sidebar updater hidden while idle');
  await evaluate("document.querySelector('[aria-label=Settings]').click()");await wait("Boolean(document.querySelector('.settings-layout__nav'))");
  await evaluate("[...document.querySelectorAll('.settings-layout__nav button')].find(button=>button.textContent.trim()==='Updates').click()");
  await wait("Boolean(document.getElementById('settings-updates'))");await button('Check for updates');
  await wait("document.querySelector('.app-updates--compact button')?.textContent.includes('Download update')");
  checks.push('Real public release check works from an unsigned fixture');await shot('update-available-light');
  await evaluate("document.querySelector('.app-updates--compact button').click()");await pause(300);
  assert.match(opened[0],/^https:\/\/github.com\/etphli\/centre\/releases\/download\/v\d+\.\d+\.\d+\/Centre-.*-arm64\.dmg$/);checks.push('Download action opens the architecture-specific public DMG');
  await evaluate("document.querySelector('[aria-label=Settings]').click()");await wait("Boolean(document.querySelector('.settings-layout__nav'))");
  await evaluate("[...document.querySelectorAll('.settings-layout__nav button')].find(button=>button.textContent.trim()==='Updates').click()");
  await wait("Boolean(document.getElementById('settings-updates'))");assert.equal(await evaluate("Boolean(document.querySelector('input[type=password]'))"),false);checks.push('Updates settings requires no token');
  let status={state:'ready',message:'Centre 0.1.99 is ready. Restart to install.',downloaded:true,version:'0.1.99',currentVersion:'0.1.0'};let installs=0;
  ipcMain.removeHandler('centre:updates:status');ipcMain.handle('centre:updates:status',()=>status);
  ipcMain.removeHandler('centre:updates:install');ipcMain.handle('centre:updates:install',()=>{installs++;return status;});
  await wait("document.querySelector('.app-updates--compact button')?.textContent.includes('Install and restart')");await button('Install and restart');await pause(100);assert.equal(installs,1);checks.push('Simulated downloaded state enables explicit installation');
  status={state:'downloading',message:'Downloading update: 45%',currentVersion:'0.1.0'};
  await wait("document.querySelector('.app-updates--compact button').disabled && document.querySelector('.app-updates--compact').textContent.includes('45%')");await shot('update-progress');checks.push('Download progress is visible and prevents duplicate actions');
  status={state:'error',message:'Network unavailable. Try again.',currentVersion:'0.1.0'};
  ipcMain.removeHandler('centre:updates:check');ipcMain.handle('centre:updates:check',()=>{status={state:'current',message:'You have the latest published version.',currentVersion:'0.1.0'};return status;});
  await wait("document.getElementById('settings-updates').closest('section').textContent.includes('Network unavailable')");
  assert.equal(await evaluate("Boolean(document.querySelector('.app-updates--compact'))"),false);await shot('update-error-retry');
  await button('Check for updates');await wait("document.getElementById('settings-updates').closest('section').textContent.includes('latest published')");
  assert.equal(await evaluate("Boolean(document.querySelector('.app-updates--compact'))"),false);checks.push('Sidebar hidden on errors and when current; Settings check remains retryable');
  await evaluate("window.centre.request('PATCH','/settings',{theme:'dark'})");await pause(4500);await shot('updates-settings-dark');window.setSize(960,800);await shot('updates-settings-narrow');
  window.focus();window.webContents.focus();window.webContents.sendInputEvent({type:'keyDown',keyCode:'Tab'});window.webContents.sendInputEvent({type:'keyUp',keyCode:'Tab'});await pause(200);assert.notEqual(await evaluate('document.activeElement.tagName'),'BODY');checks.push('Keyboard focus reaches controls');
  await writeFile(`${config.out}/report.json`,JSON.stringify({passed:true,checks,livePublicCheck:true,simulatedStates:['ready','downloading','error'],unsigned:true},null,2));app.quit();
 }catch(error){console.error(error);await shot('failure').catch(()=>undefined);app.exit(1);}
 });});setTimeout(()=>app.exit(1),90000).unref();require(config.main);
}
await writeFile(join(out,'package.json'),JSON.stringify({name:'centre-update-verification',version:'0.1.0',main:'runner.cjs'}));
await writeFile(join(out,'runner.cjs'),`(${runner.toString()})(${JSON.stringify({out,user:join(temporary,'user'),main:join(root,'dist-electron/main.cjs')})});`);
const env={...process.env,CENTRE_DATA_DIR:data,CENTRE_CODEX_BIN:join(temporary,'missing-codex'),CENTRE_DISABLE_UPDATES:'1',CENTRE_RENDERER_URL:pathToFileURL(join(root,'dist/index.html')).href};delete env.ELECTRON_RUN_AS_NODE;
try{const child=spawn(require('electron'),[out],{cwd:root,env,stdio:'inherit'});process.exitCode=await new Promise((resolve,reject)=>{child.once('exit',code=>resolve(code??1));child.once('error',reject);});}
finally{await rm(temporary,{recursive:true,force:true});}
