import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';

const require = createRequire(import.meta.url);
const root = resolve('.');
const runtime = join(root, '.runtime');
const directory = await mkdtemp(join(tmpdir(), 'centre-study-ui-'));
await mkdir(runtime, { recursive: true });
await mkdir(join(directory, 'data'));
const timeZone = 'Australia/Sydney';
const today = Temporal.Now.zonedDateTimeISO(timeZone).toPlainDate();
const monday = today.subtract({ days: today.dayOfWeek - 1 });
const sessions = [];
for (let week = 0; week < 8; week++) {
  const date = monday.subtract({ days: week * 7 });
  const start = date.toZonedDateTime({ timeZone, plainTime: '06:00:00.123' }).toInstant();
  const end = start.add({ minutes: 60 + (week % 4) * 30 });
  if (end.epochMilliseconds > Date.now()) continue;
  sessions.push({ schemaVersion: 1, id: randomUUID(), revision: 1, createdAt: start.toString(), updatedAt: end.toString(), deletedAt: null, source: 'manual', subjectId: week % 2 ? 'qa-english' : 'qa-math', taskId: null, title: week % 2 ? 'Essay planning' : 'Algebra revision', notes: 'Synthetic local verification entry.', timeZone, segments: [{ start: start.toString(), end: end.toString() }], state: { kind: 'completed' } });
}
const fixture = {
  subjects: [{ id: 'qa-math', name: 'Mathematics', shortName: 'Maths', color: '#8ea6e8', icon: 'book' }, { id: 'qa-english', name: 'English', shortName: null, color: '#bd9ac7', icon: 'book' }],
  topics: [], resources: [], chats: [], events: [{ id: 'planned', title: 'Planned study, not actual time', date: today.toString(), time: '21:00', subjectId: null, notes: 'Planned only' }], memories: [], assignments: [{ id: 'qa-task', title: 'Chapter exercises', kind: 'work', subjectId: 'qa-math', dueDate: null, status: 'pending', version: 1 }],
  settings: { theme: 'dark', timeZone }, codex: { available: false, authenticated: false, message: 'Local UI verification.' }, lastSyncedAt: null,
  studyLog: { schemaVersion: 1, sessions, goals: [] },
};
await writeFile(join(directory, 'data/state.json'), JSON.stringify(fixture));
const entry = join(runtime, `verify-study-log-${process.pid}.cjs`);
const screenshots = Object.fromEntries(['dark', 'light-large', 'midnight', 'manual', 'date-picker', 'date-picker-small', 'time-suggestions', 'narrow', 'aim', 'timer', 'recovered', 'countdown-dark', 'countdown-light-large', 'countdown-narrow', 'countdown-error', 'countdown-complete'].map(name => [name, join(runtime, `study-log-${name}.png`)]));
const report = join(runtime, 'study-log-ui-results.json');
const source = `
const { app, BrowserWindow, dialog } = require('electron');
const { writeFile, readFile } = require('node:fs/promises');
const assert = require('node:assert/strict');
app.disableHardwareAcceleration();
app.setPath('userData', ${JSON.stringify(join(directory, 'user'))});
dialog.showErrorBox = (title, message) => { console.error(title + ': ' + message); app.exit(1); };
let window; let done = false;
const checks = []; const errors = [];
const shots = ${JSON.stringify(screenshots)};
const evaluate = script => window.webContents.executeJavaScript(script, true);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function wait(script) { for (let i = 0; i < 200; i++) { if (await evaluate(script)) return; await delay(50); } throw new Error('Timed out: ' + script + '\\n' + await evaluate('document.body.innerText'));  }
async function check(name, script) { const result = await evaluate(script); assert.ok(result, name); checks.push({name,passed:true}); console.log('PASS ' + name); }
const click = text => evaluate('(()=>{const b=[...(document.querySelector("dialog[open]")||document).querySelectorAll("button")].find(b=>b.textContent.trim()==='+JSON.stringify(text)+');if(!b)throw new Error("Button missing");b.click();})()');
const hasLabel = label => '[...document.querySelectorAll("button")].some(b=>b.getAttribute("aria-label")==='+JSON.stringify(label)+'&&!b.disabled)';
const clickLabel = label => evaluate('(()=>{const b=[...document.querySelectorAll("button")].find(b=>b.getAttribute("aria-label")==='+JSON.stringify(label)+');if(!b)throw new Error("Labelled button missing");b.click();})()');
async function field(selector, value) { await evaluate('(()=>{const e=document.querySelector('+JSON.stringify(selector)+');Object.getOwnPropertyDescriptor(e.tagName==="TEXTAREA"?HTMLTextAreaElement.prototype:e.tagName==="SELECT"?HTMLSelectElement.prototype:HTMLInputElement.prototype,"value").set.call(e,'+JSON.stringify(value)+');e.dispatchEvent(new Event("input",{bubbles:true}));e.dispatchEvent(new Event("change",{bubbles:true}));})()'); }
async function shot(name) {
  await wait('document.querySelector("h1")?.textContent==="Log"');
  await evaluate('(async()=>{await Promise.allSettled(document.getAnimations().filter(a=>a.effect?.getComputedTiming().endTime!==Infinity).map(a=>a.finished));await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));})()');
  for(let attempt=0;attempt<3;attempt++) { try { await writeFile(shots[name], (await window.webContents.capturePage()).toPNG()); return; } catch(error) { if(attempt===2)throw error; await delay(200); } }
}
async function finish(error) { if(done)return; done=true; if(error)console.error(error); await writeFile(${JSON.stringify(report)}, JSON.stringify({passed:!error,phase:process.env.CENTRE_STUDY_PHASE,renderer:process.env.CENTRE_RENDERER_URL,checks,errors,screenshots:shots,error:error?.message},null,2)); if(error)app.exit(1);else app.quit(); }
app.on('browser-window-created', (_event, win) => {
  if(window)return; window=win; window.setSize(1280,900); window.webContents.setBackgroundThrottling(false);
  window.webContents.on('console-message', event => { if(event.level==='error') errors.push(event.message); });
  window.webContents.once('did-finish-load', async()=>{ try {
    await wait('Boolean(window.centre)&&Boolean(document.querySelector(".study-timer button:not(:disabled)"))');
    await click('Log'); await wait('Boolean(document.querySelector(".study-aim"))');
    await check('Production Log renders through real desktop IPC', 'document.title==="Centre"&&document.querySelector("h1").textContent==="Log"');
    if(process.env.CENTRE_STUDY_PHASE==='countdown') {
      await clickLabel('Resume study timer');
      await wait('!document.querySelector(".study-timer__readout")');
      const state = await evaluate('window.centre.request("GET","/study-log")');
      const completed = state.sessions.find(s=>s.title==='Finishing countdown');
      assert.equal(completed.state.kind,'completed');
      assert.equal(completed.segments.reduce((sum,s)=>sum+Date.parse(s.end)-Date.parse(s.start),0),300000);
      checks.push({name:'Countdown automatically completes and saves exactly five active minutes',passed:true});
      await shot('countdown-complete');
      await evaluate('document.querySelector(".study-timer button").click()');
      await click('Start timer');
      await wait(hasLabel('Pause study timer'));
      const started = await evaluate('window.centre.request("GET","/study-log")');
      const fresh = started.sessions.find(s=>s.state.kind==='running');
      assert.equal(fresh.title,'Study session'); assert.equal(fresh.targetMinutes,30);
      checks.push({name:'Default countdown starts without entering study details',passed:true});
      await clickLabel('Stop and save study timer');
      assert.deepEqual(errors,[]);
      await finish(); return;
    }
    if(process.env.CENTRE_STUDY_PHASE==='restart') {
      await check('Restart recovers timer paused at checkpoint', 'document.querySelector(".study-active").textContent.includes("Recovered paused at the last saved checkpoint")');
      const state = await evaluate('window.centre.request("GET","/study-log")');
      const before = JSON.parse(await readFile(${JSON.stringify(join(directory, 'checkpoint.json'))}, 'utf8'));
      const timer = state.sessions.find(s=>s.id===before.id);
      assert.equal(timer.state.kind,'paused');
      const elapsed=timer.segments.reduce((sum,s)=>sum+Date.parse(s.end)-Date.parse(s.start),0);
      assert.equal(elapsed,before.elapsed);
      checks.push({name:'Closed-app time is absent from recovered duration',passed:true});
      await shot('recovered');
      await clickLabel('Resume study timer'); await wait(hasLabel('Pause study timer'));
      await clickLabel('Stop and save study timer'); await wait('!document.querySelector(".study-active")');
      await check('Recovered timer resumes and saves through UI', 'document.querySelector(".study-entries").textContent.includes("Desktop timer")');
      assert.deepEqual(errors,[]); checks.push({name:'No renderer console errors',passed:true});
      await finish(); return;
    }
    await clickLabel('Previous week');
    await evaluate('window.dispatchEvent(new CustomEvent("centre:study-log-action",{detail:{id:"native-week",mode:"week"}}))');
    await wait('document.activeElement?.id==="study-week-title"');
    await check('Week action returns to current week and focuses summary', 'document.querySelector("#study-week-title").textContent.includes("This week")');
    await click('Resources');
    await evaluate('window.dispatchEvent(new CustomEvent("centre:study-log-action",{detail:{id:"native-timer",mode:"timer"}}))');
    await wait('Boolean(document.activeElement?.closest(".study-timer"))');
    await check('Timer action focuses controls without starting time or changing page', 'document.querySelector("h1").textContent==="Resources"&&!document.querySelector("dialog[open]")&&!document.querySelector(".study-timer__readout")');
    await evaluate('window.dispatchEvent(new CustomEvent("centre:study-log-action",{detail:{id:"native-manual",mode:"manual"}}))');
    await wait('Boolean(document.querySelector("dialog[open]"))');
    await check('Manual action opens the existing Log form', 'document.querySelector("h1").textContent==="Log"&&document.querySelector("dialog").textContent.includes("Add study time")');
    await click('Cancel');
    await evaluate('window.dispatchEvent(new CustomEvent("centre:study-log-action",{detail:{id:"native-manual",mode:"manual"}}))');
    await check('Repeated action ID does not reopen a form', '!document.querySelector("dialog[open]")');
    await check('Zero study days have no filled chart marker', '[...document.querySelectorAll(".study-days__day")].filter(e=>e.getAttribute("aria-label").endsWith(": 0 min")).every(e=>e.querySelector(".study-days__track > span").getBoundingClientRect().height===0)');
    await click('Set weekly aim'); await field('dialog input[type=number]','5');
    await evaluate('document.querySelector("dialog [role=combobox]").click()');
    await wait('Boolean(document.querySelector("[role=listbox]"))');
    await evaluate('[...document.querySelectorAll("[role=option]")].find(e=>e.textContent.trim()==="20 min").dispatchEvent(new MouseEvent("mousedown",{bubbles:true,cancelable:true}))');
    await shot('aim'); await click('Save weekly aim'); await wait('!document.querySelector("dialog[open]")');
    await check('Weekly aim accepts non-quarter-hour minutes', 'document.querySelector(".study-aim").textContent.includes("5 h 20 min weekly aim")');
    await click('Edit weekly aim'); await evaluate('document.querySelector("dialog [role=combobox]").click()');
    await wait('Boolean(document.querySelector("[role=listbox]"))');
    await evaluate('[...document.querySelectorAll("[role=option]")].find(e=>e.textContent.trim()==="0 min").dispatchEvent(new MouseEvent("mousedown",{bubbles:true,cancelable:true}))');
    await click('Save weekly aim');
    await wait('!document.querySelector("dialog[open]")');
    await check('Weekly aim saves and displays progress', 'document.querySelector(".study-aim").textContent.includes("5 h weekly aim")');
    await shot('dark');
    const measuredBefore = await evaluate('window.centre.request("GET","/study-log")');
    await clickLabel('Edit Algebra revision');
    await check('Shared fields display Australian dates and minute-only times', '!document.querySelector("dialog input[type=datetime-local]")&&/^[0-9]{1,2} [A-Za-z]+ 2026$/.test(document.querySelector(".centre-date-trigger").textContent)&&document.querySelector(".centre-time-field input").value==="06:00"');
    await clickLabel('Start date');
    await wait('Boolean(document.querySelector(".centre-date-panel [role=grid]"))');
    await check('Date picker focuses selected day', 'document.activeElement?.getAttribute("aria-selected")==="true"');
    await shot('date-picker');
    window.setSize(960,660); await delay(100);
    await check('Shared picker remains within minimum desktop height', '(()=>{const r=document.querySelector(".centre-date-panel").getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight})()');
    await shot('date-picker-small'); window.setSize(1280,900); await delay(100);
    await evaluate('document.activeElement.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowRight",bubbles:true,cancelable:true}))');
    await delay(50);
    await check('Calendar arrow navigation moves one day', 'document.activeElement?.getAttribute("data-date")!==document.querySelector(".centre-date-grid [aria-selected=true]").getAttribute("data-date")');
    await evaluate('document.activeElement.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true}))');
    await check('Escape closes only picker and restores its trigger', '!document.querySelector(".centre-date-panel")&&Boolean(document.querySelector("dialog[open]"))&&document.activeElement.getAttribute("aria-label")==="Start date"');
    await clickLabel('Start time suggestions');
    await wait('Boolean(document.querySelector(".centre-time-options"))');
    await check('Time suggestions focus the actual selected minute', 'document.activeElement?.textContent==="6:00 am"');
    await shot('time-suggestions');
    await evaluate('document.activeElement.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true}))');
    await field('dialog input[aria-label="Start time"]','06:00');
    await field('dialog textarea','Metadata-only edit preserves measured precision.');
    await click('Save study time'); await wait('!document.querySelector("dialog[open]")');
    const measuredAfter = await evaluate('window.centre.request("GET","/study-log")');
    const measuredId = measuredBefore.sessions.find(s=>s.segments[0]?.start.includes('.123')).id;
    assert.deepEqual(measuredAfter.sessions.find(s=>s.id===measuredId).segments,measuredBefore.sessions.find(s=>s.id===measuredId).segments);
    checks.push({name:'Metadata/same-minute edit preserves exact UTC milliseconds on disk',passed:true});
    window.setSize(960,900); await delay(100);
    await check('Minimum desktop width keeps daily labels and chart baselines aligned', '(()=>{const tracks=[...document.querySelectorAll(".study-days__track")].map(e=>e.getBoundingClientRect().top);return Math.max(...tracks)-Math.min(...tracks)<1&&[...document.querySelectorAll(".study-days__value")].every(e=>e.scrollWidth<=e.clientWidth+1)})()');
    await check('Edit and Delete controls have at least 28px targets', '[...document.querySelectorAll(".study-entry__end button")].every(e=>e.getBoundingClientRect().height>=28)');
    await shot('narrow'); window.setSize(1280,900); await delay(100);
    await click('Add study time'); await field('dialog input[maxlength="200"]','Away from computer');
    await evaluate('document.querySelector("dialog [role=combobox]").click()');
    await wait('Boolean(document.querySelector("[role=listbox]"))');
    await evaluate('[...document.querySelectorAll("[role=option]")].find(e=>e.textContent.includes("Mathematics")).dispatchEvent(new MouseEvent("mousedown",{bubbles:true,cancelable:true}))');
    await field('dialog textarea','Paper exercises, entered through the real form.');
    await shot('manual'); await click('Save study time'); await wait('!document.querySelector("dialog[open]")');
    await check('Manual entry updates actual study total', 'document.querySelector(".study-aim").textContent.includes("2 h studied")');
    await clickLabel('Edit Away from computer'); await field('dialog input[maxlength="200"]','Edited away study'); await click('Save study time'); await wait('!document.querySelector("dialog[open]")');
    await check('Entry metadata edit keeps duration', 'document.querySelector(".study-entries").textContent.includes("Edited away study")&&document.querySelector(".study-aim").textContent.includes("2 h studied")');
    await clickLabel('Delete Edited away study'); await click('Delete study entry'); await wait('!document.querySelector("dialog[open]")');
    await check('Delete removes actual time without counting planned Calendar entry', 'document.querySelector(".study-aim").textContent.includes("1 h studied")');
    for (const [name,theme,textSize,density] of [['light-large','light','large','comfortable'],['midnight','midnight','standard','compact'],['dark','dark','standard','compact']]) {
      await evaluate('window.centre.request("PATCH","/settings",'+JSON.stringify({theme,textSize,density})+')');
      await new Promise(resolve => { window.webContents.once('did-finish-load',resolve); window.webContents.reload(); });
      await wait('Boolean(document.querySelector(".study-timer button:not(:disabled)"))'); await click('Log');
      await wait('document.documentElement.dataset.theme==='+JSON.stringify(theme)+'&&document.documentElement.dataset.textSize==='+JSON.stringify(textSize));
      await check('Theme and text settings apply: '+name, 'document.documentElement.scrollWidth<=innerWidth'); await check('Neutral action and data tokens: '+name, '(()=>{const c=getComputedStyle(document.documentElement);return c.getPropertyValue("--accent").trim()===c.getPropertyValue("--text-2").trim()&&getComputedStyle(document.querySelector(".study-days__track > span")).backgroundColor===getComputedStyle(document.querySelector(".study-week-chart__track > span")).backgroundColor})()'); await shot(name);
      await evaluate('document.querySelector(".study-timer button").click()');
      await check('Countdown defaults to 30 minutes with optional details: '+name, 'document.querySelector(".study-countdown output").textContent==="30minutes"&&!document.querySelector("dialog details").open');
      await check('Countdown has visible initial keyboard focus: '+name, 'document.activeElement?.getAttribute("aria-label")==="Decrease timer by 5 minutes"');
      if(name!=='midnight') await shot('countdown-'+name);
      await click('Cancel');
    }
    await evaluate('document.querySelector(".study-timer button").click()');
    await clickLabel('Increase timer by 5 minutes');
    await check('Plus adds exactly five minutes', 'document.querySelector(".study-countdown output").textContent==="35minutes"');
    for(let i=0;i<6;i++) await clickLabel('Decrease timer by 5 minutes');
    await check('Minus stops at five minutes', 'document.querySelector(".study-countdown output").textContent==="5minutes"&&[...document.querySelectorAll("dialog button")].find(b=>b.getAttribute("aria-label")==="Decrease timer by 5 minutes").disabled');
    for(let i=0;i<4;i++) await clickLabel('Increase timer by 5 minutes');
    window.setSize(960,660); await delay(100);
    await check('Countdown fits the minimum desktop window', '(()=>{const r=document.querySelector("dialog").getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight&&document.querySelector("dialog").scrollWidth<=r.width})()');
    await shot('countdown-narrow'); window.setSize(1280,900);
    await evaluate('document.querySelector("dialog summary").click()');
    await field('dialog input[maxlength="200"]','Desktop timer');
    const conflictId = ${JSON.stringify(randomUUID())};
    await evaluate('window.centre.request("POST","/study-log/timer/start",'+JSON.stringify({id:conflictId,title:'Concurrent timer',notes:'Synthetic conflict',subjectId:null,taskId:null,timeZone:'Australia/Sydney',targetMinutes:30})+')');
    await click('Start timer');
    await wait('Boolean(document.querySelector("dialog [role=alert]"))');
    await wait('!document.querySelector("dialog button[type=button]").disabled');
    await check('Failed start retains chosen duration and allows retry', 'document.querySelector(".study-countdown output").textContent==="25minutes"&&!document.querySelector("dialog button[type=button]").disabled');
    await shot('countdown-error');
    await evaluate('(async()=>{const l=await window.centre.request("GET","/study-log");const s=l.sessions.find(s=>s.id==='+JSON.stringify(conflictId)+');await window.centre.request("POST","/study-log/timer/"+s.id+"/stop",{expectedRevision:s.revision});})()');
    await click('Start timer');
    await wait(hasLabel('Pause study timer'));
    await check('Chosen duration starts as a countdown', '(()=>{const t=document.querySelector(".study-timer__readout");return t.getAttribute("aria-label").includes("remaining")&&/^00:2[45]:/.test(t.textContent)})()');
    await delay(1100); await click('Resources');
    await check('Timer survives navigation without leaving the current page', 'document.querySelector("h1").textContent==="Resources"&&'+hasLabel('Pause study timer'));
    await clickLabel('Pause study timer'); await wait(hasLabel('Resume study timer'));
    const paused = await evaluate('document.querySelector(".study-timer__readout").textContent'); await delay(1100);
    assert.equal(await evaluate('document.querySelector(".study-timer__readout").textContent'),paused); checks.push({name:'Paused timer display stays fixed',passed:true});
    await clickLabel('Resume study timer'); await wait(hasLabel('Pause study timer'));
    await click('Log'); await shot('timer');
    await evaluate('(async()=>{let l=await window.centre.request("GET","/study-log");let s=l.sessions.find(s=>s.state.kind==="running");return window.centre.request("POST","/study-log/timer/"+s.id+"/heartbeat",{expectedRevision:s.revision,activity:true})})()');
    const log = await evaluate('window.centre.request("GET","/study-log")');
    const active=log.sessions.find(s=>s.state.kind==='running');
    await writeFile(${JSON.stringify(join(directory, 'checkpoint.json'))},JSON.stringify({id:active.id,elapsed:active.segments.reduce((sum,s)=>sum+Date.parse(s.end)-Date.parse(s.start),0)+Date.parse(active.state.checkpointAt)-Date.parse(active.state.since)}));
    assert.deepEqual(errors,[]); checks.push({name:'No renderer console errors',passed:true});
    await finish();
  } catch(error) { await finish(error); } });
});
setTimeout(()=>finish(new Error('Study verification timed out')),60000).unref();
require(${JSON.stringify(join(root, 'dist-electron/main.cjs'))});
`;
await writeFile(entry, source);
let failure = false;
try {
  for (const phase of ['initial', 'restart', 'countdown']) {
    if (phase === 'countdown') {
      const end = Date.now() - 1000;
      const stamp = new Date(end).toISOString();
      const session = { schemaVersion:1, id:randomUUID(), revision:1, createdAt:new Date(end-298000).toISOString(), updatedAt:stamp, deletedAt:null, source:'timer', subjectId:null, taskId:null, title:'Finishing countdown', notes:'Synthetic near-completion fixture.', timeZone, targetMinutes:5, segments:[{start:new Date(end-298000).toISOString(),end:stamp}], state:{kind:'paused',reason:'user'} };
      await writeFile(join(directory,'data/state.json'),JSON.stringify({...fixture,studyLog:{schemaVersion:1,sessions:[session],goals:[]}}));
    }
    const env = { ...process.env, CENTRE_STUDY_PHASE: phase, CENTRE_DATA_DIR: join(directory, 'data'), CENTRE_RENDERER_URL: pathToFileURL(join(root, 'dist/index.html')).href, CENTRE_CODEX_BIN: '/centre-verification/no-codex' };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require('electron'), [entry], { env, cwd: root, stdio: 'inherit' });
    const code = await new Promise((resolveExit, reject) => { child.once('error', reject); child.once('exit', resolveExit); });
    if (code !== 0) { failure = true; break; }
    const phaseReport = JSON.parse(await readFile(report, 'utf8'));
    await writeFile(join(runtime, `study-log-ui-${phase}.json`), JSON.stringify(phaseReport, null, 2));
  }
} finally {
  await rm(entry, { force: true }); await rm(directory, { recursive: true, force: true });
}
if (failure) process.exitCode = 1;
