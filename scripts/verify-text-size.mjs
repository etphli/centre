import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const temporary = await mkdtemp(join(tmpdir(), 'centre-text-size-'));
await mkdir(join(temporary, 'data'));
const now = new Date().toISOString();
await writeFile(join(temporary, 'data/state.json'), JSON.stringify({
  subjects: [], topics: [], resources: [], events: [], memories: [], assignments: [],
  settings: {}, lastSyncedAt: null, codex: { available: false, authenticated: false, message: 'Text-size verification' },
  chats: [{ id: 'text-size-check', title: 'Text size check', createdAt: now, updatedAt: now, messages: [
    { id: 'user', role: 'user', content: 'Check readable text.', createdAt: now },
    { id: 'assistant', role: 'assistant', content: '## Sample heading\n\nReadable body text.\n\n| Column | Value |\n| --- | --- |\n| Sample | Text |\n\n```text\nSample code\n```', createdAt: now },
  ] }],
}));
await mkdir('.runtime', { recursive: true });
const entry = resolve('.runtime', `verify-text-size-${process.pid}.cjs`);

async function verify(config) {
  const { app } = require('electron');
  const assert = require('node:assert/strict');
  const { writeFile } = require('node:fs/promises');
  app.setPath('userData', config.userData);
  app.on('browser-window-created', (_event, window) => {
    window.webContents.once('did-finish-load', async () => {
      const evaluate = script => window.webContents.executeJavaScript(script);
      const waitFor = async expression => {
        for (let attempt = 0; attempt < 100; attempt++) {
          if (await evaluate(expression)) return;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        throw new Error(`Timed out: ${expression}`);
      };
      try {
        await waitFor("Boolean(document.querySelector('button[aria-label=\"Settings\"]'))");
        await evaluate("document.querySelector('button[aria-label=\"Settings\"]').click()");
        await waitFor("Boolean(document.querySelector('.settings-layout__nav'))");
        await evaluate("Array.from(document.querySelectorAll('.settings-layout__nav button')).find(button => button.textContent === 'Appearance').click()");
        await waitFor("Boolean(document.querySelector('[aria-label=\"Text size\"]'))");
        const sizes = {};
        for (const [value, label] of [['standard', 'Standard'], ['small', 'Small'], ['large', 'Large'], ['extra-large', 'Extra large'], ['standard', 'Standard']]) {
          await evaluate(`Array.from(document.querySelectorAll('[aria-label="Text size"] button')).find(button => button.textContent === ${JSON.stringify(label)}).click()`);
          await waitFor(`document.documentElement.dataset.textSize === ${JSON.stringify(value)}`);
          const result = await evaluate(`(async () => ({
            saved: (await window.centre.request('GET', '/state')).settings.textSize,
            title: parseFloat(getComputedStyle(document.querySelector('.preference-row__title')).fontSize),
            button: parseFloat(getComputedStyle(document.querySelector('[aria-label="Text size"] button')).fontSize),
            sidebar: parseFloat(getComputedStyle(document.querySelector('.nav-item')).fontSize)
          }))()`);
          assert.equal(result.saved, value);
          await evaluate("Array.from(document.querySelectorAll('.chat-nav__item')).find(button => button.textContent.includes('Text size check')).click()");
          await waitFor("Boolean(document.querySelector('.markdown pre code'))");
          Object.assign(result, await evaluate(`Object.fromEntries(Object.entries({
            message: '.message__bubble', body: '.markdown p', heading: '.markdown h2',
            table: '.markdown table', code: '.markdown pre code', composer: 'textarea[aria-label="Message Centre"]'
          }).map(([name, selector]) => [name, parseFloat(getComputedStyle(document.querySelector(selector)).fontSize)]))`));
          if (value === 'standard' && sizes.standard) assert.deepEqual(result, sizes.standard);
          sizes[value] = result;
          await writeFile(config.screenshotPrefix + value + '.png', (await window.webContents.capturePage()).toPNG());
          await evaluate("document.querySelector('button[aria-label=\"Settings\"]').click()");
          await waitFor("Boolean(document.querySelector('.settings-layout__nav'))");
        await evaluate("Array.from(document.querySelectorAll('.settings-layout__nav button')).find(button => button.textContent === 'Appearance').click()");
        await waitFor("Boolean(document.querySelector('[aria-label=\"Text size\"]'))");
        }
        for (const target of ['title', 'button', 'sidebar', 'message', 'body', 'heading', 'table', 'code', 'composer']) {
          assert.ok(sizes.small[target] < sizes.standard[target], `Small must shrink ${target}: ${JSON.stringify(sizes)}`);
          assert.ok(sizes['extra-large'][target] > sizes.large[target], `Extra large must enlarge ${target}`);
          assert.ok(sizes.large[target] > sizes.standard[target], `Large must enlarge ${target}: ${JSON.stringify(sizes)}`);
        }
        await evaluate("Array.from(document.querySelectorAll('[aria-label=\"Text size\"] button')).find(button => button.textContent === 'Large').click()");
        await waitFor("document.documentElement.dataset.textSize === 'large'");
        const reloaded = new Promise(resolve => window.webContents.once('did-finish-load', resolve));
        window.webContents.reload();
        await reloaded;
        await waitFor("Boolean(document.querySelector('h1')) && document.documentElement.dataset.textSize === 'large'");
        assert.equal(await evaluate("window.centre.request('GET','/state').then(state => state.settings.textSize)"), 'large');
        console.log(JSON.stringify({ passed: true, sizes, reload: 'large' }));
        app.quit();
      } catch (error) { console.error(error); app.exit(1); }
    });
  });
  setTimeout(() => { console.error('Text-size verification timed out'); app.exit(1); }, 45000).unref();
  require(config.main);
}

await writeFile(entry, `(${verify.toString()})(${JSON.stringify({
  userData: join(temporary, 'runtime'), main: resolve('dist-electron/main.cjs'),
  screenshotPrefix: resolve('.runtime/text-size-'),
})});`);
const env = { ...process.env, CENTRE_DATA_DIR: join(temporary, 'data'), CENTRE_RENDERER_URL: pathToFileURL(resolve('dist/index.html')).href };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require('electron'), [entry], { env, stdio: 'inherit' });
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('exit', async code => { await rm(entry, { force: true }); await rm(temporary, { recursive: true, force: true }); process.exitCode = code ?? 1; });
