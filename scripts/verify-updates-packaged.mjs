import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const root=process.cwd(),out=resolve('.runtime/updates-packaged');await mkdir(out,{recursive:true});
const scratch=await mkdtemp(join(tmpdir(),'centre-updates-packaged-'));await mkdir(join(scratch,'data'));await mkdir(join(scratch,'profile'));
const server=createServer();await new Promise(done=>server.listen(0,'127.0.0.1',done));const port=server.address().port;await new Promise(done=>server.close(done));
const env={...process.env,CENTRE_DISABLE_UPDATES:'1',CENTRE_RENDERER_URL:pathToFileURL(resolve('dist/index.html')).href,CENTRE_DATA_DIR:join(scratch,'data'),CENTRE_USER_DATA_DIR:join(scratch,'profile'),CENTRE_CODEX_BIN:join(scratch,'missing-codex'),CODEX_HOME:join(scratch,'codex')};delete env.ELECTRON_RUN_AS_NODE;
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
 const target=await until(async()=>{const pages=await(await fetch(`http://127.0.0.1:${port}/json/list`,{signal:AbortSignal.timeout(1500)})).json();return pages.find(item=>item.type==='page'&&item.url.includes('app.asar/dist/index.html'));},'packaged production renderer');
 socket=new WebSocket(target.webSocketDebuggerUrl);await new Promise((accept,reject)=>{socket.onopen=accept;socket.onerror=reject;});socket.onmessage=event=>{const message=JSON.parse(event.data);if(message.id){const call=pending.get(message.id);if(call){clearTimeout(call.timer);pending.delete(message.id);message.error?call.reject(new Error(message.error.message)):call.accept(message.result);}}};
 await until(()=>evaluate("Boolean(document.querySelector('.sidebar'))"),'visible updater');
 const status=await evaluate('window.centre.updates.check()');
 assert.equal(status.currentVersion,process.env.CENTRE_EXPECTED_BUILD ?? '0.1.20-local.20261031.2');assert.equal(status.state,'current');assert.equal(status.version,'0.1.20');
 checks.push('Installed local build checks public releases, avoids downgrading and keeps the sidebar clear when current');
 await until(()=>evaluate("!document.querySelector('.app-updates--compact')"),'current build has no sidebar update prompt');
 await evaluate("[...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='Resources').click()");
 await until(()=>evaluate("[...document.querySelectorAll('button')].some(button=>button.textContent==='Notifications')"),'notification category in packaged renderer');checks.push('Packaged app contains notification resources category');
 await new Promise(resolve=>setTimeout(resolve,500));await capture('packaged-local-build');
 await writeFile(join(out,'report.json'),JSON.stringify({passed:true,status,checks,renderer:target.url,unsigned:true,isolatedData:true},null,2));
}finally{socket?.close();child.kill('SIGTERM');await writeFile(join(out,'console.log'),log);}
