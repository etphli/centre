import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fileSnapshot } from '../server/connected-files.ts';
import { emptySnapshot } from '../server/store.ts';
import { resourceSchema } from '../shared/schema.ts';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtime = join(root, '.runtime', 'connectors-qa');
const temporary = await mkdtemp(join(tmpdir(), 'centre-connectors-qa-'));
await mkdir(runtime, { recursive: true }); await mkdir(join(temporary, 'data'), { recursive: true });
const state = emptySnapshot(); const now = new Date().toISOString();
const doc = { title: 'Biology revision notes', revisionId: 'qa-revision', body: { content: [{ paragraph: { elements: [{ textRun: { content: 'Cell structure\n\nAll living organisms are made of cells. The nucleus stores genetic information and controls the cell’s activities.\n\nThe cell membrane controls which substances enter and leave. Mitochondria release energy through aerobic respiration.\n\nRevision questions\n1. How does the structure of a cell membrane support its function?\n2. Why do muscle cells contain many mitochondria?' } }] } }] } };
const sheet = { properties: { title: 'Revision tracker' }, sheets: [{ properties: { title: 'This week' }, data: [{ rowData: [{ values: ['Subject', 'Topic', 'Confidence', 'Next review'].map(formattedValue => ({ formattedValue })) }, ...[['Biology', 'Cell structure', 'Confident', '23 October'], ['Mathematics', 'Quadratics', 'Needs practice', '22 October'], ['English', 'Essay structure', 'Improving', '24 October']].map(row => ({ values: row.map(formattedValue => ({ formattedValue })) }))] }] }] };
const slides = { title: 'Understanding cells', revisionId: 'qa-revision', slides: ['The building blocks of life\n\nCells are the smallest units that carry out the processes of life.', 'Inside an animal cell\n\nNucleus · Cell membrane · Cytoplasm · Mitochondria'].map((content, index) => ({ objectId: `slide-${index}`, pageElements: [{ shape: { text: { textElements: [{ textRun: { content } }] } } }] })) };
for (const [connector, id, data] of [['google-docs', 'qa-doc', doc], ['google-sheets', 'qa-sheet', sheet], ['google-slides', 'qa-slides', slides]]) state.resources.push(resourceSchema.parse({ id, kind: 'notes', subjectId: null, topicId: null, createdAt: now, updatedAt: now, ...fileSnapshot(connector, id, data) }));
state.settings.connectors = [{ id: 'google-docs', connected: true, canEdit: true, account: 'student@example.com', connectedAt: now }, { id: 'notion', connected: true, canEdit: false, account: 'Study workspace', connectedAt: now }];
await writeFile(join(temporary, 'data', 'state.json'), JSON.stringify(state));

function runner(config) {
  const { app, dialog } = require('electron'); const { writeFile } = require('node:fs/promises'); const assert = require('node:assert/strict');
  app.setPath('userData', config.userData);
  dialog.showErrorBox = (title, message) => { console.error(title, message); app.exit(1); };
  let window, finished = false; const errors = [], checks = [];
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const evaluate = code => window.webContents.executeJavaScript(code);
  const waitFor = async code => { for (let index = 0; index < 100; index++) { if (await evaluate(code)) return; await pause(100); } throw Error('Timed out: ' + code); };
  const click = (selector, text) => evaluate(`(()=>{const nodes=[...document.querySelectorAll(${JSON.stringify(selector)})];const node=${text ? `nodes.find(node=>node.textContent.includes(${JSON.stringify(text)}))` : 'nodes[0]'};if(!node)throw Error('Missing control');node.click();})()`);
  const type = (selector, text) => evaluate(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(Object.getPrototypeOf(node),'value').set.call(node,${JSON.stringify(text)});node.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const check = (name, value) => { assert.ok(value, name); checks.push(name); console.log('PASS ' + name); };
  const screenshot = async name => { await pause(350); await writeFile(config.runtime + '/' + name + '.png', (await window.webContents.capturePage()).toPNG()); };
  const finish = async error => { if (finished) return; finished = true; await writeFile(config.runtime + '/results.json', JSON.stringify({ passed: !error, checks, errors, error: error?.stack }, null, 2)); if (error) { console.error(error); app.exit(1); } else app.quit(); };
  app.on('browser-window-created', (_event, created) => {
    if (window) return; window = created; window.webContents.setBackgroundThrottling(false);
    window.webContents.on('console-message', (_event, ...args) => { if (args[0]?.level === 'error') errors.push(args[0].message); });
    window.webContents.once('did-finish-load', async () => {
      try {
        await waitFor("Boolean(document.querySelector('.home textarea') && window.centre)");
        check('Production desktop page loads with an isolated renderer', await evaluate("document.title==='Centre' && typeof require==='undefined'"));
        await click('button[aria-label="Settings"]'); await click('.settings-layout__nav button', 'Connections');
        await waitFor("document.querySelectorAll('.connection-item').length===15");
        check('Connections menu includes all 15 services and excludes Gmail', await evaluate("!document.querySelector('.connection-list').textContent.includes('Gmail') && document.querySelector('.connection-list').textContent.includes('Notion')"));
        await screenshot('connections');
        await type('input[aria-label="Search apps"]', 'sheets'); await waitFor("document.querySelectorAll('.connection-item').length===1");
        check('App search filters the menu', await evaluate("document.querySelector('.connection-item').textContent.includes('Google Sheets')"));
        await click('.connection-item'); await waitFor("Boolean(document.querySelector('.connection-detail'))");
        check('Service detail offers optional editing permission', await evaluate("document.querySelector('.connection-edit-option').textContent.includes('Allow Centre to edit')"));
        await click('.connection-back'); await type('input[aria-label="Search apps"]', ''); await click('.connections__filters button', 'Connected');
        await waitFor("document.querySelectorAll('.connection-item').length===2");
        check('Connected filter shows only connected services', true);
        await click('.connection-item', 'Notion'); check('Notion shows saved workspace without exposing its token', await evaluate("document.querySelector('.connection-detail').textContent.includes('Study workspace') && !document.querySelector('.connection-detail input[type=password]')"));
        await click('.settings-layout__nav button', 'Skills'); await waitFor("document.querySelectorAll('.skills-settings>div').length===29");
        check('Ten downloaded Claude skills appear in the offline catalog', await evaluate("[...document.querySelectorAll('.skills-settings .preference-note')].filter(node=>node.textContent==='Claude').length===10"));
        await screenshot('claude-skills');
        await click('.sidebar button', 'Resources'); await waitFor("document.querySelectorAll('.resource-card').length===3");
        await click('.resource-card__open', 'Biology revision'); await waitFor("Boolean(document.querySelector('.connected-document'))");
        check('Google document opens inside Centre with readable content', await evaluate("document.querySelector('.connected-document').textContent.includes('Mitochondria') && document.querySelector('.connected-file__source').textContent.includes('Google Docs')"));
        await screenshot('google-doc');
        await click('.sidebar button', 'Resources'); await click('.resource-card__open', 'Revision tracker'); await waitFor("Boolean(document.querySelector('.connected-sheet table'))");
        check('Google Sheet renders as an in-app grid', await evaluate("document.querySelectorAll('.connected-sheet tbody tr').length===4 && document.querySelector('.connected-sheet').textContent.includes('Quadratics')"));
        await screenshot('google-sheet');
        await click('.sidebar button', 'Resources'); await click('.resource-card__open', 'Understanding cells'); await waitFor("Boolean(document.querySelector('.connected-slide'))");
        await click('button[aria-label="Next slide"]'); check('Slide navigation updates the embedded presentation', await evaluate("document.querySelector('.connected-slide').textContent.includes('Inside an animal cell')"));
        await screenshot('google-slides');
        await click('button[aria-label="Settings"]'); await click('.settings-layout__nav button', 'Connections');
        window.setMinimumSize(700, 650); window.setSize(900, 800); await pause(250);
        check('Connection rows stay within the settings content at a narrow desktop width', await evaluate("[...document.querySelectorAll('.connection-item')].every(node=>node.getBoundingClientRect().right<=innerWidth)"));
        await screenshot('connections-narrow');
        check('Renderer has no runtime errors', errors.length === 0);
        await finish();
      } catch (error) { await screenshot('failure').catch(() => {}); await finish(error); }
    });
  });
  setTimeout(() => { void finish(Error('Verification exceeded 90 seconds.')); }, 90000).unref();
  require(config.main);
}
const entry = join(runtime, 'runner.cjs');
await writeFile(entry, '(' + runner.toString() + ')(' + JSON.stringify({ runtime, userData: join(temporary, 'user'), main: join(root, 'dist-electron/main.cjs') }) + ');\n');
const environment = { ...process.env, CENTRE_DATA_DIR: join(temporary, 'data'), CENTRE_CODEX_BIN: '/centre-test/no-codex', CENTRE_DISABLE_UPDATES: '1', CENTRE_RENDERER_URL: pathToFileURL(join(root, 'dist/index.html')).href }; delete environment.ELECTRON_RUN_AS_NODE;
try {
  const child = spawn(require('electron'), [entry], { cwd: root, env: environment, stdio: 'inherit' });
  process.exitCode = await new Promise((accept, reject) => { child.once('exit', code => accept(code ?? 1)); child.once('error', reject); });
} finally { await rm(temporary, { recursive: true, force: true }); }
