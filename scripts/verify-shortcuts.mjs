import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Run after build + build:electron. CENTRE_VERIFY_ROOT selects a combined Log
// build. --integration requires its real Study Log provider and UI.
// --isolated uses a fake Codex catalog and blocks remote traffic.
// --output-dir keeps reports, screenshots and the wrapper outside the checkout.
const args = process.argv.slice(2);
function option(name) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  assert.ok(args[index + 1] && !args[index + 1].startsWith('--'), `${name} needs a path`);
  return resolve(args[index + 1]);
}
const root = option('--root') ?? (process.env.CENTRE_VERIFY_ROOT ? resolve(process.env.CENTRE_VERIFY_ROOT) : resolve(dirname(fileURLToPath(import.meta.url)), '..'));
assert.ok(!args.includes('--packaged'), 'Packaged OS verification is separate from this native wrapper suite.');
const integration = args.includes('--integration');
const isolated = args.includes('--isolated');
const require = createRequire(join(root, 'package.json'));
const runtime = option('--output-dir') ?? join(root, '.runtime');
const scratch = await mkdtemp(join(tmpdir(), 'centre-shortcuts-'));
const desktop = join(scratch, 'Desktop');
const profile = join(scratch, 'profile');
const data = join(scratch, 'data');
const wrapper = join(runtime, `verify-shortcuts-${process.pid}.cjs`);
const controlFile = join(scratch, 'control.json');
const reportPath = join(runtime, 'shortcuts-report.json');
const report = { passed: false, mode: 'real main wrapper + CDP', integration, isolated, checks: [], limitations: [], screenshots: {} };
const pause = ms => new Promise(resolvePause => setTimeout(resolvePause, ms));
let child;
let socket;
let control;
let nextId = 0;
const pending = new Map();
const token = randomUUID();
const url = action => `centre://action/${action}`;

function check(name, condition, details) {
  report.checks.push({ name, passed: Boolean(condition), ...(details === undefined ? {} : { details }) });
  console.log(`${condition ? 'PASS' : 'FAIL'} ${name}`);
  assert.ok(condition, name);
}
async function until(fn, label, timeout = 15000) {
  const end = Date.now() + timeout;
  let lastError;
  while (Date.now() < end) {
    try { const value = await fn(); if (value) return value; } catch (error) { lastError = error; }
    await pause(100);
  }
  throw new Error(`Timed out: ${label}${lastError ? ` (${lastError.message})` : ''}`);
}
async function freePort() {
  const server = createServer();
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const port = server.address().port;
  await new Promise(resolveClose => server.close(resolveClose));
  return port;
}
function cdp(method, params = {}) {
  const id = ++nextId;
  return new Promise((resolveCall, rejectCall) => {
    const timer = setTimeout(() => { pending.delete(id); rejectCall(new Error(`CDP timeout: ${method}`)); }, 15000);
    pending.set(id, { resolve: resolveCall, reject: rejectCall, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function connect(port) {
  const target = await until(async () => {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    return targets.find(item => item.type === 'page' && item.url.startsWith('file:'));
  }, 'production renderer CDP target', 30000);
  socket = new WebSocket(target.webSocketDebuggerUrl);
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    const call = pending.get(message.id);
    if (!call) return;
    clearTimeout(call.timer); pending.delete(message.id);
    if (message.error) call.reject(new Error(message.error.message)); else call.resolve(message.result);
  });
  await new Promise((resolveOpen, rejectOpen) => { socket.addEventListener('open', resolveOpen, { once: true }); socket.addEventListener('error', rejectOpen, { once: true }); });
  await wait("window.centre?.launchers && document.querySelector('button[aria-label=\"Settings\"]')", 'real preload and mounted renderer');
}
async function evaluate(expression) {
  const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
}
const wait = (expression, label) => until(() => evaluate(`Boolean(${expression})`), label);
async function click(selector, text) {
  await wait(`([...document.querySelectorAll(${JSON.stringify(selector)})].find(e => ${text === undefined ? 'true' : `e.textContent.trim() === ${JSON.stringify(text)}`})?.disabled === false)`, `enabled control ${selector} ${text ?? ''}`);
  await evaluate(`(() => { const element = [...document.querySelectorAll(${JSON.stringify(selector)})].find(e => ${text === undefined ? 'true' : `e.textContent.trim() === ${JSON.stringify(text)}`}); if (!element || element.disabled) throw new Error('Missing or disabled UI control: ' + ${JSON.stringify(`${selector} ${text ?? ''}`)}); element.click(); })()`);
}
async function native(command, value) {
  assert.ok(control, 'Native wrapper controls are not ready');
  const response = await fetch(`http://127.0.0.1:${control.port}`, { method: 'POST', headers: { authorization: token }, body: JSON.stringify({ command, value }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
}
async function screenshot(name) {
  await evaluate("document.querySelectorAll('.toast button[aria-label=\"Dismiss\"]').forEach(button=>button.click())");
  if (/-(installed|missing|conflict)$/.test(name)) {
    await evaluate("document.querySelector('.desktop-settings__row[data-action=\"chat.new\"]').scrollIntoView({block:'center'})");
  }
  await pause(250);
  const image = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const path = join(runtime, `shortcuts-${name}.png`);
  await writeFile(path, Buffer.from(image.data, 'base64'));
  report.screenshots[name] = path;
}
const state = () => evaluate("window.centre.request('GET', '/state')");
const list = () => evaluate('window.centre.launchers.list()');
const searchInput = 'dialog[open] input[role="combobox"][aria-label="Search"]';
const row = action => `.desktop-settings__row[data-action="${action}"]`;
async function status(action, expected) {
  await wait(`document.querySelector(${JSON.stringify(`${row(action)} .desktop-settings__status--${expected}`)})`, `${action} UI ${expected}`);
  check(`${action} IPC reports ${expected}`, (await list()).launchers.find(item => item.action === action)?.state === expected);
}
async function settings() {
  await dismiss();
  await click('button[aria-label="Settings"]');
  await wait("document.querySelector('.settings-layout__nav')", 'Settings navigation');
  await click('.settings-layout__nav button', 'Desktop');
  await wait("document.querySelector('.desktop-settings__row')", 'Desktop settings rows');
}
async function dismiss() {
  // Exercise the real dialog onClose control. Keyboard mapping is outside this
  // Desktop workflow; Search keeps its shared header control visually hidden.
  for (let i = 0; i < 5 && await evaluate("Boolean(document.querySelector('dialog[open]'))"); i++) {
    await click('dialog[open] button[aria-label="Close"]');
    await pause(150);
  }
  await wait("!document.querySelector('dialog[open]')", 'dialogs dismissed');
}
async function theme(value) {
  await click('.settings-layout__nav button', 'General');
  await click('.theme-option', value === 'dark' ? 'Dark' : 'Light');
  await wait(`document.documentElement.dataset.theme === ${JSON.stringify(value)}`, `${value} theme`);
  await click('.settings-layout__nav button', 'Desktop');
  await wait("document.querySelector('.desktop-settings__row')", 'Desktop after theme change');
}
async function bothThemes(name) {
  for (const value of ['dark', 'light']) { await theme(value); await screenshot(`${value}-${name}`); }
}
let executable;
let launchArgs;
let environment;
async function warm(action) {
  const second = spawn(executable, [...launchArgs, url(action)], { cwd: root, env: environment, stdio: 'ignore' });
  await new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => { second.kill(); rejectExit(new Error('Second instance failed to exit')); }, 15000);
    second.once('error', error => { clearTimeout(timer); rejectExit(error); });
    second.once('exit', code => { clearTimeout(timer); code === 0 ? resolveExit() : rejectExit(new Error(`Second instance exited ${code}`)); });
  });
}
async function dispatch(action) {
  await native('open-url', url(action));
}
async function expectAction(action) {
  const expressions = {
    'chat.new': "document.querySelector('.home textarea') && !document.querySelector('dialog[open]')",
    'app.search': `document.querySelector(${JSON.stringify(searchInput)}) === document.activeElement`,
    'app.resources': "document.querySelector('.library-header')",
    'app.calendar': "document.querySelector('.calendar-head')",
    'app.settings': "document.querySelector('.settings-layout__nav')",
  };
  await wait(expressions[action], `${action} visible outcome`);
  await until(async () => {
    const { events } = await native('trace');
    const request = events.findLast(event => event.kind === 'request' && event.action === action);
    return request && events.some(event => event.kind === 'centre:actions:acknowledge' && event.id === request.id);
  }, `${action} acknowledgement from real renderer`);
  check(`${action} changes real renderer and acknowledges delivery`, true);
}

try {
  assert.equal(process.platform, 'darwin', 'Native Desktop launcher verification requires macOS');
  await Promise.all([runtime, desktop, profile, data].map(path => mkdir(path, { recursive: true })));
  const port = await freePort();
  environment = { ...process.env, CENTRE_USER_DATA_DIR: profile, CENTRE_DATA_DIR: data, CENTRE_DESKTOP_DIR: desktop, CENTRE_RENDERER_URL: pathToFileURL(join(root, 'dist/index.html')).href };
  delete environment.ELECTRON_RUN_AS_NODE;
  if (isolated) {
    const binary = join(scratch, 'codex-fixture');
    await writeFile(binary, `#!/usr/bin/env node
const readline=require('node:readline');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const message=JSON.parse(line);if(!message.id)return;
 if(message.method==='turn/start'){process.stdout.write(JSON.stringify({id:message.id,error:{message:'Inference disabled in isolated shortcut verification'}})+String.fromCharCode(10));return}
 const result=message.method==='account/read'?{account:{id:'shortcut-fixture'}}:message.method==='model/list'?{data:[{model:'gpt-6.1-sol',displayName:'Fixture',supportedReasoningEfforts:[{reasoningEffort:'medium'}],defaultReasoningEffort:'medium'}],nextCursor:null}:{};
 process.stdout.write(JSON.stringify({id:message.id,result})+String.fromCharCode(10));
});
`, { mode: 0o700 });
    environment.CENTRE_CODEX_BIN = binary;
    environment.CODEX_HOME = join(scratch, 'codex-home');
    environment.ORGANATO_API_KEY = '';
    report.limitations.push('Isolated mode uses a fake Codex catalog, disables inference and blocks non-loopback fetches in main and remote renderer requests. Organato is disconnected.');
  }
  await Promise.all(['dist/index.html', 'dist-electron/main.cjs', 'dist-electron/preload.cjs'].map(path => readFile(join(root, path))));
  executable = require('electron');
  launchArgs = [wrapper];
  await writeFile(wrapper, `
const {app,BrowserWindow,dialog,ipcMain}=require('electron');
const {createServer}=require('node:http');
const {writeFileSync}=require('node:fs');
dialog.showErrorBox=()=>{console.error('Centre startup failed. Check the local build and OAuth configuration.');app.exit(1)};
const trace=[];
if(${isolated}){
 const fetchLocal=global.fetch;
 global.fetch=(input,options)=>{
  const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);
  if(url.hostname!=='127.0.0.1'&&url.hostname!=='localhost')throw Error('Isolated verifier blocked remote request: '+url.origin);
  return fetchLocal(input,options);
 };
 app.on('web-contents-created',(_,contents)=>contents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(details,callback)=>callback({cancel:!['127.0.0.1','localhost'].includes(new URL(details.url).hostname)})));
}

// Observe the actual handlers, forwarding the same event/arguments/return value.
// No preload bridge, action, ready, or acknowledgement is manufactured here.
const handle=ipcMain.handle.bind(ipcMain);
ipcMain.handle=(channel,listener)=>handle(channel,(event,...args)=>{
 if(channel==='centre:actions:ready'||channel==='centre:actions:acknowledge')trace.push({kind:channel,time:Date.now(),id:args[0]});
 return listener(event,...args);
});
app.on('browser-window-created',(_,win)=>{
 win.webContents.setBackgroundThrottling(false);
 const send=win.webContents.send.bind(win.webContents);
 win.webContents.send=(channel,...args)=>{
  if(channel==='centre:actions:request')trace.push({kind:'request',time:Date.now(),...args[0]});
  return send(channel,...args);
 };
});
const server=createServer(async(req,res)=>{
 if(req.headers.authorization!==${JSON.stringify(token)}){res.writeHead(403);res.end('{}');return}
 try{
  let body='';for await(const chunk of req){body+=chunk;if(body.length>16000)throw Error('Request too large')}
  const {command,value}=JSON.parse(body);const win=BrowserWindow.getAllWindows()[0];let result={};
  if(command==='open-url'){trace.push({kind:'synthetic open-url',url:value,time:Date.now()});app.emit('open-url',{preventDefault(){}},value)}
  else if(command==='trace')result={events:trace};
  else if(command==='activate')app.emit('activate',{},false);
  else if(command==='minimize')win.minimize();
  else if(command==='window')result={minimized:win?.isMinimized(),visible:win?.isVisible(),count:BrowserWindow.getAllWindows().length};
  else if(command==='close')win.close();
  else if(command==='quit')setTimeout(()=>app.quit(),50);
  else throw Error('Unknown verifier command');
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));
 }catch(error){res.writeHead(500);res.end(JSON.stringify({error:error.message}))}
});
require(${JSON.stringify(join(root, 'dist-electron/main.cjs'))});
// A real secondary process must follow main's quit path without acquiring any
// verifier server handles or overwriting the primary control endpoint.
if(app.hasSingleInstanceLock()){
 server.listen(0,'127.0.0.1',()=>writeFileSync(${JSON.stringify(controlFile)},JSON.stringify({port:server.address().port})));
 server.unref();
 app.on('will-quit',()=>server.close());
}
`);
  const syntax = spawnSync(process.execPath, ['--check', wrapper], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
  // Cold argv is supplied before requiring the actual main. No protocol handler
  // registration or default-app changes are made by this verifier.
  child = spawn(executable, [...launchArgs, `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1', url('app.resources')], { cwd: root, env: environment, stdio: 'ignore' });
  child.once('error', error => { report.launchError = error.message; });
  control = await until(async () => JSON.parse(await readFile(controlFile, 'utf8')), 'native wrapper control endpoint');
  await connect(port);
  await expectAction('app.resources');
  await evaluate("window.__shortcutRequests=[];window.__shortcutUnsubscribe=window.centre.actions.subscribe(value=>window.__shortcutRequests.push(value.action))");
  check('Cold startup argv reaches production renderer', true);
  check('Renderer uses isolated preload', await evaluate("typeof require === 'undefined' && typeof window.centre.actions.subscribe === 'function'"));
  if (isolated) {
    await until(async () => (await state()).codex.authenticated, 'isolated Codex fixture handshake');
    check('Isolated Codex fixture completes the real service handshake', (await state()).codex.available);
  }
  const initial = await state();
  check('Fresh isolated profile has no chats', initial.chats.length === 0);
  if (integration) check('--integration requires actual Study Log in service snapshot', 'studyLog' in initial);
  await settings();
  check('Launcher IPC supports isolated native Desktop', (await list()).supported);
  const initialList = (await list()).launchers;
  check('Launcher filenames use generic Internet locations', initialList.length === 8 && initialList.every(item => item.filename.endsWith('.inetloc') && !/[\\/]/.test(item.filename)));
  check('No launcher created on startup', (await readdir(desktop)).length === 0 && initialList.every(item => item.state === 'absent'));
  const active = initialList.filter(item => !item.action.startsWith('study-log.') || 'studyLog' in initial);
  if (!('studyLog' in initial)) {
    check('Study setup is gated by real snapshot', await evaluate("(()=>{const buttons=[...document.querySelectorAll('.desktop-settings__row[data-action^=\"study-log.\"] button')];return buttons.length===3 && buttons.every(button => button.disabled)})()"));
  }
  const requested = [];
  for (const item of active) {
    await click(`${row(item.action)} button`, 'Add icon');
    await status(item.action, 'installed');
    requested.push(item.filename);
    check(`Only requested Desktop files after ${item.action}`, JSON.stringify((await readdir(desktop)).sort()) === JSON.stringify([...requested].sort()));
    const contents = await readFile(join(desktop, item.filename), 'utf8');
    check(`${item.action} launcher contains exact URL`, contents.includes(`<string>${url(item.action)}</string>`));
  }
  await bothThemes('installed');
  const first = active.find(item => item.action === 'chat.new');
  await rm(join(desktop, first.filename));
  await click('.desktop-settings__tools button', 'Refresh icons');
  await status(first.action, 'missing');
  await bothThemes('missing');
  await click(`${row(first.action)} button`, 'Repair');
  await status(first.action, 'installed');
  // Editing an owned hard link also changes its private source. Moving the
  // edited icon aside must let Repair create a fresh source without touching it.
  const modifiedBytes = Buffer.from('Edited owned icon. Keep these bytes.\n');
  const movedIcon = join(scratch, 'moved-user-icon.inetloc');
  await writeFile(join(desktop, first.filename), modifiedBytes);
  await click('.desktop-settings__tools button', 'Refresh icons');
  await status(first.action, 'conflict');
  await rename(join(desktop, first.filename), movedIcon);
  await click('.desktop-settings__tools button', 'Refresh icons');
  await status(first.action, 'missing');
  await click(`${row(first.action)} button`, 'Repair');
  await status(first.action, 'installed');
  check('Repair replaces a modified private source and preserves the moved icon', modifiedBytes.equals(await readFile(movedIcon)) && (await readFile(join(desktop, first.filename), 'utf8')).includes(`<string>${url(first.action)}</string>`));
  await click(`${row(first.action)} button`, 'Remove');
  await status(first.action, 'absent');
  const bytes = Buffer.from('User-owned shortcut fixture\nDo not replace.\n');
  await writeFile(join(desktop, first.filename), bytes, { flag: 'wx' });
  await click('.desktop-settings__tools button', 'Refresh icons');
  await status(first.action, 'conflict');
  check('Conflicting file exposes no destructive controls', await evaluate(`document.querySelector(${JSON.stringify(row(first.action))}).querySelectorAll('button').length === 0`));
  await bothThemes('conflict');
  for (const operation of ['create', 'repair', 'remove']) {
    const rejected = await evaluate(`window.centre.launchers.change('chat.new',${JSON.stringify(operation)}).then(()=>false,()=>true)`);
    check(`IPC ${operation} rejects conflict and preserves bytes`, rejected && bytes.equals(await readFile(join(desktop, first.filename))));
  }
  await rm(join(desktop, first.filename));
  for (const item of active.filter(item => item.action !== first.action)) {
    await click(`${row(item.action)} button`, 'Remove');
    await status(item.action, 'absent');
  }
  check('Remove leaves isolated Desktop empty', (await readdir(desktop)).length === 0);

  await warm('app.calendar');
  await expectAction('app.calendar');
  check('Actual warm second process delivers argv', true);
  report.eventProof = 'open-url cases below use synthetic app.emit events on actual main listeners; warm argv uses a real second Electron process.';
  for (const action of ['chat.new', 'app.search', 'app.resources', 'app.settings']) {
    await dismiss(); await dispatch(action); await expectAction(action);
  }
  // Observe delivery passively. The application bridge still owns ready/ack and
  // executes every action; this observer does not replace it.
  await evaluate('window.__shortcutRequests=[]');
  await dispatch('app.search'); await expectAction('app.search');
  await dispatch('app.resources'); await dispatch('app.calendar');
  await pause(400);
  check('Queued links preserve open dialog and current route', await evaluate(`Boolean(document.querySelector(${JSON.stringify(searchInput)})) && Boolean(document.querySelector('.settings-layout__nav'))`));
  await dismiss();
  await expectAction('app.calendar');
  const received = await evaluate('window.__shortcutRequests');
  check('Multiple queued links arrive in order', JSON.stringify(received) === JSON.stringify(['app.search', 'app.resources', 'app.calendar']), received);
  const beforeMalformed = received.length;
  {
    for (const value of ['centre://action/app.search?x=1', 'centre://action/app.search/', 'centre://action/%61pp.search', 'centre://action/unknown', 'https://action/app.search', 'CENTRE://action/app.search']) await native('open-url', value);
    await pause(400);
    check('Malformed URL events ignored by main without renderer delivery', (await evaluate('window.__shortcutRequests.length')) === beforeMalformed && await evaluate("Boolean(document.querySelector('.calendar-head'))"));
    await native('minimize');
    await until(async () => (await native('window')).minimized, 'native window minimized');
    await dispatch('app.resources'); await expectAction('app.resources');
    check('URL restores minimized native window', !(await native('window')).minimized);
    await native('close');
    await until(async () => (await native('window')).count === 0, 'native window closed');
    socket.close();
    await native('activate');
    await connect(port);
    check('Synthetic app activate recreates closed native window', (await native('window')).count === 1);
    await native('close');
    await until(async () => (await native('window')).count === 0, 'activated window closed');
    socket.close();
    await dispatch('app.calendar');
    await connect(port); await expectAction('app.calendar');
    check('URL recreates closed window and replays after bridge ready', (await native('window')).count === 1);
  }
  if (integration) {
    const before = await state();
    await dispatch('study-log.manual');
    await wait("document.querySelector('dialog[open] .study-form') && document.querySelector('dialog[open] .dialog__title')?.textContent.trim() === 'Add study time'", 'existing manual Study Log form');
    check('Log manual action opens real entry form', true); await screenshot('log-manual'); await dismiss();
    await dispatch('study-log.week');
    await wait("document.activeElement?.id === 'study-week-title'", 'weekly study heading focus');
    check('Log week action focuses #study-week-title', true); await screenshot('log-week');
    await dispatch('study-log.timer');
    await wait("document.activeElement?.closest('.study-timer') && document.activeElement.textContent.trim() === 'Start timer'", 'real Study Log timer controls focus');
    check('Log timer focuses controls and waits for Start', await evaluate("!document.querySelector('dialog[open], .study-timer .is-running') && document.activeElement.closest('.study-timer') !== null"));
    await screenshot('log-timer');
    const after = await state();
    check('Log launches preserve persisted study sessions and timer state', JSON.stringify(before.studyLog) === JSON.stringify(after.studyLog));
  } else report.limitations.push('Study Log UI integration requires --integration against a build whose real snapshot contains studyLog.');
  check('Navigation launches create no chats', (await state()).chats.length === initial.chats.length);
  report.passed = true;
} catch (error) {
  report.error = String(error.stack ?? error);
  console.error(error.message);
  if (socket?.readyState === WebSocket.OPEN) {
    report.rendererAtFailure = await evaluate("({visibility:document.visibilityState,headings:[...document.querySelectorAll('h1')].map(e=>e.textContent),dialog:document.querySelector('dialog[open] .dialog__title')?.textContent,received:window.__shortcutRequests})").catch(() => null);
    await screenshot('failure').catch(() => {});
  }
  process.exitCode = 1;
} finally {
  if (control) report.deliveryTrace = (await native('trace').catch(() => ({ events: [] }))).events;
  if (control) await native('quit').catch(() => {});
  socket?.close();
  if (child && child.exitCode === null) {
    await Promise.race([new Promise(resolveExit => child.once('exit', resolveExit)), pause(5000)]);
    if (child.exitCode === null) child.kill('SIGTERM');
    await Promise.race([new Promise(resolveExit => child.once('exit', resolveExit)), pause(2000)]);
  }
  await mkdir(runtime, { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  await rm(wrapper, { force: true });
  await rm(scratch, { recursive: true, force: true });
  console.log(`Report: ${reportPath}`);
}
