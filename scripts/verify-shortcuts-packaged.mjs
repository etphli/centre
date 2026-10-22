import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createServer } from 'node:net';

// Use an unsigned verification-only bundle ID to avoid other Centre test builds.
const run = promisify(execFile);
const launchEnvironment = { ...process.env };
delete launchEnvironment.ELECTRON_RUN_AS_NODE;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const app = await realpath(resolve(process.argv[2] ?? '.runtime/shortcuts-final-package/mac-arm64/Centre.app'));
const plist = join(app, 'Contents/Info.plist');
const bundleId = (await run('/usr/libexec/PlistBuddy', ['-c', 'Print CFBundleIdentifier', plist])).stdout.trim();
assert.equal(process.platform, 'darwin');
assert.equal(bundleId, 'au.com.centre.desktop.shortcutsverification', 'Build with the verification-only appId override; do not target an installed release.');
const runtime = join(root, '.runtime');
await mkdir(runtime, { recursive: true });
const scratch = await realpath(await mkdtemp(join(tmpdir(), 'centre-packaged-shortcuts-')));
const desktop = join(scratch, 'Desktop');
await Promise.all(['Desktop', 'profile', 'data', 'codex'].map(name => mkdir(join(scratch, name))));
const listener = createServer();
await new Promise(resolveListen => listener.listen(0, '127.0.0.1', resolveListen));
const port = listener.address().port;
await new Promise(resolveClose => listener.close(resolveClose));
const report = { passed: false, bundleId, checks: [], limitations: ['Unsigned local bundle with verification-only bundle ID; signing, notarization and release installation are not verified.'] };
let socket;
let nextId = 0;
const pending = new Map();
async function until(test, label) {
  const end = Date.now() + 30000;
  while (Date.now() < end) {
    try { const value = await test(); if (value) return value; } catch { /* App startup and transitions are asynchronous. */ }
    await new Promise(resolvePause => setTimeout(resolvePause, 100));
  }
  throw new Error(`Timed out: ${label}`);
}
function check(name, value) {
  report.checks.push({ name, passed: Boolean(value) });
  assert.ok(value, name);
  console.log(`PASS ${name}`);
}
function cdp(method, params = {}) {
  return new Promise((accept, reject) => {
    const id = ++nextId;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 10000);
    pending.set(id, { accept, reject, timeout });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
}
try {
  const envArgs = Object.entries({ CENTRE_USER_DATA_DIR: join(scratch, 'profile'), CENTRE_DATA_DIR: join(scratch, 'data'), CENTRE_DESKTOP_DIR: desktop, CODEX_HOME: join(scratch, 'codex'), CENTRE_CODEX_BIN: join(scratch, 'missing-codex') }).flatMap(([key, value]) => ['--env', `${key}=${value}`]);
  await run('/usr/bin/open', ['-n', '-a', app, ...envArgs, '--stdout', join(runtime, 'shortcuts-packaged-stdout.log'), '--stderr', join(runtime, 'shortcuts-packaged-stderr.log'), 'centre://action/app.resources', '--args', `--remote-debugging-port=${port}`], { env: launchEnvironment });
  const target = await until(async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(item => item.type === 'page'), 'packaged renderer');
  check('Renderer comes from the packaged ASAR', target.url.includes('/Contents/Resources/app.asar/dist/index.html'));
  socket = new WebSocket(target.webSocketDebuggerUrl);
  socket.onmessage = event => {
    const result = JSON.parse(event.data);
    const call = pending.get(result.id);
    if (!call) return;
    clearTimeout(call.timeout); pending.delete(result.id);
    result.error ? call.reject(new Error(result.error.message)) : call.accept(result.result);
  };
  await new Promise((accept, reject) => { socket.onopen = accept; socket.onerror = reject; });
  await until(() => evaluate("Boolean(window.centre?.launchers && document.querySelector('.library-header'))"), 'cold URL opens Resources');
  check('Cold macOS URL delivery reaches Resources', true);
  await evaluate("document.querySelector('button[aria-label=\"Settings\"]').click()");
  await until(() => evaluate("Boolean(document.querySelector('.settings-layout__nav'))"), 'Settings');
  await evaluate("[...document.querySelectorAll('.settings-layout__nav button')].find(button=>button.textContent.trim()==='Desktop').click()");
  await until(() => evaluate("Boolean(document.querySelector('[aria-label=\"Add New chat desktop icon\"]'))"), 'Desktop setup');
  await evaluate("document.querySelector('[aria-label=\"Add New chat desktop icon\"]').click()");
  const installed = await until(async () => (await evaluate('window.centre.launchers.list()')).launchers.find(item => item.action === 'chat.new' && item.state === 'installed'), 'icon created by setup UI');
  const icon = join(desktop, installed.filename);
  const xml = await readFile(icon, 'utf8');
  check('Setup creates an individually named native Internet Location', installed.filename === 'Centre – New chat.inetloc' && xml.includes('<string>centre://action/chat.new</string>'));
  const lookup = 'ObjC.import("AppKit"); $.NSWorkspace.sharedWorkspace.URLForApplicationToOpenURL($.NSURL.URLWithString("centre://action/chat.new")).path.js';
  const handler = (await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', lookup])).stdout.trim();
  check('System URL handler is this isolated verification bundle', await realpath(handler) === app);
  await run('/usr/bin/open', [icon]);
  await until(() => evaluate("Boolean(document.querySelector('.home textarea') === document.activeElement)"), 'Finder icon opens New chat and focuses composer');
  check('Opening the actual icon routes to and focuses New chat', true);
  const screenshot = await cdp('Page.captureScreenshot', { format: 'png' });
  report.screenshot = join(runtime, 'shortcuts-packaged-newchat.png');
  await writeFile(report.screenshot, Buffer.from(screenshot.data, 'base64'));
  await run('/usr/bin/open', ['-a', app, 'centre://action/app.settings']);
  await until(() => evaluate("Boolean(document.querySelector('.settings-layout__nav'))"), 'warm macOS URL opens Settings');
  check('Warm macOS URL delivery reuses the running app', true);
  report.passed = true;
} catch (error) {
  report.error = String(error.stack ?? error);
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (socket?.readyState === WebSocket.OPEN) await cdp('Browser.close').catch(() => {});
  socket?.close();
  for (const call of pending.values()) { clearTimeout(call.timeout); call.reject(new Error('Verification ended')); }
  pending.clear();
  let stopped = false;
  for (let i = 0; i < 50; i++) {
    try { await fetch(`http://127.0.0.1:${port}/json/list`); } catch { stopped = true; break; }
    await new Promise(resolvePause => setTimeout(resolvePause, 100));
  }
  if (stopped) {
    await rm(scratch, { recursive: true, force: true });
    await run('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', ['-u', app]);
  } else report.limitations.push(`Verification app did not exit; temporary fixture retained at ${scratch}.`);
  await writeFile(join(runtime, 'shortcuts-packaged-report.json'), `${JSON.stringify(report, null, 2)}\n`);
}
