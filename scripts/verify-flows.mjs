import { spawn,spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtime = join(root, '.runtime');
const dataRoot = await mkdtemp(join(tmpdir(), 'centre-ui-flows-'));
const dataDirectory = join(dataRoot, 'data');
const userDataDirectory = join(dataRoot, 'user-data');
const entry = join(runtime, `verify-flows-${process.pid}.cjs`);
const reportPath = join(runtime, 'qa-results.json');
const screenshotPaths = Object.fromEntries(['home', 'test-setup', 'models', 'models-menu', 'models-compact', 'settings-light', 'quiz', 'side-chat', 'diagram-dark', 'diagram-light', 'paper-cover', 'review-empty'].map(name => [name, join(runtime, `qa-${name}.png`)]));

const builtFiles = [join(root, 'dist', 'index.html'), join(root, 'dist-electron', 'main.cjs')];
for (const file of builtFiles) {
  try { await readFile(file); }
  catch { throw new Error(`Missing ${file}. Build the production renderer and Electron main process before running this verifier.`); }
}

await mkdir(dataDirectory, { recursive: true });
await mkdir(userDataDirectory, { recursive: true });
await mkdir(runtime, { recursive: true });

const now = new Date().toISOString();
const fixture = {
  subjects: [{ id: 'qa-maths', name: 'Synthetic Mathematics', shortName: 'Maths', color: '#6f83b6', icon: 'book' }],
  topics: [{ id: 'qa-linear-equations', subjectId: 'qa-maths', name: 'Linear equations', description: 'Synthetic UI verification topic.' }],
  resources: [{
    id: 'qa-mixed-quiz', subjectId: 'qa-maths', topicId: 'qa-linear-equations', title: 'Synthetic mixed quiz', kind: 'quiz',
    createdAt: now, updatedAt: now, content: '', questionTypes: ['multiple_choice', 'short_response', 'long_response'], durationMinutes: null, completedAt: null,
    questions: [
      { id: 'qa-q1', responseType: 'multiple_choice', choices: ['x = 7', 'x = 9', 'x = 16'], prompt: 'Solve x + 7 = 16.', answer: 'x = 9', explanation: 'Subtract 7 from both sides.', marks: 1 },
      { id: 'qa-q2', responseType: 'short_response', choices: [], prompt: 'Solve x − 5 = 8.', answer: 'x = 13', explanation: 'Add 5 to both sides.', marks: 2 },
      { id: 'qa-q3', responseType: 'long_response', choices: [], prompt: 'Explain how to solve 3x + 2 = 17 and check the answer.', answer: 'Subtract 2, divide by 3, then substitute x = 5.', explanation: 'Both inverse operations must be applied to each side.', marks: 3 },
    ],
  }],
  chats: [], chatFolders: [], events: [], memories: [], assignments: [], attempts: [],
  settings: {
    nickname: 'QA', theme: 'dark', defaultQuizQuestions: 3, defaultTestMinutes: 45,
    defaultQuizQuestionTypes: ['multiple_choice', 'short_response', 'long_response'],
    defaultTestQuestionTypes: ['multiple_choice', 'short_response', 'long_response'],
  },
  codex: { available: false, authenticated: false, message: 'UI verification fixture.' },
  lastSyncedAt: null, syncError: null,
};
fixture.topics.push({id:'qa-pythagoras',subjectId:'qa-maths',name:'Pythagoras',description:''});
fixture.resources.push({...fixture.resources[0],id:'qa-paper',title:'Synthetic paper',kind:'test',durationMinutes:45,testLength:{mode:'time',minutes:45},content:'Legacy template'});
fixture.resources.push({...fixture.resources[0],id:'qa-diagram',title:'Synthetic diagram',kind:'diagram',questions:[],content:`<style>body{background:white;color:#17324d}.panel{background:#fff;padding:24px}main{padding:12px}</style><h1>Minimal checklist</h1><main><section class="panel"><h2>Right triangles</h2><p>A diagram in your theme.</p><button id="explore" onclick="this.textContent='Explored'">Explore</button><svg viewBox="0 0 200 100"><path d="M10 10L10 90L190 90Z" fill="#e6a23c"/><text x="50" y="70" fill="#17324d">a² + b² = c²</text></svg></section></main><label><input type="checkbox" id="last-checklist-item" data-centre-checklist-id="last-checklist-item">Final checklist item</label>`});
await writeFile(join(dataDirectory, 'state.json'), JSON.stringify(fixture, null, 2));

const entrySource = `
const { app, BrowserWindow, shell,dialog } = require('electron');
dialog.showErrorBox=(title,message)=>{console.error(title+': '+message);app.exit(1);};
const openedPaths=[];shell.openPath=async path=>{openedPaths.push(path);return '';};
const { readFile, writeFile } = require('node:fs/promises');
const assert = require('node:assert/strict');
app.setPath('userData', ${JSON.stringify(userDataDirectory)});
const reportPath = ${JSON.stringify(reportPath)};
const screenshots = ${JSON.stringify(screenshotPaths)};
const checks = [];
const consoleErrors = [];
let finished = false;
let window;

function check(name, condition, details) {
  checks.push({ name, passed: Boolean(condition), ...(details === undefined ? {} : { details }) });
  console.log((condition?'PASS ':'FAIL ')+name);
  assert.ok(condition, name + (details ? ': ' + (typeof details === 'string' ? details : JSON.stringify(details)) : ''));
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const evaluate = script => window.webContents.executeJavaScript(script);
async function waitFor(expression, label, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await evaluate('(async()=>Boolean(await (' + expression + ')))()')) return;
    await pause(100);
  }
  throw new Error('Timed out waiting for ' + label);
}
async function clickSelector(selector, label) {
  const safe = JSON.stringify(selector);
  await evaluate('(()=>{const element=document.querySelector(' + safe + ');if(!element)throw new Error(' + JSON.stringify('Missing ' + label) + ');element.click();return true})()');
}
async function clickByText(selector, text, label) {
  const safeSelector = JSON.stringify(selector);
  const safeText = JSON.stringify(text);
  await evaluate('(()=>{const element=[...document.querySelectorAll(' + safeSelector + ')].find(item=>item.textContent.trim().includes(' + safeText + '));if(!element)throw new Error(' + JSON.stringify('Missing ' + label) + ');if(element.getAttribute("role")==="option")element.dispatchEvent(new MouseEvent("mousedown",{bubbles:true,cancelable:true}));else element.click();return true})()');
}
async function clickByAriaPrefix(selector, prefix, label) {
  const safeSelector = JSON.stringify(selector);
  const safePrefix = JSON.stringify(prefix);
  await evaluate('(()=>{const element=[...document.querySelectorAll(' + safeSelector + ')].find(item=>(item.getAttribute("aria-label")||"").startsWith(' + safePrefix + '));if(!element)throw new Error(' + JSON.stringify('Missing ' + label) + ');element.click();return true})()');
}
async function setValue(selector, value, label) {
  const safe = JSON.stringify(selector);
  const encodedValue = JSON.stringify(value);
  await evaluate('(()=>{const element=document.querySelector(' + safe + ');if(!element)throw new Error(' + JSON.stringify('Missing ' + label) + ');const descriptor=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element),"value");descriptor.set.call(element,' + encodedValue + ');element.dispatchEvent(new Event("input",{bubbles:true}));element.dispatchEvent(new Event("change",{bubbles:true}));return true})()');
}
async function screenshot(name) {
  await evaluate('new Promise(resolve=>{requestAnimationFrame(()=>requestAnimationFrame(resolve));setTimeout(resolve,300)})');
  await pause(250);
  await writeFile(screenshots[name], (await window.webContents.capturePage()).toPNG());
}
async function state() { return evaluate("window.centre.request('GET','/state')"); }
function finish(error) {
  if (finished) return;
  finished = true;
  const report = { passed: !error, checks, screenshots, consoleErrors, ...(error ? { error: String(error.stack || error) } : {}) };
  writeFile(reportPath, JSON.stringify(report)).then(() => {
    console.log(JSON.stringify(report));
    if (error) app.exit(1); else app.quit();
  }).catch(writeError => { console.error(writeError); app.exit(1); });
}

app.on('browser-window-created', (_event, createdWindow) => {
  window = createdWindow;
  window.webContents.setBackgroundThrottling(false);
  window.webContents.on('console-message', (_event, ...args) => {
    const details = args[0];
    const level = details && typeof details === 'object' ? details.level : details;
    const message = details && typeof details === 'object' ? details.message : args[1];
    if (level === 'error' || level === 3 || level >= 3) consoleErrors.push(String(message));
  });
  window.webContents.on('render-process-gone', (_event, details) => consoleErrors.push('Renderer process exited: ' + JSON.stringify(details)));
  window.webContents.on('did-fail-load', (_event, code, description, url) => consoleErrors.push('Page load failed (' + code + '): ' + description + ' ' + url));
  window.webContents.once('did-finish-load', async () => {
    try {
      await waitFor("document.querySelector('.home__shortcuts') && window.centre", 'home and desktop IPC');
      check('Production renderer uses the desktop preload', await evaluate("document.title === 'Centre' && typeof require === 'undefined' && typeof window.centre.request === 'function'"));
      const initial = await state();
      check('Isolated fixture loaded through desktop IPC', initial.subjects.some(item => item.id === 'qa-maths') && initial.resources.some(item => item.id === 'qa-mixed-quiz'));
      await screenshot('home');

      await clickByText('.home__shortcuts button', 'Diagram', 'home diagram shortcut');
      await waitFor("document.querySelector('.home textarea')?.value.startsWith('/diagram')", 'diagram shortcut to prefill the composer');
      check('Diagram shortcut prefills /diagram without opening a dialog', await evaluate("document.querySelector('.home textarea').value.startsWith('/diagram') && !document.querySelector('dialog[open]')"));
      await setValue('.home textarea', '/diagram', 'home composer');
      check('Bare /diagram remains a composer command', await evaluate("document.querySelector('.home textarea').value === '/diagram' && !document.querySelector('dialog[open]')"));
      await screenshot('home');
      await setValue('.home textarea', '', 'home composer');

      await clickByText('.home__shortcuts button', 'Test', 'test shortcut');
      await waitFor("document.querySelector('dialog[open] .gen__assessment')", 'test setup dialog');
      const testSetup = await evaluate("(()=>({title:document.querySelector('dialog[open] .dialog__title')?.textContent.trim(),duration:document.querySelector('dialog[open] input[aria-label=\\\"Test duration in minutes\\\"]')?.value,quizCount:document.querySelector('dialog[open] input[aria-label=\\\"Quiz questions\\\"]'),types:[...document.querySelectorAll('dialog[open] .question-types button')].map(button=>({label:button.textContent.trim(),pressed:button.getAttribute('aria-pressed')}))}))()");
      check('Test setup defaults to 45 minutes with question types and no question-count field', testSetup.title === 'New test' && testSetup.duration === '45' && testSetup.quizCount === null && testSetup.types.length === 3, testSetup);
      await screenshot('test-setup');
      await clickByText('.gen__test-mode button','Questions','test question count mode');
      check('Tests can switch to exact count before creation',await evaluate("document.querySelector('input[aria-label=\\\"Test questions\\\"]')?.value==='10' && !document.querySelector('input[aria-label=\\\"Test duration in minutes\\\"]')"));
      await clickByText('.gen__test-mode button','Time','restore timed test mode');
      check('Timed test remains the personal default',await evaluate("document.querySelector('input[aria-label=\\\"Test duration in minutes\\\"]')?.value==='45'"));


      await clickSelector('dialog[open] button[role="combobox"][aria-label="Subject"]', 'test subject picker');
      await waitFor("document.querySelector('[role=listbox][aria-label=\\\"Subject\\\"]')", 'subject listbox');
      await evaluate("(()=>{const button=document.querySelector('dialog[open] button[role=combobox][aria-label=\\\"Subject\\\"]');button.focus();button.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));return true})()");
      await waitFor("!document.querySelector('[role=listbox][aria-label=\\\"Subject\\\"]')", 'subject listbox Escape handling');
      check('Escape closes the custom subject listbox and keeps its setup dialog open', await evaluate("Boolean(document.querySelector('dialog[open]')) && !document.querySelector('[role=listbox][aria-label=\\\"Subject\\\"]')"));
      const toggle = await evaluate("(()=>{const button=[...document.querySelectorAll('dialog[open] .question-types button')].find(item=>item.textContent.includes('Multiple choice'));if(!button)throw new Error('Missing question-type toggle');return {before:button.getAttribute('aria-pressed')}})()");
      await clickByText('dialog[open] .question-types button', 'Multiple choice', 'multiple-choice type toggle');
      const toggled = await evaluate("[...document.querySelectorAll('dialog[open] .question-types button')].find(item=>item.textContent.includes('Multiple choice'))?.getAttribute('aria-pressed')");
      check('Test question-type toggle changes its selected state', toggled !== toggle.before, { before: toggle.before, after: toggled });
      await clickByText('dialog[open] .question-types button', 'Multiple choice', 'multiple-choice type toggle restore');
      await clickByText('dialog[open] button', 'Cancel', 'cancel test setup');
      await waitFor("!document.querySelector('dialog[open]')", 'test setup dialog to close');

      await clickByText('.home__shortcuts button', 'Quiz', 'quiz shortcut');
      await waitFor("document.querySelector('dialog[open] input[aria-label=\\\"Quiz questions\\\"]')", 'quiz setup dialog');
      const quizSetup = await evaluate("(()=>({count:document.querySelector('dialog[open] input[aria-label=\\\"Quiz questions\\\"]')?.value,types:document.querySelectorAll('dialog[open] .question-types button').length}))()");
      check('Quiz setup uses the configured question count and exposes type toggles', quizSetup.count === '3' && quizSetup.types === 3, quizSetup);
      await clickByText('dialog[open] button', 'Cancel', 'cancel quiz setup');
      await waitFor("!document.querySelector('dialog[open]')", 'quiz setup dialog to close');

      await clickSelector('button[aria-label="Settings"]', 'Settings navigation button');
      await waitFor("document.querySelector('.settings-layout__nav')", 'Settings page');
      const darkMuted = await evaluate("getComputedStyle(document.documentElement).getPropertyValue('--text-3').trim()");
      await clickByText('.settings-layout__content .theme-option', 'Light', 'Light theme option');
      await waitFor("document.documentElement.dataset.theme === 'light'", 'Light theme');
      const lightTheme = await evaluate("(async()=>({theme:document.documentElement.dataset.theme,muted:getComputedStyle(document.documentElement).getPropertyValue('--text-3').trim(),bg:getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),sidebar:getComputedStyle(document.documentElement).getPropertyValue('--sidebar').trim(),saved:(await window.centre.request('GET','/state')).settings.theme}))()");
      const lightSaved = lightTheme.saved;
      check('Light theme applies its palette and persists through IPC', lightTheme.theme === 'light' && lightTheme.muted !== darkMuted && lightSaved === 'light', { theme: lightTheme.theme, muted: lightTheme.muted, darkMuted, saved: lightSaved });
      check('Light palette matches Claude live bg-100, bg-200 and text-400 tokens',lightTheme.bg==='#f9f9f7' && lightTheme.sidebar==='#f3f3f0' && lightTheme.muted==='#7b7974',lightTheme);
      await screenshot('settings-light');
      await clickByText('.settings-layout__content .theme-option', 'Dark', 'Dark theme option');
      await waitFor("document.documentElement.dataset.theme === 'dark'", 'Dark theme reset');
      const darkAgain = await evaluate("({theme:document.documentElement.dataset.theme,muted:getComputedStyle(document.documentElement).getPropertyValue('--text-3').trim()})");
      check('Default dark theme can be restored', darkAgain.theme === 'dark' && darkAgain.muted === darkMuted, darkAgain);

      await clickByText('.settings-layout__nav button', 'Models', 'Models settings category');
      await waitFor("document.querySelector('button[aria-label=\\\"Choose model\\\"]') && document.querySelector('button[aria-label=\\\"Choose marking model\\\"]')", 'chat and marking model controls');
      check('Models settings has one editable picker per purpose and no duplicate below Codex sign-in', await evaluate("document.querySelectorAll('.settings-layout .model-picker').length === 2 && !document.querySelector('section[aria-labelledby=\\\"settings-codex\\\"] .model-picker, section[aria-labelledby=\\\"settings-codex\\\"] .facts')"));
      await clickSelector('button[aria-label="Choose model"]', 'chat model menu');
      await waitFor("document.querySelector('.model-picker__panel [role=menu]')", 'model catalog menu');
      await waitFor("!document.querySelector('.model-picker__error') && document.querySelectorAll('.model-picker__models [role=menuitemradio]').length >= 3", 'loaded model catalog', 20000);
      const modelMenu = await evaluate("(()=>{const panel=document.querySelector('.model-picker__panel');const names=[...panel.querySelectorAll('[role=menuitemradio]')].map(item=>item.textContent.trim());const slider=panel.querySelector('input[type=range]');const style=slider?getComputedStyle(slider):null;return {names,stops:[...panel.querySelectorAll('.model-picker__stops button')].map(item=>item.textContent.trim()),sliderStyle:slider?.getAttribute('style'),sliderHeight:style?.height,sliderPadding:style?.padding,sliderBackgroundSize:style?.backgroundSize,sliderBackgroundRepeat:style?.backgroundRepeat,ariaLabel:slider?.getAttribute('aria-label')}})()");
      const modelFamilies = modelMenu.names.map(name => name.toLowerCase());
      check('Model menu shows latest Sol, Luna, and Astra choices without Terra', modelMenu.names.length === 3 && modelFamilies.some(name => name.includes('sol')) && modelFamilies.some(name => name.includes('luna')) && modelFamilies.some(name => name.includes('astra')) && !modelFamilies.some(name => name.includes('terra')), modelMenu.names);
      check('Reasoning menu omits max and ultra and uses the blue custom range', modelMenu.stops.length > 0 && modelMenu.stops.every(value => !/^(max|ultra)$/i.test(value)) && /142,\s*166,\s*232|#8ea6e8/i.test(modelMenu.sliderStyle ?? '') && modelMenu.ariaLabel === 'Reasoning effort', modelMenu);
      check('Reasoning slider stays compact and draws a thin full-width blue track', Number.parseFloat(modelMenu.sliderHeight) <= 22 && modelMenu.sliderPadding === '0px' && modelMenu.sliderBackgroundSize === '100% 3px' && modelMenu.sliderBackgroundRepeat === 'no-repeat', { height: modelMenu.sliderHeight, padding: modelMenu.sliderPadding, backgroundSize: modelMenu.sliderBackgroundSize, backgroundRepeat: modelMenu.sliderBackgroundRepeat });
      await screenshot('models-menu');
      const desktopSize = window.getSize();
      window.setSize(1000, 800);
      await pause(250);
      check('Model menu stays inside the compact desktop viewport', await evaluate("(()=>{const panel=document.querySelector('.model-picker__panel').getBoundingClientRect();const slider=document.querySelector('.model-picker__panel input[type=range]').getBoundingClientRect();return panel.left>=0 && panel.right<=innerWidth && panel.bottom<=innerHeight && slider.width>150 && slider.height<=22})()"));
      await screenshot('models-compact');
      window.setSize(...desktopSize);
      await pause(250);
      await clickSelector('button[aria-label="Choose model"]', 'close chat model menu');

      await clickSelector('button[aria-label="Choose model"]', 'default chat model menu');
      await waitFor("document.querySelector('.model-picker__stops button')", 'default reasoning choices');
      await clickByText('.model-picker__stops button', 'High', 'default reasoning choice');
      await waitFor("window.centre.request('GET','/state').then(value=>value.settings.reasoningEffort === 'high')", 'default reasoning saved');
      const defaultSelection = await state();
      check('Default chat reasoning saves to settings', defaultSelection.settings.reasoningEffort === 'high', { saved: defaultSelection.settings.reasoningEffort });
      await evaluate("document.querySelector('.model-picker__panel input[type=range]').focus()");
      window.webContents.sendInputEvent({type:'keyDown',keyCode:'Home'});
      window.webContents.sendInputEvent({type:'keyUp',keyCode:'Home'});
      await waitFor("window.centre.request('GET','/state').then(value=>value.settings.reasoningEffort === 'low')", 'keyboard reasoning saved');
      check('Keyboard slider changes persist the default reasoning', (await state()).settings.reasoningEffort === 'low');
      const sliderBounds = await evaluate("(()=>{const box=document.querySelector('.model-picker__panel input[type=range]').getBoundingClientRect();return {left:Math.round(box.left+6),right:Math.round(box.right-6),y:Math.round(box.y+box.height/2)}})()");
      window.webContents.sendInputEvent({type:'mouseDown',x:sliderBounds.left,y:sliderBounds.y,button:'left',clickCount:1});
      window.webContents.sendInputEvent({type:'mouseMove',x:sliderBounds.right,y:sliderBounds.y,button:'left'});
      window.webContents.sendInputEvent({type:'mouseUp',x:sliderBounds.right,y:sliderBounds.y,button:'left',clickCount:1});
      await waitFor("window.centre.request('GET','/state').then(value=>value.settings.reasoningEffort === 'xhigh')", 'dragged reasoning saved');
      check('Dragging the slider saves its final value', (await state()).settings.reasoningEffort === 'xhigh');
      const beforeDefaultModel = await state();
      await clickByText('.model-picker__panel [role="menuitemradio"]', 'GPT-6 Luna', 'default Luna model');
      await waitFor("window.centre.request('GET','/state').then(value=>value.settings.chatModel === 'gpt-6-luna') && !document.querySelector('.model-picker__panel')", 'default model saved');
      const afterDefaultModel = await state();
      check('Default model selection persists without changing marking settings', afterDefaultModel.settings.chatModel === 'gpt-6-luna' && afterDefaultModel.settings.gradingModel === beforeDefaultModel.settings.gradingModel && afterDefaultModel.settings.gradingReasoningEffort === beforeDefaultModel.settings.gradingReasoningEffort);
      await clickByText('.settings-layout__nav button', 'General', 'leave Models settings');
      await clickByText('.settings-layout__nav button', 'Models', 'reopen Models settings');
      check('Saved default model is shown after remounting settings', await evaluate("document.querySelector('.preference-row .model-picker__trigger').textContent.includes('GPT-6 Luna')"));

      const beforeModelSave = await state();
      await clickSelector('button[aria-label="Choose marking model"]', 'marking model menu');
      await waitFor("document.querySelectorAll('.model-picker__panel [role=menuitemradio]').length >= 3", 'marking model choices', 20000);
      const targetLabel = await evaluate("(()=>{const panel=document.querySelector('.model-picker__panel');const chatModel=" + JSON.stringify(beforeModelSave.settings.chatModel) + ";const candidate=[...panel.querySelectorAll('[role=menuitemradio]')].find(item=>item.getAttribute('aria-checked')!=='true' && !item.textContent.toLowerCase().includes(chatModel.replace(/^gpt-/,'gpt-').replace(/-(sol|luna|astra)$/,'')));return candidate?.textContent.trim() || [...panel.querySelectorAll('[role=menuitemradio]')].find(item=>item.getAttribute('aria-checked')!=='true')?.textContent.trim()})()");
      check('A distinct marking model is available in the catalog', Boolean(targetLabel), targetLabel);
      await clickByText('.model-picker__panel [role="menuitemradio"]', targetLabel, 'distinct marking model');
      await waitFor("window.centre.request('GET','/state').then(value=>value.settings.gradingModel !== " + JSON.stringify(beforeModelSave.settings.gradingModel) + " && value.settings.gradingModel !== value.settings.chatModel)", 'independent marking-model save', 20000);
      const afterModelSave = await state();
      check('Marking model selection persists over IPC independently of the chat model', afterModelSave.settings.gradingModel !== beforeModelSave.settings.gradingModel && afterModelSave.settings.gradingModel !== afterModelSave.settings.chatModel && afterModelSave.settings.chatModel === beforeModelSave.settings.chatModel, { chatModel: afterModelSave.settings.chatModel, gradingModel: afterModelSave.settings.gradingModel });

      await clickSelector('button[aria-label="Choose marking model"]', 'marking reasoning menu');
      await waitFor("document.querySelector('.model-picker__stops button')", 'marking reasoning choices');
      const beforeMarkingEffort = await state();
      await clickByText('.model-picker__stops button', 'Low', 'marking reasoning choice');
      await waitFor("window.centre.request('GET','/state').then(value=>value.settings.gradingReasoningEffort === 'low')", 'marking reasoning saved');
      const afterMarkingEffort = await state();
      check('Marking reasoning saves independently of the default chat reasoning', afterMarkingEffort.settings.gradingReasoningEffort === 'low' && afterMarkingEffort.settings.reasoningEffort === beforeMarkingEffort.settings.reasoningEffort);
      await clickSelector('button[aria-label="Choose marking model"]', 'close marking reasoning menu');
      await screenshot('models');

      await clickByText('nav[aria-label="Main"] button', 'Resources', 'Resources navigation');
      await waitFor("document.querySelector('.resource-library')", 'Saved resource library');
      await clickSelector('.library-subjects summary', 'browse subjects');
      await waitFor("document.querySelector('.library-subjects[open] .subject-tile')", 'Resources subject list');
      await clickByText('.subject-tile', 'Synthetic Mathematics', 'synthetic subject');
      await waitFor("document.querySelector('.topic-row')", 'subject topic list');
      await clickByText('.topic-row', 'Linear equations', 'synthetic topic');
      await waitFor("document.querySelector('.resource-card__open')", 'topic resource list');
      await clickByText('.resource-card__open','Synthetic paper','paper resource');
      await waitFor("document.querySelector('.paper--cover') && document.querySelectorAll('.paper--section').length===3",'paper cover and sections');
      check('Test cover has section totals and no questions',await evaluate("document.querySelector('.paper--cover .paper-cover__parts tbody').children.length===3 && !document.querySelector('.paper--cover .paper__questions') && document.querySelector('.paper-cover__total strong').textContent==='6'"));
      check('Test section numbering continues across parts',await evaluate("[...document.querySelectorAll('.paper--section .paper__questions')].map(list=>list.start).join(',')==='1,2,3'"));
      const exportedPaper = await evaluate("window.centre.request('GET','/resources/qa-paper/export')");
      check('Existing tests export the new cover and section template',exportedPaper.content.includes('begin{titlepage}') && exportedPaper.content.includes('Part C: Long response'));
      await screenshot('paper-cover');
      await clickByText('.resource-header__crumbs button','Linear equations','back to topic');
      await waitFor("document.querySelector('.resource-card__open')",'resource cards');
      await clickByText('.resource-card__open','Synthetic diagram','diagram resource');
      await waitFor("document.querySelector('iframe.diagram-embed')",'diagram embed');
      const diagramFrame = () => {
        const relay = window.webContents.mainFrame.frames.find(frame=>frame.url.includes('/artifacts/qa-diagram/'));
        return relay?.frames.find(frame=>frame.url === 'about:srcdoc');
      };
      const diagramValue = async expression => {const frame=diagramFrame();if(!frame)throw new Error('Diagram child frame missing');return frame.executeJavaScript(expression);};
      for(let i=0;i<40 && !(diagramFrame() && await diagramValue("Boolean(document.getElementById('explore'))"));i++)await pause(100);
      await pause(500);
      const darkDiagram = await diagramValue("({theme:document.documentElement.dataset.theme,bg:getComputedStyle(document.body).backgroundColor,panel:getComputedStyle(document.querySelector('.panel')).backgroundColor,ink:getComputedStyle(document.querySelector('p')).color,height:Math.ceil(document.body.getBoundingClientRect().height)})");
      check('Legacy light diagrams follow the dark app palette',darkDiagram.theme==='dark' && darkDiagram.bg==='rgb(27, 27, 26)' && darkDiagram.panel==='rgb(32, 32, 31)' && darkDiagram.ink==='rgb(236, 235, 231)',darkDiagram);
      check('A minimally styled checklist keeps its final checkbox visible', await diagramValue("document.getElementById('last-checklist-item').getBoundingClientRect().bottom <= innerHeight"));
      const embedHeight = await evaluate("Number.parseFloat(getComputedStyle(document.querySelector('iframe.diagram-embed')).height)");
      check('Diagram embedding follows content height',Math.abs(embedHeight-darkDiagram.height)<=4,{embedHeight,contentHeight:darkDiagram.height});
      await diagramValue("document.getElementById('explore').click()");
      check('The themed embedded diagram remains interactive',await diagramValue("document.getElementById('explore').textContent==='Explored'"));
      await screenshot('diagram-dark');
      await evaluate("window.centre.request('PATCH','/settings',{theme:'light'})");
      await waitFor("document.documentElement.dataset.theme==='light'",'live light theme switch');
      await pause(200);
      const lightDiagram = await diagramValue("({theme:document.documentElement.dataset.theme,bg:getComputedStyle(document.body).backgroundColor,panel:getComputedStyle(document.querySelector('.panel')).backgroundColor})");
      check('Mounted diagrams follow theme changes without reloading',lightDiagram.theme==='light' && lightDiagram.bg==='rgb(249, 249, 247)' && lightDiagram.panel==='rgb(255, 255, 255)' && await diagramValue("document.getElementById('explore').textContent==='Explored'"),lightDiagram);
      await screenshot('diagram-light');
      await clickByText('.resource-header__actions button','Open file','standalone diagram');
      for(let i=0;i<40 && !openedPaths.length;i++)await pause(100);
      const filePath=openedPaths.at(-1);
      const standalone=filePath?await readFile(filePath,'utf8'):'';
      check('Open file writes a standalone themed HTML file and invokes macOS',Boolean(filePath) && filePath.endsWith('.html') && standalone.includes('--centre-bg:#f9f9f7') && standalone.includes('Right triangles') && standalone.includes("connect-src 'none'"),{fileCreated:Boolean(filePath)});
      await clickByText('.resource-header__actions button','Move','move resource');
      await waitFor("document.querySelector('dialog[open] button[aria-label=\\\"Move to topic\\\"]')",'move resource dialog');
      await clickSelector('dialog[open] button[aria-label="Move to topic"]','move topic picker');
      await clickByText('[role=option]','Pythagoras','correct classification');
      await clickByText('dialog[open] .dialog__footer button','Move','save corrected topic');
      await waitFor("!document.querySelector('dialog[open]') && document.querySelector('.resource-header__crumbs')?.textContent.includes('Pythagoras')",'corrected classification');
      check('Resource classification can be corrected from its page',(await state()).resources.find(resource=>resource.id==='qa-diagram').topicId==='qa-pythagoras');
      await evaluate("window.centre.request('PATCH','/settings',{theme:'dark'})");
      await waitFor("document.documentElement.dataset.theme==='dark'",'dark theme restore');
      await clickByText('nav[aria-label="Main"] button','Review','Review navigation');
      await waitFor("document.querySelector('.review-empty')",'empty review');
      check('Empty Review has a single explanation and clear next actions',await evaluate("document.querySelector('.review-empty h2')?.textContent==='A fresh start' && document.querySelectorAll('.review-empty__actions button').length===2 && !document.querySelector('.page--review .invite')"));
      await screenshot('review-empty');
      await clickByText('.review-empty__actions button','Browse resources','empty Review resource action');
      await waitFor("document.querySelector('.subject-tile')",'resource navigation from Review');
      await clickByText('.subject-tile','Synthetic Mathematics','subject again');
      await waitFor("document.querySelector('.topic-row')",'topic list again');
      await clickByText('.topic-row','Linear equations','quiz topic');
      await waitFor("document.querySelector('.resource-card__open')",'quiz card again');
      await clickByText('.resource-card__open', 'Synthetic mixed quiz', 'synthetic quiz resource');
      await waitFor("document.querySelector('.quiz__progress') && document.querySelector('.question--single')", 'quiz page');
      check('Resource navigation opens the seeded quiz with exactly one active question', await evaluate("document.querySelectorAll('.question--single').length === 1 && document.querySelector('.quiz__count')?.textContent.includes('Question 1 of 3')"));
      await screenshot('quiz');

      await clickByText('.quiz-choice', 'x = 9', 'multiple-choice answer');
      await waitFor("document.querySelector('.quiz-choice input[value=\\\"x = 9\\\"]')?.checked", 'multiple-choice answer selection');
      await clickByText('.quiz__nav button', 'Next', 'quiz next question');
      await waitFor("document.querySelector('.question__answer') && document.querySelector('.quiz__count')?.textContent.includes('Question 2 of 3')", 'short-response question');
      await setValue('.question__answer', 'x = 13', 'short-response answer');
      await clickByText('.quiz__nav button', 'Next', 'quiz next question');
      await waitFor("document.querySelector('.question__answer') && document.querySelector('.quiz__count')?.textContent.includes('Question 3 of 3')", 'long-response question');
      await setValue('.question__answer', 'Subtract 2 from both sides, divide by 3, and check x = 5.', 'long-response answer');
      check('Mixed quiz accepts multiple-choice, short, and long answers', await evaluate("document.querySelector('.quiz-choice input[value=\\\"x = 9\\\"]') === null && document.querySelector('.question__answer')?.value.includes('check x = 5') && document.querySelectorAll('.quiz__dot.is-answered').length === 3"));

      await setValue('.dock textarea', 'UI verification only: reply with OK. Do not create or change Centre resources.', 'bottom chat composer');
      await clickSelector('.dock button[aria-label="Send"]', 'send synthetic chat prompt');
      await waitFor("document.querySelector('aside.side-chat[aria-label=\\\"Chat\\\"]')", 'side chat opening');
      await screenshot('side-chat');
      await waitFor("[...document.querySelectorAll('aside.side-chat button')].some(button=>button.textContent.trim()==='Stop') || document.querySelector('aside.side-chat .thread-error') || (document.querySelector('aside.side-chat .thread') && !document.querySelector('aside.side-chat .working'))", 'synthetic chat request to start or settle', 15000);
      const stop = await evaluate("[...document.querySelectorAll('aside.side-chat button')].some(button=>button.textContent.trim()==='Stop')");
      if (stop) {
        await clickByText('aside.side-chat button', 'Stop', 'stop synthetic chat request');
        await waitFor("!document.querySelector('aside.side-chat .working')", 'synthetic chat cancellation to settle', 15000);
      }
      check('Synthetic chat request settled before Electron exits', await evaluate("!document.querySelector('aside.side-chat .working')"), stop ? 'cancelled from the SideChat UI' : 'completed or returned an error');
      await clickSelector('aside.side-chat button[aria-label="Close chat"]', 'close side chat');
      await waitFor("!document.querySelector('aside.side-chat[aria-label=\\\"Chat\\\"]') && document.querySelector('.dock__reopen')", 'ChatDock reopen control');
      check('ChatDock exposes the newly opened chat', await evaluate("Boolean(document.querySelector('.dock__reopen'))"));
      await clickSelector('.dock__reopen', 'reopen chat from ChatDock');
      await waitFor("document.querySelector('aside.side-chat[aria-label=\\\"Chat\\\"]')", 'side chat reopened from ChatDock');
      await clickSelector('aside.side-chat button[aria-label="Close chat"]', 'close reopened side chat');
      await waitFor("!document.querySelector('aside.side-chat[aria-label=\\\"Chat\\\"]')", 'side chat closed');

      await clickByAriaPrefix('.quiz__dots button', 'Question 1,', 'return to multiple-choice question');
      check('Closing and reopening SideChat preserves the multiple-choice answer', await evaluate("document.querySelector('.quiz-choice input[value=\\\"x = 9\\\"]')?.checked === true"));
      await clickByAriaPrefix('.quiz__dots button', 'Question 2,', 'return to short-response question');
      check('Closing and reopening SideChat preserves the short response', await evaluate("document.querySelector('.question__answer')?.value === 'x = 13'"));
      await clickByAriaPrefix('.quiz__dots button', 'Question 3,', 'return to long-response question');
      check('Closing and reopening SideChat preserves the long response', await evaluate("document.querySelector('.question__answer')?.value === 'Subtract 2 from both sides, divide by 3, and check x = 5.'"));
      const finalState = await state();
      check('Synthetic chat flow does not create or modify quiz resources', finalState.resources.length === 3 && finalState.resources[0].id === 'qa-mixed-quiz' && finalState.attempts.length === 0, { resources: finalState.resources.length, attempts: finalState.attempts.length });
      check('No renderer console errors occurred', consoleErrors.length === 0, consoleErrors);
      finish(null);
    } catch (error) {
      finish(error);
    }
  });
});
setTimeout(() => finish(new Error('Native UI verification timed out.')), 150000).unref();
require(${JSON.stringify(join(root, 'dist-electron', 'main.cjs'))});
`;

await writeFile(entry, entrySource);
const syntax = spawnSync(process.execPath,['--check',entry],{encoding:'utf8'});
if (syntax.status !== 0) throw new Error(syntax.stderr || 'Generated verifier failed syntax validation.');
const environment = {
  ...process.env,
  CENTRE_DATA_DIR: dataDirectory,
  CENTRE_RENDERER_URL: pathToFileURL(join(root, 'dist', 'index.html')).href,
};
delete environment.ELECTRON_RUN_AS_NODE;

let exitCode = 1;
try {
  const child = spawn(require('electron'), [entry], { cwd: root, env: environment, stdio: 'inherit' });
  const timer = setTimeout(() => child.kill('SIGTERM'), 160000);
  exitCode = await new Promise(resolveExit => {
    child.once('error', error => { process.stderr.write(`${error.message}\n`); resolveExit(1); });
    child.once('exit', code => resolveExit(code ?? 1));
  });
  clearTimeout(timer);
} finally {
  await rm(entry, { force: true }).catch(() => undefined);
  await rm(dataRoot, { recursive: true, force: true }).catch(() => undefined);
}

process.exitCode = exitCode;
