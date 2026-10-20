import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir, platform, arch, cpus } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const buildRoot = resolve(process.env.CENTRE_BENCHMARK_BUILD_ROOT ?? root);
const label = process.argv[2] ?? 'current';
assert.match(label, /^[a-z0-9-]+$/i);
const runs = Number(process.argv[3] ?? 3);
assert.ok(Number.isInteger(runs) && runs > 0 && runs <= 20);
const preloadMode = process.argv.includes('--hover') ? 'hover' : process.argv.includes('--focus') ? 'focus' : null;
const runtime = join(root, '.runtime', 'performance');
await mkdir(runtime, { recursive: true });
const timestamp = '2026-10-20T00:00:00.000Z';
const markdown = '## Solving equations\n\nSubtract the same amount from both sides, then divide by the coefficient. For $3x + 2 = 17$, we get $x = 5$.\n\n| Step | Result |\n| --- | --- |\n| Subtract 2 | $3x = 15$ |\n| Divide by 3 | $x = 5$ |\n\nCheck your answer by substituting it into the original equation.\n\n';
const fixture = {
  subjects: [{ id: 'math', name: 'Mathematics', shortName: 'Maths', color: '#6f83b6', icon: 'book' }],
  topics: [], resources: [], events: [], memories: [], assignments: [], settings: {},
  codex: { available: false, authenticated: false, message: 'Benchmark fixture' }, lastSyncedAt: null,
  chats: Array.from({ length: 80 }, (_, chat) => ({
    id: `bench-${chat}`, title: `Benchmark chat ${chat}`, createdAt: timestamp, updatedAt: timestamp,
    messages: Array.from({ length: 24 }, (_, message) => ({
      id: `message-${chat}-${message}`, role: message % 2 ? 'assistant' : 'user',
      content: message % 2 ? markdown.repeat(4) : 'Can you explain how to solve this equation?', createdAt: timestamp,
    })),
  })),
};
const results = [];
for (let run = 0; run < runs; run++) {
  const temporary = await mkdtemp(join(tmpdir(), 'centre-performance-'));
  const data = join(temporary, 'data');
  await mkdir(data);
  await writeFile(join(data, 'state.json'), JSON.stringify(fixture));
  const resultFile = join(temporary, 'result.json');
  const entry = join(runtime, `runner-${process.pid}.cjs`);
  await writeFile(entry, `
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const { writeFile } = require('node:fs/promises');
const assert = require('node:assert/strict');
const started = performance.now();
app.setPath('userData', ${JSON.stringify(join(temporary, 'user'))});
dialog.showErrorBox = (title, message) => { console.error(title, message); app.exit(1); };
let requests = [];
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) => handle(channel, channel !== 'centre:request' ? listener : async (...args) => {
  const start = performance.now();
  const result = await listener(...args);
  requests.push({ path: args[2], bytes: Buffer.byteLength(JSON.stringify(result)), ms: performance.now() - start });
  return result;
});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
app.once('browser-window-created', (_, window) => {
  window.webContents.setBackgroundThrottling(false);
  const moduleRequests = [];
  window.webContents.session.webRequest.onCompleted(details => {
    if (details.url.includes('/MarkdownContent-') && details.url.endsWith('.js')) moduleRequests.push(details.url);
  });
  const evaluate = script => window.webContents.executeJavaScript(script);
  const errors = [];
  window.webContents.on('console-message', (_, details) => { if (details.level === 'error') errors.push(details.message); });
  const waitFor = async expression => {
    const end = Date.now() + 15000;
    while (Date.now() < end) { if (await evaluate(expression)) return; await pause(20); }
    throw new Error('Timed out: ' + expression);
  };
  const frames = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const metrics = async () => {
    const values = (await window.webContents.debugger.sendCommand('Performance.getMetrics')).metrics;
    return Object.fromEntries(values.map(value => [value.name, value.value]));
  };
  const cpu = () => app.getAppMetrics().reduce((total, item) => total + item.cpu.cumulativeCPUUsage, 0);
  const memory = () => app.getAppMetrics().find(item => item.pid === window.webContents.getOSProcessId())?.memory;
  window.webContents.once('did-finish-load', async () => {
    try {
      await evaluate('Object.defineProperty(document,"visibilityState",{configurable:true,get:()=>"visible"});true');
      await waitFor('Boolean(document.querySelector(".home__shortcuts"))');
      await frames();
      const startupMs = performance.now() - started;
      const home = await evaluate('({ readyMs: performance.now() })');
      let preload = null;
      if (${JSON.stringify(preloadMode)} !== null) {
        const resources = () => moduleRequests.length;
        assert.equal(await resources(),0,'Markdown should not load before user intent');
        const preloadStart = performance.now();
        await evaluate(${JSON.stringify(preloadMode === 'focus' ? 'document.querySelector(".chat-nav__item").focus();true' : 'document.querySelector(".chat-nav__item").dispatchEvent(new PointerEvent("pointerover",{bubbles:true,pointerType:"mouse"}));true')});
        const deadline = Date.now() + 10000;
        while (!await resources()) { assert.ok(Date.now() < deadline,'Intent should preload the Markdown module'); await pause(10); }
        await frames();
        assert.equal(await evaluate('document.querySelectorAll(".markdown").length'),0,'Preloading must not navigate');
        await evaluate('document.querySelector(".chat-nav__item").dispatchEvent(new PointerEvent("pointerover",{bubbles:true,pointerType:"mouse"}));true');
        assert.equal(await resources(),1,'Repeated intent must reuse one module load');
        preload = { mode:${JSON.stringify(preloadMode)}, moduleRequests:1, ms:performance.now()-preloadStart, navigated:false };
      }
      const open = performance.now();
      await evaluate('[...document.querySelectorAll(".chat-nav button")].find(e=>e.textContent.trim()==="Benchmark chat 0").click()');
      await waitFor('document.querySelectorAll(".message--assistant .markdown .katex").length >= 12');
      await frames();
      const chatOpenMs = performance.now() - open;
      if (${process.argv.includes('--capture')}) await writeFile(${JSON.stringify(join(runtime,`${label}-${run+1}.png`))},(await window.webContents.capturePage()).toPNG());
      await pause(600);
      window.webContents.debugger.attach('1.3');
      await window.webContents.debugger.sendCommand('Performance.enable');
      await window.webContents.debugger.sendCommand('HeapProfiler.collectGarbage');
      const memoryBefore = memory();
      const before = await metrics();
      const cpuBefore = cpu();
      const mainBefore = process.cpuUsage();
      const requestStart = requests.length;
      await pause(11000);
      const mainCpu = process.cpuUsage(mainBefore);
      const cpuAfter = cpu();
      const after = await metrics();
      const idleRequests = requests.slice(requestStart).filter(item => item.path.startsWith('/state'));
      assert.equal(idleRequests.length,2,'Expected two foreground polls during the idle window');
      await window.webContents.debugger.sendCommand('HeapProfiler.collectGarbage');
      const retained = await metrics();
      const memoryAfter = memory();
      await writeFile(${JSON.stringify(resultFile)}, JSON.stringify({ startupMs, home, preload, chatOpenMs,
        idle: { durationMs:11000, stateRequests:idleRequests.length, ipcBytes:idleRequests.reduce((sum,item)=>sum+item.bytes,0),
          requestMs:idleRequests.reduce((sum,item)=>sum+item.ms,0), rendererTaskMs:(after.TaskDuration-before.TaskDuration)*1000,
          mainCpuMs:(mainCpu.user+mainCpu.system)/1000, appCpuMs:(cpuAfter-cpuBefore)*1000,
          rendererHeapBeforeBytes:before.JSHeapUsedSize, rendererHeapAfterBytes:retained.JSHeapUsedSize,
          rendererMemoryBefore:memoryBefore, rendererMemoryAfter:memoryAfter }, errors }, null, 2));
      assert.equal(errors.length,0,JSON.stringify(errors));
      window.webContents.debugger.detach();
      app.quit();
    } catch (error) { console.error(error); app.exit(1); }
  });
});
setTimeout(()=>{ console.error('Benchmark timed out waiting for the native app.'); app.exit(1); },45000).unref();
require(${JSON.stringify(join(buildRoot, 'dist-electron', 'main.cjs'))});
`);
  const environment = { ...process.env, CENTRE_DATA_DIR: data,
    CENTRE_CODEX_BIN: '/centre-benchmark/no-codex',
    CENTRE_RENDERER_URL: pathToFileURL(join(buildRoot, 'dist', 'index.html')).href };
  delete environment.ELECTRON_RUN_AS_NODE;
  try {
    const child = spawn(require('electron'), ['--user-data-dir='+join(temporary,'user'), entry], { cwd: root, env: environment, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    const code = await new Promise((accept, reject) => { child.once('error', reject); child.once('exit', accept); });
    assert.equal(code, 0, stderr);
    const result = JSON.parse(await readFile(resultFile, 'utf8'));
    results.push(result);
    console.log(JSON.stringify({ label, run:run+1, startupMs:result.startupMs, preload:result.preload, chatOpenMs:result.chatOpenMs, idle:result.idle }));
  } finally {
    await rm(temporary, { recursive:true, force:true });
    await rm(entry, { force:true });
  }
}
const assets = [];
for (const file of await readdir(join(buildRoot, 'dist', 'assets'))) {
  if (!file.endsWith('.js')) continue;
  const bytes = await readFile(join(buildRoot, 'dist', 'assets', file));
  assets.push({ file, bytes:bytes.length, gzipBytes:gzipSync(bytes).length });
}
const report = { label, measuredAt:new Date().toISOString(), environment:{ platform:platform(), arch:arch(), cpu:cpus()[0].model, node:process.version, electron:require('electron/package.json').version },
  fixture:{ chats:80, messagesPerChat:24, bytes:Buffer.byteLength(JSON.stringify(fixture)), ai:'disabled', network:'local IPC only', visibility:'forced foreground; background throttling disabled', preloadMode }, assets, results };
await writeFile(join(runtime, label+'.json'), JSON.stringify(report,null,2)+'\n');
console.log('Saved .runtime/performance/'+label+'.json');
