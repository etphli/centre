import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const root=process.cwd(),out=resolve('.runtime/prompt-drafts-final');await mkdir(out,{recursive:true});
const scratch=await mkdtemp(join(tmpdir(),'centre-iphone-desktop-'));await mkdir(join(scratch,'data'));await mkdir(join(scratch,'profile'));
const server=createServer();await new Promise(done=>server.listen(0,'127.0.0.1',done));const port=server.address().port;await new Promise(done=>server.close(done));
const env={...process.env,CENTRE_RENDERER_URL:pathToFileURL(resolve('dist/index.html')).href,CENTRE_DATA_DIR:join(scratch,'data'),CENTRE_USER_DATA_DIR:join(scratch,'profile'),CENTRE_CODEX_BIN:join(scratch,'missing-codex'),CODEX_HOME:join(scratch,'codex')};delete env.ELECTRON_RUN_AS_NODE;
const executable=process.argv[2]??resolve('node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
const args=process.argv[2]?[`--remote-debugging-port=${port}`,'--disable-gpu']:['.',`--remote-debugging-port=${port}`,'--disable-gpu'];
const child=spawn(executable,args,{cwd:root,env,stdio:['ignore','pipe','pipe']});let log='';child.stdout.on('data',chunk=>log+=chunk);child.stderr.on('data',chunk=>log+=chunk);
let socket,id=0;const pending=new Map(),checks=[],errors=[];
async function until(fn,label){const end=Date.now()+30_000;while(Date.now()<end){try{const value=await fn();if(value)return value;}catch{}await new Promise(done=>setTimeout(done,100));}throw new Error('Timed out: '+label);}
function cdp(method,params={}){return new Promise((accept,reject)=>{const key=++id,timer=setTimeout(()=>{pending.delete(key);reject(new Error('CDP timeout '+method));},15000);pending.set(key,{accept,reject,timer});socket.send(JSON.stringify({id:key,method,params}));});}
async function evaluate(expression){const result=await cdp('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true,userGesture:true});if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description??result.exceptionDetails.text);return result.result.value;}
function check(name,value){assert.ok(value,name);checks.push({name,passed:true});console.log('PASS '+name);}
async function capture(name,clip){const result=await cdp('Page.captureScreenshot',{format:'png',fromSurface:true,...(clip?{clip:{...clip,scale:1}}:{})});await writeFile(join(out,name+'.png'),Buffer.from(result.data,'base64'));}
try{
 const target=await until(async()=>{const pages=await(await fetch(`http://127.0.0.1:${port}/json/list`,{signal:AbortSignal.timeout(1500)})).json();return pages.find(item=>item.type==='page'&&item.url.includes('/dist/index.html'));},'actual production renderer');
 socket=new WebSocket(target.webSocketDebuggerUrl);await new Promise((accept,reject)=>{socket.onopen=accept;socket.onerror=reject;});socket.onmessage=event=>{const message=JSON.parse(event.data);if(message.id){const call=pending.get(message.id);if(call){clearTimeout(call.timer);pending.delete(message.id);message.error?call.reject(new Error(message.error.message)):call.accept(message.result);}}else if(message.method==='Runtime.exceptionThrown')errors.push(message.params.exceptionDetails.text);};await cdp('Runtime.enable');
 await until(()=>evaluate('Boolean(document.querySelector(".composer__input"))'),'home composer');
 const reload=async()=>{const start=await evaluate('performance.timeOrigin');await cdp('Page.reload');await until(()=>evaluate(`performance.timeOrigin!==${start} && Boolean(document.querySelector(".composer__input"))`),'fresh loaded document');};
 const value=()=>evaluate('document.querySelector(".composer__input").value');
 const type=async text=>{await evaluate('(()=>{const input=document.querySelector(".composer__input");input.focus();input.setSelectionRange(input.value.length,input.value.length)})()');await cdp('Input.insertText',{text});};
 const nav=async label=>{await evaluate(`[...document.querySelectorAll('nav[aria-label="Main"] button')].find(item=>item.textContent.trim()===${JSON.stringify(label)}).click()`);await until(()=>evaluate('Boolean(document.querySelector(".composer__input"))'),'composer after navigation');};
 const openChat=async chatId=>{await until(()=>evaluate(`Boolean(document.querySelector('[data-chat-id="${chatId}"] .chat-nav__item'))`),'saved chat in sidebar');await evaluate(`document.querySelector('[data-chat-id="${chatId}"] .chat-nav__item').click()`);await until(()=>evaluate(`Boolean(document.querySelector('[data-chat-id="${chatId}"] .chat-nav__item[aria-current=page]'))`),'active chat');};
 await type('Half typed prompt kept across pages');await nav('Resources');
 check('half-typed Mac prompt survives Home to Resources',await value()==='Half typed prompt kept across pages');
 await nav('New chat');check('returning Home restores the exact prompt',await value()==='Half typed prompt kept across pages');
 await reload();await until(()=>evaluate('document.querySelector(".composer__input")?.value==="Half typed prompt kept across pages"'),'durable prompt after reload');
 check('prompt survives full renderer reload',true);await capture('home-draft-dark');
 const a=await evaluate('window.centre.request("POST","/chats",{modelSelection:null})');const b=await evaluate('window.centre.request("POST","/chats",{modelSelection:null})');
 await reload();await until(()=>evaluate('Boolean(document.querySelector(".composer__input"))'),'fresh snapshot after fixture-created chats');
 await openChat(a.id);check('new saved chat does not inherit the Home draft',await value()==='');await type('Only chat A keeps this question');
 await openChat(b.id);check('another saved chat starts with its own empty draft',await value()==='');await type('Only chat B keeps its question');
 await openChat(a.id);check('switching chats restores A without B text',await value()==='Only chat A keeps this question');await capture('chat-a-draft-dark');
 await nav('Resources');await openChat(a.id);check('chat draft survives leaving for Resources and returning',await value()==='Only chat A keeps this question');
 await reload();await until(()=>evaluate('Boolean(document.querySelector(".composer__input"))'),'reload initial page');await openChat(a.id);check('saved chat draft survives renderer reload',await value()==='Only chat A keeps this question');
 await evaluate('document.querySelector("button[aria-label=Send]").click()');await until(()=>evaluate('document.querySelector(".composer__input")?.value===""'),'sent composer clear');check('explicit Send clears only A composer draft',true);
 await openChat(b.id);check('sending A leaves B draft untouched',await value()==='Only chat B keeps its question');
 await nav('New chat');check('sending A leaves the new-prompt draft untouched',await value()==='Half typed prompt kept across pages');
 await evaluate('document.querySelector("button[aria-label=Settings]").click()');await until(()=>evaluate('Boolean(document.querySelector(".theme-option--light"))'),'appearance settings');await evaluate('document.querySelector(".theme-option--light").click()');await until(()=>evaluate('document.documentElement.dataset.theme==="light"'),'light theme');await nav('New chat');await capture('home-draft-light');
 await evaluate('window.__promptStorageSet=Storage.prototype.setItem;Storage.prototype.setItem=function(){throw new DOMException("Fixture storage full","QuotaExceededError")}');
 await type(' with unsaved tail');
 check('failed local save is clearly reported',await evaluate('document.body.textContent.includes("could not be saved on this Mac")'));
 await nav('Resources');check('failed disk save still keeps current-session text across pages',await value()==='Half typed prompt kept across pages with unsaved tail');await capture('storage-error-light');
 await evaluate('Storage.prototype.setItem=window.__promptStorageSet;delete window.__promptStorageSet');await type(' recovered');
 check('a later successful save clears the warning',await evaluate('!document.body.textContent.includes("could not be saved on this Mac")'));
 check('no renderer exceptions',errors.length===0);
 await writeFile(join(out,'report.json'),JSON.stringify({passed:true,checks,errors,scope:'Actual Electron renderer/local service/Chromium localStorage, isolated profile. No live model used; deliberately missing Codex for the sent-message recovery case.'},null,2));
}catch(error){await writeFile(join(out,'failure-state.json'),JSON.stringify(await evaluate('({url:location.href,inputs:[...document.querySelectorAll("textarea")].map(x=>x.value),keys:Object.fromEntries(Object.entries(localStorage)),body:document.body.innerText.slice(0,2500)})').catch(()=>null),null,2));await capture('failure').catch(()=>{});throw error;}finally{socket?.close();child.kill('SIGTERM');await new Promise(done=>{if(child.exitCode!==null)return done();child.once('exit',done);setTimeout(done,10000);});await writeFile(join(out,'native.log'),log);}
