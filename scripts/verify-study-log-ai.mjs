import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';

const require = createRequire(import.meta.url), root = resolve('.'), runtime = join(root, '.runtime');
const directory = await mkdtemp(join(tmpdir(), 'centre-ai-log-ui-'));
await mkdir(runtime, { recursive: true }); await mkdir(join(directory, 'data'));
const day = Temporal.Now.zonedDateTimeISO('Australia/Sydney').toPlainDate().subtract({ days: 1 });
const input = { id: randomUUID(), confirmedByUser: true, title: 'Paper algebra from chat', notes: 'Completed away from the computer.', subjectId: null, taskId: null, timeZone: 'Australia/Sydney', segments: [{ start: `${day}T18:00`, end: `${day}T19:30` }] };
const config = join(directory, 'tool-input.json'); await writeFile(config, JSON.stringify({ input }));
await writeFile(join(directory, 'data/state.json'), JSON.stringify({ subjects: [], topics: [], resources: [], chats: [], events: [], memories: [], assignments: [], settings: { theme: 'light', timeZone: 'Australia/Sydney' }, codex: { available: false, authenticated: false, message: '' }, lastSyncedAt: null }));
const entry = join(runtime, `verify-study-log-ai-${process.pid}.cjs`);
const source = `
const { app, BrowserWindow, dialog } = require('electron');
const { writeFile, readFile } = require('node:fs/promises');
const assert = require('node:assert/strict');
app.disableHardwareAcceleration(); app.setPath('userData', ${JSON.stringify(join(directory, 'user'))});
dialog.showErrorBox = (title,message) => { console.error(title+': '+message); app.exit(1); };
let window, done=false; const checks=[], errors=[];
const evaluate = script => window.webContents.executeJavaScript(script,true);
const delay = ms => new Promise(resolve=>setTimeout(resolve,ms));
async function wait(script) { for(let i=0;i<150;i++){if(await evaluate(script))return;await delay(100);}throw new Error('Timed out: '+script); }
async function check(name,script){assert.ok(await evaluate(script),name);checks.push(name);console.log('PASS '+name);}
async function click(text){await evaluate('(()=>{const e=[...document.querySelectorAll("button")].find(e=>e.textContent.trim()==='+JSON.stringify(text)+');if(!e)throw Error("Missing button");e.click()})()');}
async function shot(name){await evaluate('(async()=>{await Promise.allSettled(document.getAnimations().filter(a=>a.effect?.getComputedTiming().endTime!==Infinity).map(a=>a.finished));await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));})()');await writeFile(${JSON.stringify(runtime)}+'/study-log-'+name+'.png',(await window.webContents.capturePage()).toPNG());}
async function finish(error){if(done)return;done=true;await writeFile(${JSON.stringify(join(runtime, 'study-log-ai-results.json'))},JSON.stringify({passed:!error,checks,errors,modelBoundary:'Deterministic CLI protocol fixture, real production Electron/IPC/service/disk. Live model reasoning not verified.',error:error?.message},null,2));if(error){console.error(error);app.exit(1);}else app.quit();}
app.on('browser-window-created',(_event,win)=>{if(window)return;window=win;window.setSize(1280,900);window.webContents.setBackgroundThrottling(false);window.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message)});window.webContents.once('did-finish-load',async()=>{try{
 await wait('Boolean(document.querySelector(".composer__input:not(:disabled)"))');
 await evaluate('(()=>{const e=document.querySelector(".composer__input");Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(e,'+JSON.stringify(${JSON.stringify(`Log my paper algebra study on ${day} from 6 pm to 7:30 pm in Sydney, completed away from the computer.`)})+');e.dispatchEvent(new Event("input",{bubbles:true}))})()');
 await wait('!document.querySelector("button[aria-label=Send]").disabled');
 await evaluate('document.querySelector("button[aria-label=Send]").click()');
 await wait('document.body.innerText.includes("Logged completed paper study.")');
 await check('Chat completes actual Log tool call', 'document.body.innerText.includes("Logged completed paper study.")');await shot('ai-chat');
 await click('Log');
 ${day.dayOfWeek === 7 ? "await evaluate('document.querySelector(\"button[aria-label=\\\"Previous week\\\"]\").click()');" : ''}
 await wait('document.querySelector(".study-entries")?.textContent.includes("Paper algebra from chat")');
 await check('AI entry appears in real Log without reload', 'document.querySelector(".study-entries").textContent.includes("Paper algebra from chat")&&document.querySelector(".study-aim").textContent.includes("1 h 30 min")');
 const state=JSON.parse(await readFile(${JSON.stringify(join(directory, 'data/state.json'))},'utf8'));assert.equal(state.studyLog.sessions.length,1);assert.equal(state.studyLog.sessions[0].id,${JSON.stringify(input.id)});checks.push('AI-created entry is confirmed on disk');await evaluate('document.querySelector(".study-entries").scrollIntoView({block:"end"})');await shot('ai-entry');
 await click('Set weekly aim');
 await shot('duration-light');

 await check('Light duration keeps numeric keyboard semantics and removes native spinner chrome', '(()=>{const e=document.querySelector(".centre-duration-field input");return e.type==="number"&&getComputedStyle(e).appearance==="textfield"})()');
 assert.deepEqual(errors,[]);checks.push('No renderer console errors');await finish();
}catch(error){await finish(error)}})});
setTimeout(()=>finish(Error('AI Log UI verification timed out')),45000).unref();
require(${JSON.stringify(join(root, 'dist-electron/main.cjs'))});
`;
await writeFile(entry, source);
try {
  const env = { ...process.env, CENTRE_DATA_DIR: join(directory, 'data'), CENTRE_RENDERER_URL: pathToFileURL(join(root, 'dist/index.html')).href, CENTRE_CODEX_BIN: join(root, 'server/fixtures/study-log-codex.mjs'), CENTRE_STUDY_TOOL_INPUT: config };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [entry], { env, cwd: root, stdio: 'inherit' });
  const code = await new Promise((resolveExit,reject)=>{child.once('exit',resolveExit);child.once('error',reject)});
  if(code!==0)process.exitCode=1;
} finally { await rm(entry,{force:true});await rm(directory,{recursive:true,force:true}); }
