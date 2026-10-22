import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const scratch=await mkdtemp(join(tmpdir(),'centre-login-native-'));
const reportPath=join(root,'.runtime/google-login-verification.json');
const entry=join(scratch,'verify.cjs');
await Promise.all(['data','profile','codex'].map(name=>mkdir(join(scratch,name))));
const source=`
const assert=require('node:assert/strict');
const {writeFile,readFile}=require('node:fs/promises');
const {app,dialog}=require('electron');
const realFetch=globalThis.fetch;
const report={passed:false,checks:[],liveGoogleConsent:false,googleResponses:'SIMULATED',cloudTransport:'REAL HTTPS with certificate verification',rendererErrors:[]};
let finished=false;
async function finish(error){
 if(finished)return;finished=true;if(error){report.error=error.message;console.error(error);}
 await writeFile(${JSON.stringify(reportPath)},JSON.stringify(report,null,2)+'\\n');
 process.exitCode=error?1:0;app.quit();
}
dialog.showErrorBox=(title,message)=>void finish(new Error(title+': '+message));
globalThis.fetch=async(input,init)=>{
 const url=input instanceof Request?input.url:String(input);
 if(url==='https://oauth2.googleapis.com/token')return Response.json({access_token:'SIMULATED-access-token',id_token:'SIMULATED-invalid-id-token'});
 if(url==='https://openidconnect.googleapis.com/v1/userinfo')return Response.json({name:'Login fixture',email:'login@example.test',email_verified:true});
 return realFetch(input,init);
};
function check(name,value){assert.ok(value,name);report.checks.push(name);console.log('PASS '+name);}
app.on('browser-window-created',(_event,window)=>{
 window.webContents.on('console-message',(_event,level,message)=>{if(level>=3)report.rendererErrors.push(message);});
 window.webContents.once('did-finish-load',()=>void(async()=>{
  const request=(method,path,body)=>window.webContents.executeJavaScript('window.centre.request('+JSON.stringify(method)+','+JSON.stringify(path)+','+(body===undefined?'undefined':JSON.stringify(body))+')',true);
  const bootstrap=await realFetch('https://centre-cloud.etphli.workers.dev/v1/bootstrap',{signal:AbortSignal.timeout(15000)});
  check('Production Electron startup trusts the macOS certificate chain and reaches real Centre Cloud',bootstrap.status===401);await bootstrap.body.cancel();
  async function callback(path){
   const authorization=new URL((await request('POST',path,{})).url);
   const callback=new URL(authorization.searchParams.get('redirect_uri'));
   callback.searchParams.set('state',authorization.searchParams.get('state'));callback.searchParams.set('code','SIMULATED-code');
   return realFetch(callback);
  }
  const success=await callback('/auth/google/start');const successPage=await success.text();
  check('Actual loopback callback completes with simulated Google responses',success.status===200&&successPage.includes('You can go back to Centre.'));
  check('Success page provides a valid Centre Settings action',successPage.includes('href="centre://action/app.settings"'));
  check('Native service saves the account before reporting success',(await request('GET','/state')).settings.account?.email==='login@example.test');
  const stored=JSON.parse(await readFile(${JSON.stringify(join(scratch,'data/state.json'))},'utf8'));
  check('Account is persisted without provider tokens',stored.settings.account?.email==='login@example.test'&&!JSON.stringify(stored).includes('SIMULATED-access-token'));
  await request('POST','/auth/google/logout',{});
  const failure=await callback('/cloud/sign-in');const failurePage=await failure.text();
  check('Real Cloud rejects the simulated invalid identity after a secure connection',failure.status===400&&!failurePage.includes('fetch failed')&&failurePage.includes('Sign-in couldn&#39;t be completed.'));
  check('Failed Cloud sign-in grants no account or device session',!(await request('GET','/cloud/status')).authenticated&&(await request('GET','/state')).settings.account===null);
  check('No renderer errors',report.rendererErrors.length===0);report.passed=true;await finish();
 })().catch(finish));
});
setTimeout(()=>void finish(new Error('Native Google login verification timed out.')),60000).unref();
require(${JSON.stringify(join(root,'dist-electron/main.cjs'))});
`;
await writeFile(entry,source);
const env={...process.env,CENTRE_DATA_DIR:join(scratch,'data'),CENTRE_USER_DATA_DIR:join(scratch,'profile'),CENTRE_CODEX_BIN:join(scratch,'missing-codex'),CODEX_HOME:join(scratch,'codex'),CENTRE_RENDERER_URL:pathToFileURL(join(root,'dist/index.html')).href};
delete env.ELECTRON_RUN_AS_NODE;
try {
  const binary=createRequire(import.meta.url)('electron');assert.equal(typeof binary,'string');
  const child=spawn(binary,[entry],{cwd:root,env,stdio:'inherit'});
  const timer=setTimeout(()=>child.kill('SIGTERM'),70000);
  const code=await new Promise((accept,reject)=>{child.once('error',reject);child.once('exit',value=>accept(value??1));});
  clearTimeout(timer);process.exitCode=code;
  if(code===0)assert.equal(JSON.parse(await readFile(reportPath,'utf8')).passed,true,'Native callback verification did not pass.');
} finally {await rm(scratch,{recursive:true,force:true});}
