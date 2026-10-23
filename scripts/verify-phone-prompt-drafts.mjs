import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

const require=createRequire(import.meta.url);
const {chromium}=require(process.env.CENTRE_PLAYWRIGHT_MODULE??'playwright-core');
const socket=createServer();
await new Promise(done=>socket.listen(0,'127.0.0.1',done));
const port=socket.address().port;
await new Promise(done=>socket.close(done));
const base=`http://127.0.0.1:${port}`;
const fixture=spawn(process.execPath,['--import','tsx','scripts/iphone-fixture.ts'],{env:{...process.env,CENTRE_IPHONE_FIXTURE_PORT:String(port)},stdio:['ignore','pipe','pipe']});
let log='';fixture.stdout.on('data',chunk=>log+=chunk);fixture.stderr.on('data',chunk=>log+=chunk);
const out=resolve('.runtime/phone-prompt-drafts');await mkdir(out,{recursive:true});
let browser;
const checks=[],errors=[];
const check=(name,value)=>{checks.push({name,passed:!!value});assert.ok(value,name);console.log('PASS '+name);};
try {
  let ready=false;
  for(let i=0;i<100;i++){try{ready=(await fetch(base+'/iphone/')).ok;if(ready)break;}catch{}await new Promise(done=>setTimeout(done,100));}
  assert.ok(ready,'Fixture must start: '+log);
  browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  const nav=async name=>page.getByRole('navigation',{name:'Study pages'}).getByRole('button',{name,exact:true}).click();
  const shot=async name=>page.screenshot({path:resolve(out,name+'.png'),fullPage:false});
  await page.goto(base+'/iphone/');
  const invitation=await(await fetch(base+'/_fixture/invitation')).json();
  await page.getByLabel('One-time account code').fill(invitation.code);
  await page.getByRole('button',{name:'Connect Centre',exact:true}).click();
  await page.getByRole('heading',{name:'Log',exact:true}).waitFor();
  await page.getByRole('button',{name:'Synced',exact:true}).waitFor();
  await context.setOffline(true);
  await page.getByRole('button',{name:'Offline',exact:true}).waitFor();
  check('network loss immediately changes Synced to Offline',true);
  await shot('log-offline');
  await context.setOffline(false);
  await page.getByRole('button',{name:'Synced',exact:true}).waitFor();
  check('reconnecting refreshes status without reloading',true);
  await nav('Chat');await page.getByRole('button',{name:'New chat',exact:true}).click();
  await page.getByLabel('Message Centre',{exact:true}).fill('Half typed phone prompt');
  await nav('Resources');await nav('Chat');
  await page.waitForFunction(()=>document.querySelector('#message-input')?.value==='Half typed phone prompt');
  check('returning to Chat opens its exact half-typed prompt',true);
  const stress='Prompt '+'.'.repeat(500);
  await page.evaluate(text=>{const input=document.querySelector('#message-input');const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;for(let i=1;i<=text.length;i++){setter.call(input,text.slice(0,i));input.dispatchEvent(new Event('input',{bubbles:true}));}},stress);
  await nav('Resources');await nav('Chat');
  await page.getByLabel('Message Centre',{exact:true}).waitFor();
  await page.waitForFunction(()=>!document.querySelector('#message-input')?.disabled);
  const restored=await page.getByLabel('Message Centre',{exact:true}).inputValue();
  check('rapid final characters survive immediate tab navigation',restored===stress);
  await page.reload();await nav('Chat');await page.locator('.list-row').first().click();
  await page.waitForFunction(()=>!document.querySelector('#message-input')?.disabled);
  check('unsent phone prompt survives a full browser reload',await page.getByLabel('Message Centre',{exact:true}).inputValue()===stress);
  await shot('phone-draft');
  check('no renderer exceptions',errors.length===0);
  await writeFile(resolve(out,'report.json'),JSON.stringify({passed:true,checks,errors,scope:'Actual browser/IndexedDB/Worker fixture. Identity simulated. No production data.'},null,2));
} catch(error) {
  const failedPage=browser?.contexts()[0]?.pages()[0];
  if(failedPage){await failedPage.screenshot({path:resolve(out,'failure.png')}).catch(()=>undefined);await writeFile(resolve(out,'failure-state.json'),JSON.stringify({text:await failedPage.locator('body').innerText().catch(()=>''),inputs:await failedPage.locator('textarea').evaluateAll(nodes=>nodes.map(node=>({value:node.value,disabled:node.disabled}))).catch(()=>[])}));}
  await writeFile(resolve(out,'failure.json'),JSON.stringify({error:String(error),checks,errors,fixtureLog:log},null,2));
  throw error;
} finally {await browser?.close();fixture.kill('SIGTERM');}
