import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { mobilePairingPage } from '../cloud/mobile-pairing-page.ts';

// Runs the production renderer/preload/service with only cloud invitation replies simulated.
const root = resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const output = join(root, '.runtime/mobile-pairing-proof');
const scratch = await mkdtemp(join(tmpdir(), 'centre-pairing-proof-'));
const server = createServer(async (_request,response) => {
  const page = mobilePairingPage();
  response.writeHead(page.status, Object.fromEntries(page.headers));
  response.end(await page.text());
});
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
const address = server.address();
assert.ok(address && typeof address !== 'string');
const handoffOrigin = `http://127.0.0.1:${address.port}`;
await mkdir(output, {recursive:true});
await mkdir(join(scratch, 'data'));
const entry = join(root, '.runtime', `mobile-pairing-${process.pid}.cjs`);
const source = `
const {app,ipcMain,clipboard,BrowserWindow,nativeTheme}=require('electron');
const {writeFile}=require('node:fs/promises');
const assert=require('node:assert/strict');
app.disableHardwareAcceleration();app.setPath('userData',${JSON.stringify(join(scratch, 'profile'))});
const out=${JSON.stringify(output)},code='a'.repeat(64),base='https://centre-cloud.etphli.workers.dev';
let authenticated=false,mode='success',ttl=300000,window,finished=false,priorClipboard;
const checks=[],errors=[];
const original=ipcMain.handle.bind(ipcMain);
ipcMain.handle=(channel,handler)=>original(channel,async(event,...args)=>{
 if(channel==='centre:request'&&args[1]==='/cloud/status')return{ok:true,value:{baseUrl:base,workspaceId:authenticated?'fixture':null,authenticated,enabled:false,phase:authenticated?'ready':'local',pending:0,conflicts:[],lastSyncedAt:null,error:null}};
 if(channel==='centre:request'&&args[1]==='/cloud/pairing'){
   assert.equal(authenticated,true);if(mode==='error')return{ok:false,error:'Synthetic pairing failure.'};
   return{ok:true,value:{baseUrl:base,code,expiresAt:new Date(Date.now()+ttl).toISOString()}};
 }
 const result=await handler(event,...args);
 if(channel==='centre:request'&&authenticated&&['/state','/state/poll'].includes(args[1])&&result?.ok&&result.value?.settings)result.value.settings.cloudAccount={name:'QR verification',email:'qr-fixture@centre.test'};
 return result;
});
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const evaluate=s=>window.webContents.executeJavaScript(s,true);
async function until(s,label){for(let i=0;i<150;i++){if(await evaluate(s))return;await pause(100);}throw new Error('Timed out: '+label);}
function check(name,value){assert.ok(value,name);checks.push(name);console.log('PASS '+name);}
async function click(selector,text){await evaluate('(()=>{const b=[...document.querySelectorAll('+JSON.stringify(selector)+')].find(b=>b.textContent.trim()==='+JSON.stringify(text)+');if(!b)throw Error("Missing button");b.click()})()');}
async function settings(){await until('Boolean(document.querySelector("button[aria-label=Settings]"))','home');await evaluate('document.querySelector("button[aria-label=Settings]").click()');await until('Boolean(document.querySelector(".settings-layout__nav"))','settings');check('General Settings explains iPhone download availability',await evaluate('document.querySelector(".settings-layout__content").textContent.includes("Not available to download yet.")'));await capture('general-availability');await click('button','View iPhone setup');await until('document.body.textContent.includes("Sign in to Centre cloud first") || ![...document.querySelectorAll("button")].find(b=>b.textContent.trim()==="Connect an installed iPhone app")?.disabled','account check');await capture('download-availability');}
async function capture(name){await pause(300);await writeFile(out+'/'+name+'.png',(await window.webContents.capturePage()).toPNG());}
async function create(){await click('button','Connect an installed iPhone app');await until('Boolean(document.querySelector("#mobile-account")?.closest("section").querySelector("img"))','pairing QR');}
async function finish(error){if(finished)return;finished=true;const current=await clipboard.readText();if(priorClipboard!==undefined&&(current===code||current===base+'/pair#code='+code))await clipboard.writeText(priorClipboard);await writeFile(out+'/native.json',JSON.stringify({passed:!error,checks,errors,fixture:'Cloud sign-in status and invitation replies simulated; actual production renderer, preload and local service.',...(error?{error:String(error.stack||error)}:{})},null,2)+'\\n');app.exit(error?1:0);}
app.on('browser-window-created',(_e,w)=>{if(window)return;window=w;w.webContents.on('render-process-gone',(_e,d)=>errors.push(d.reason));w.webContents.on('console-message',(_e,d)=>{if(d.level==='error')errors.push(d.message);});w.webContents.once('did-finish-load',async()=>{try{
 priorClipboard=await clipboard.readText();
 await settings();check('Uninstalled iPhone release is explicitly unavailable',await evaluate('document.body.textContent.includes("An iPhone release is not available yet.") && !document.querySelector("img[alt*=installation]")'));
 check('Account pairing disabled while signed out',await evaluate('[...document.querySelectorAll("button")].find(b=>b.textContent.trim()==="Connect an installed iPhone app").disabled'));
 authenticated=true;await evaluate('location.reload()');await pause(500);await settings();await until('![...document.querySelectorAll("button")].find(b=>b.textContent.trim()==="Connect an installed iPhone app")?.disabled','signed-in fixture');
 await create();check('Camera-specific instructions distinguish connecting from installing',await evaluate('document.body.textContent.includes("Scan with your iPhone camera") && document.body.textContent.includes("does not install the app")'));
 const png=await evaluate('document.querySelector("#mobile-account").closest("section").querySelector("img").src');await writeFile(out+'/rendered-qr.png',Buffer.from(png.split(',')[1],'base64'));await writeFile(out+'/rendered-qr.txt',base+'/pair#code='+code);
 window.focus();await click('button','Copy link');await pause(100);check('Copied link is HTTPS with a fragment secret and no query',await clipboard.readText()===base+'/pair#code='+code);
 await evaluate('document.querySelector("#mobile-account").closest("section").querySelector("img").scrollIntoView({block:"center"})');await capture('desktop-dark');
 await evaluate('window.centre.request("PATCH","/settings",{theme:"light",textSize:"large"})');window.setSize(960,800);await evaluate('location.reload()');await pause(500);await settings();await create();
 check('QR retains a white background in light large-text Settings',await evaluate('getComputedStyle(document.querySelector("#mobile-account").closest("section").querySelector("img")).backgroundColor==="rgb(255, 255, 255)"'));
 check('Minimum desktop width has no horizontal overflow',await evaluate('document.documentElement.scrollWidth<=innerWidth'));
 await evaluate('document.querySelector("#mobile-account").closest("section").querySelector("img").scrollIntoView({block:"center"})');await capture('desktop-light-large');
 const rect=await evaluate('(()=>{const r=document.querySelector("#mobile-account").closest("section").querySelector("img").getBoundingClientRect();return{x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)}})()');
 await writeFile(out+'/screen-qr.png',(await window.webContents.capturePage(rect)).toPNG());await writeFile(out+'/screen-qr.txt',base+'/pair#code='+code);
 await click('button','Hide code');check('Hide removes private QR',await evaluate('!document.querySelector("#mobile-account").closest("section").querySelector("img")'));
 mode='error';await click('button','Connect an installed iPhone app');await until('document.body.textContent.includes("Synthetic pairing failure")','error');check('Failed invitation shows an error with no QR',await evaluate('!document.querySelector("#mobile-account").closest("section").querySelector("img")'));
 mode='success';ttl=2000;await create();await until('document.body.textContent.includes("This account code has expired")','expiry');check('Expired invitation removes scannable QR',await evaluate('!document.querySelector("#mobile-account").closest("section").querySelector("img")'));
 const handoff=new BrowserWindow({width:375,height:812,useContentSize:true,webPreferences:{partition:'pairing-browser-'+process.pid,sandbox:true,contextIsolation:true,nodeIntegration:false}});
 const browser=s=>handoff.webContents.executeJavaScript(s,true),origin=${JSON.stringify(handoffOrigin)};
 await handoff.loadURL(origin+'/pair#code='+code);
 check('Camera page clears the secret and creates an explicit app handoff',await browser('location.hash==="" && !document.querySelector("#pairing").hidden && new URL(document.querySelector("#open").href).searchParams.get("code")==="a".repeat(64)'));
 check('Camera page is honest about the missing signed iPhone release',await browser('document.body.textContent.includes("isn’t available to install yet")'));
 check('Camera page has no external resources or background account calls',await browser('performance.getEntriesByType("resource").length===0'));
 check('Phone-width page has no horizontal overflow and usable touch targets',await browser('document.documentElement.scrollWidth<=innerWidth && [...document.querySelectorAll(".button")].every(b=>b.getBoundingClientRect().height>=44)'));
 nativeTheme.themeSource='light';await pause(200);await writeFile(out+'/phone-light.png',(await handoff.webContents.capturePage()).toPNG());
 nativeTheme.themeSource='dark';await pause(200);await writeFile(out+'/phone-dark.png',(await handoff.webContents.capturePage()).toPNG());
 await browser('document.querySelector("#copy").click()');await pause(150);check('Phone copy action copies only the one-time code',await clipboard.readText()===code);
 let opened=null;handoff.webContents.on('will-navigate',(event,url)=>{if(url.startsWith('centre:')){event.preventDefault();opened=url;}});
 await browser('document.querySelector("#open").click()');await pause(150);check('Explicit Open Centre retains the exact cloud origin and code',opened && new URL(opened).searchParams.get('baseUrl')===origin && new URL(opened).searchParams.get('code')===code);
 await handoff.loadURL(origin+'/pair#code=short');await pause(100);
 check('Same-tab rescan discards the old invitation and rejects an invalid code',await browser('document.querySelector("#pairing").hidden && !document.querySelector("#open").hasAttribute("href") && !location.hash'));
 await handoff.loadURL(origin+'/pair#code='+'b'.repeat(64));await pause(100);
 check('Same-tab valid rescan uses the new code',await browser('!document.querySelector("#pairing").hidden && new URL(document.querySelector("#open").href).searchParams.get("code")==="b".repeat(64) && !location.hash'));
 handoff.destroy();check('No uncaught renderer errors',errors.length===0);await finish();
 }catch(e){await finish(e);}});});
setTimeout(()=>finish(Error('Native pairing verifier timeout')),90000).unref();
require(${JSON.stringify(join(root,'dist-electron/main.cjs'))});
`;
await writeFile(entry, source);
const env = {...process.env,CENTRE_DATA_DIR:join(scratch,'data'),CENTRE_RENDERER_URL:new URL('../dist/index.html',import.meta.url).href};
delete env.ELECTRON_RUN_AS_NODE;
try {
  const child = spawn(require('electron'), [entry], {cwd:root,env,stdio:'inherit'});
  const timeout = setTimeout(()=>child.kill('SIGTERM'),100000);
  const status = await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
  clearTimeout(timeout);
  assert.equal(status,0,'Native pairing verification failed');
  const report=JSON.parse(await readFile(join(output,'native.json'),'utf8'));
  assert.equal(report.passed,true);
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(entry,{force:true});
  await rm(scratch,{recursive:true,force:true});
}
