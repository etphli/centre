import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AttachmentStore } from '../server/attachments.ts';
import { emptySnapshot } from '../server/store.ts';
import { resourceSchema, chatSchema } from '../shared/schema.ts';
import { fileSnapshot } from '../server/connected-files.ts';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtime = join(root, '.runtime', 'search-ui');
const temporary = await mkdtemp(join(tmpdir(), 'centre-search-ui-'));
const data = join(temporary, 'data');
await mkdir(runtime, { recursive: true });
await mkdir(data, { recursive: true });
const now = new Date().toISOString();
const fixture = emptySnapshot();
fixture.subjects = [{ id: 'biology', name: 'Synthetic Biology', shortName: 'Biology', color: '#8ea6e8', icon: 'book' }];
fixture.topics = [{ id: 'cells', subjectId: 'biology', name: 'Cell processes', description: 'Search verification fixture.' }];
const resource = (id, fields) => resourceSchema.parse({ id, subjectId: 'biology', topicId: 'cells', title: 'Search fixture', kind: 'notes', createdAt: now, updatedAt: now, content: '', ...fields });
fixture.resources = [
  resource('notes', { title: 'Cell energy notes', content: 'Electron transport describes the process at the inner mitochondrial membrane. This phrase appears only in the body, so you can find it without knowing the title.' }),
  resource('quiz', { title: 'Cell processes quiz', kind: 'quiz', questions: [
    { id: 'q1', prompt: 'Name the basic unit of life.', answer: 'The cell.' },
    { id: 'q2', prompt: 'Explain electron transport in a mitochondrion.', answer: 'Electrons pass along membrane proteins.', explanation: 'Osmotic pressure is a phrase present only in this explanation.' },
    { id: 'q3', prompt: 'What is a ribosome?', answer: 'A structure that makes proteins.' },
  ] }),
  resource('cards', { title: 'Inheritance flashcards', kind: 'flashcards', questions: [{ id: 'card1', prompt: 'Maternal inheritance', answer: 'Mitochondrial inheritance follows the maternal line.' }, { id: 'card2', prompt: 'A gene variant', answer: 'An allele.' }] }),
  resource('connected', fileSnapshot('google-docs', 'synthetic-file', { title: 'Field journal', body: { content: [{ paragraph: { elements: [{ textRun: { content: 'Electron transport was recorded in this saved connected file.\n' } }] } }] } })),
];
function pdfWithText(text) {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  return Buffer.from(pdf + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
}
const attachments = new AttachmentStore(data);
const pdf = await attachments.upload({ name: 'Cell worksheet.pdf', mimeType: 'application/pdf', data: pdfWithText('Electron transport was extracted from this worksheet.').toString('base64') });
const docx = await attachments.upload({ name: 'Class reading.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', data: (await readFile(join(root, 'node_modules/mammoth/test/test-data/single-paragraph.docx'))).toString('base64') });
fixture.chats = [chatSchema.parse({ id: 'revision', title: 'Biology revision', createdAt: now, updatedAt: now, messages: Array.from({ length: 32 }, (_, index) => ({ id: `message-${index}`, role: index % 2 ? 'assistant' : 'user', content: index === 10 ? 'Review my worksheets and explain the diagrams.' : `Synthetic discussion ${index + 1}. ${'We are reviewing cell structure and revisiting the study plan. '.repeat(5)}`, createdAt: now, attachmentIds: index === 10 ? [pdf.id, docx.id] : [] })) })];
fixture.settings.theme = 'dark';
fixture.settings.nickname = 'Search QA';
await writeFile(join(data, 'state.json'), JSON.stringify(fixture));

function runner(config) {
  const { app, dialog } = require('electron');
  const { writeFile } = require('node:fs/promises');
  const assert = require('node:assert/strict');
  app.setPath('userData', config.userData);
  dialog.showErrorBox = (title, message) => { console.error(`${title}: ${message}`); app.exit(1); };
  const checks = [], screenshots = {}, errors = [];
  let window, finished = false;
  const pause = ms => new Promise(accept => setTimeout(accept, ms));
  const evaluate = expression => window.webContents.executeJavaScript(expression);
  const check = (name, condition, details) => { checks.push({ name, passed: Boolean(condition), details }); assert.ok(condition, `${name}: ${JSON.stringify(details)}`); console.log(`PASS ${name}`); };
  async function wait(expression) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) { if (await evaluate(expression)) return; await pause(75); }
    throw new Error(`Timed out waiting for ${expression}`);
  }
  async function screenshot(name) {
    window.show(); window.focus(); window.webContents.invalidate();
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    await pause(400);
    const path = `${config.runtime}/${name}.png`;
    await writeFile(path, (await window.webContents.capturePage(undefined, { stayAwake: true })).toPNG());
    screenshots[name] = path;
  }
  async function click(selector) { await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`); }
  async function query(text) {
    if (!await evaluate("Boolean(document.querySelector('.palette[open]'))")) await click('.sidebar__search');
    await wait("Boolean(document.querySelector('.palette input'))");
    await evaluate(`(()=>{const input=document.querySelector('.palette input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(text)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await wait("document.querySelector('.palette__list')?.getAttribute('aria-busy') === 'false'");
  }
  async function finish(error) {
    if (finished) return;
    finished = true;
    await writeFile(`${config.runtime}/report.json`, JSON.stringify({ passed: !error, checks, screenshots, errors, ...(error ? { error: String(error.stack ?? error) } : {}) }, null, 2));
    if (error) { console.error(error); app.exit(1); } else app.quit();
  }
  app.on('browser-window-created', (_event, created) => {
    window = created;
    window.setSize(1280, 800);
    window.webContents.setBackgroundThrottling(false);
    window.webContents.on('console-message', (_event, details) => { if (details?.level === 'error') errors.push(details.message); });
    window.webContents.once('did-finish-load', async () => {
      try {
        window.show(); window.focus();
        await wait("Boolean(window.centre && document.querySelector('.home__shortcuts'))");
        check('Production renderer uses private desktop IPC', await evaluate("typeof window.centre.request === 'function' && typeof require === 'undefined'"));
        await query('electron transport');
        await wait("document.querySelectorAll('.palette__item--match').length === 4");
        const sources = await evaluate("[...document.querySelectorAll('.palette__source')].map(item=>item.textContent)");
        check('Body, prompt, saved connected file and extracted PDF appear together', ['Notes content', 'Quiz prompt', 'Saved Google Docs', 'PDF attachment'].every(source => sources.includes(source)), sources);
        check('Matched terms are highlighted', await evaluate("[...document.querySelectorAll('.palette__item--match')].every(row=>[...row.querySelectorAll('mark')].some(mark=>/electron\\s+transport/i.test(mark.textContent)))"));
        const first = await evaluate("document.querySelector('.palette__item[aria-selected=true]')?.textContent");
        window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Down' }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Down' });
        await pause(80);
        check('Keyboard moves selection and active descendant', await evaluate(`document.querySelector('.palette__item[aria-selected=true]')?.textContent !== ${JSON.stringify(first)} && document.querySelector('.palette input').getAttribute('aria-activedescendant') === document.querySelector('.palette__item[aria-selected=true]').id`));
        await screenshot('search-results-dark');
        await evaluate("[...document.querySelectorAll('.palette__item')].find(item=>item.textContent.includes('Cell energy notes')).click()");
        await wait("document.querySelector('.notes')?.textContent.includes('Electron transport') === true");
        check('Body result opens its actual resource', await evaluate("document.querySelector('.page__title')?.textContent === 'Cell energy notes' && document.querySelector('.notes').textContent.includes('Electron transport')"));
        await query('osmotic pressure');
        await wait("document.querySelector('.palette__source')?.textContent === 'Quiz explanation'");
        window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
        await wait("Boolean(document.getElementById('resource-question-q2'))");
        check('Explanation result opens question two', await evaluate("document.querySelector('.quiz__count').textContent.includes('Question 2 of 3')"));
        await wait("document.getElementById('resource-question-q2').classList.contains('search-target')");
        check('Question target is visibly marked', await evaluate("document.getElementById('resource-question-q2').classList.contains('search-target')"));
        await screenshot('search-question-target');
        await evaluate("[...document.querySelectorAll('.quiz__nav button')].find(button=>button.textContent.trim()==='Next').click()");
        await wait("Boolean(document.getElementById('resource-question-q3'))");
        await query('osmotic pressure');
        await wait("document.querySelector('.palette__source')?.textContent === 'Quiz explanation'");
        await evaluate("document.querySelector('.palette__item--match').click()");
        await wait("document.getElementById('resource-question-q2')?.classList.contains('search-target')");
        check('Repeat question hit returns from another question', true);
        await query('maternal');
        await wait("Boolean(document.querySelector('.palette__item--match'))");
        await evaluate("document.querySelector('.palette__item--match').click()");
        await wait("document.getElementById('resource-question-card1')?.classList.contains('search-target')");
        await click('.flashcard');
        await click('[aria-label="Next card"]');
        await wait("Boolean(document.getElementById('resource-question-card2'))");
        await query('maternal');
        await wait("Boolean(document.querySelector('.palette__item--match'))");
        await evaluate("document.querySelector('.palette__item--match').click()");
        await wait("document.getElementById('resource-question-card1')?.classList.contains('search-target')");
        check('Repeat flashcard hit resets card and answer side', await evaluate("!document.querySelector('.flashcard').classList.contains('is-flipped')"));
        await query('electron transport');
        await wait("Boolean([...document.querySelectorAll('.palette__source')].find(item=>item.textContent==='PDF attachment'))");
        await evaluate("[...document.querySelectorAll('.palette__item')].find(item=>item.textContent.includes('PDF attachment')).click()");
        await wait("Boolean(document.getElementById('chat-message-message-10'))");
        await wait("[...document.querySelectorAll('.message-file')].some(item=>item.textContent.includes('Cell worksheet.pdf'))");
        await pause(200);
        const target = await evaluate("(()=>{const r=document.getElementById('chat-message-message-10').getBoundingClientRect();const file=[...document.querySelectorAll('.message-file')].find(item=>item.textContent.includes('Cell worksheet.pdf')).getBoundingClientRect();return {top:r.top,bottom:r.bottom,visible:r.top>=48&&r.bottom<innerHeight-100&&file.top>=48&&file.bottom<innerHeight-100,attachments:document.querySelectorAll('.message-file').length}})()");
        check('Attachment result anchors its owning message in a long chat', target.visible, target);
        await wait("document.getElementById('chat-message-message-10').classList.contains('search-target')");
        check('Message destination is visibly marked', await evaluate("document.getElementById('chat-message-message-10').classList.contains('search-target')"));
        await screenshot('search-attachment-target');
        window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
        await wait("!document.querySelector('.search-target')");
        check('Destination marker clears on next interaction', true);
        await evaluate("document.querySelector('.main__content').scrollTo({top:0})");
        await query('electron transport');
        await wait("Boolean([...document.querySelectorAll('.palette__source')].find(item=>item.textContent==='PDF attachment'))");
        await evaluate("[...document.querySelectorAll('.palette__item')].find(item=>item.textContent.includes('PDF attachment')).click()");
        await wait("document.getElementById('chat-message-message-10').classList.contains('search-target')");
        check('Reopening the same hit marks and scrolls it again', await evaluate("document.getElementById('chat-message-message-10').getBoundingClientRect().top > 48"));
        await query('Walking on imported air');
        await wait("document.querySelector('.palette__source')?.textContent === 'DOCX attachment'");
        check('DOCX sidecar has a clear attachment label', await evaluate("document.querySelector('.palette__label').textContent === 'Class reading.docx'"));
        await screenshot('search-docx');
        await query('no-result-unique');
        await wait("document.querySelector('.palette__empty')?.textContent.includes('Nothing matches')");
        await screenshot('search-empty');
        await evaluate("document.querySelector('.palette').dispatchEvent(new Event('cancel',{cancelable:true}))");
        await evaluate("window.centre.request('PATCH','/settings',{theme:'light'})");
        await pause(4500);
        await query('electron transport');
        await wait("document.querySelectorAll('.palette__item--match').length === 4");
        await screenshot('search-results-light');
        check('No renderer console errors', errors.length === 0, errors);
        await finish();
      } catch (error) { await screenshot('failure').catch(()=>undefined); await finish(error); }
    });
  });
  setTimeout(() => { void finish(new Error('Search UI verification timed out.')); }, 120000).unref();
  require(config.main);
}
const entry = join(runtime, 'runner.cjs');
await writeFile(entry, `(${runner.toString()})(${JSON.stringify({ runtime, userData: join(temporary, 'user'), main: join(root, 'dist-electron/main.cjs') })});\n`);
const environment = { ...process.env, CENTRE_DATA_DIR: data, CENTRE_CODEX_BIN: join(temporary, 'missing-codex'), CENTRE_DISABLE_UPDATES: '1', CENTRE_RENDERER_URL: pathToFileURL(join(root, 'dist/index.html')).href };
delete environment.ELECTRON_RUN_AS_NODE;
try {
  const child = spawn(require('electron'), [entry], { cwd: root, env: environment, stdio: 'inherit' });
  const timer = setTimeout(() => child.kill('SIGTERM'), 130000);
  process.exitCode = await new Promise((accept, reject) => { child.once('exit', code => accept(code ?? 1)); child.once('error', reject); });
  clearTimeout(timer);
} finally { await rm(temporary, { recursive: true, force: true }); }
