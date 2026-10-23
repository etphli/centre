import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, shell } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { mkdir,readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { createService } from '../server/index';
import { compilePaper } from './paper';
import { nativeAttachmentSchema, printPaperSchema, saveFileSchema, validateExternalUrl } from './security';
import { proxyRequest, proxyRequestForIpc } from './proxy';
import { createUpdater } from './updater';
import { diagramDocument } from '../server/diagram';
import { createDesktopActionDelivery, createDesktopWindowOpener } from './desktop-actions';
import { DesktopLauncherManager } from './desktop-launchers';
import { desktopActionSchema } from '../shared/desktop-actions';
import { launcherOperationSchema } from '../shared/desktop-launchers';
import { useSystemCertificateAuthorities } from './system-trust';

useSystemCertificateAuthorities();
app.setName('Centre');
if (process.env.CENTRE_USER_DATA_DIR) app.setPath('userData', resolve(process.env.CENTRE_USER_DATA_DIR));
process.env.PATH = [join(homedir(), '.local/bin'), join(homedir(), '.cargo/bin'), '/opt/homebrew/bin', '/usr/local/bin', process.env.PATH ?? '/usr/bin:/bin'].join(':');
process.env.CENTRE_SKILLS_DIR = app.isPackaged ? join(process.resourcesPath, 'skills') : join(__dirname, '../skills');
let mainWindow: BrowserWindow | null = null;
let service: Awaited<ReturnType<typeof createService>> | undefined;
let closing = false;
const rendererFile = join(__dirname, '../dist/index.html');
const rendererUrl = app.isPackaged ? pathToFileURL(rendererFile).href : process.env.CENTRE_RENDERER_URL ?? 'http://127.0.0.1:5186/';
const actions = createDesktopActionDelivery((request) => {
  if (!mainWindow || mainWindow.webContents.isDestroyed()) throw new Error('The Centre window is unavailable.');
  mainWindow.webContents.send('centre:actions:request', request);
}, (error) => console.error('Desktop action delivery failed', error));
const openCentreWindow = createDesktopWindowOpener({
  available: () => Boolean(service) && !closing,
  getWindow: () => mainWindow,
  createWindow,
});
function revealCentre() {
  void openCentreWindow().catch((error: unknown) => {
    console.error('Centre window could not open', error);
    dialog.showErrorBox('Centre could not open', error instanceof Error ? error.message : 'Unknown window error');
  });
}
// macOS can emit this before app.whenReady(). No protocol registration is needed here.
app.on('open-url', (event, url) => {
  event.preventDefault();
  if (actions.enqueueUrl(url)) revealCentre();
});
const googleOAuthSchema = z.object({ clientId: z.string().min(1), clientSecret: z.string().min(1) }).strict();
const maxAttachmentBytes = 20 * 1024 * 1024;
const maxAttachmentSelectionBytes = 30 * 1024 * 1024;
const attachmentMimes: Record<string,string> = {
  '.txt':'text/plain','.md':'text/markdown','.markdown':'text/markdown','.csv':'text/csv','.tsv':'text/tab-separated-values','.json':'application/json','.html':'text/html','.htm':'text/html','.xml':'application/xml','.yaml':'text/yaml','.yml':'text/yaml','.toml':'text/plain','.ini':'text/plain','.css':'text/css',
  '.js':'text/javascript','.jsx':'text/javascript','.mjs':'text/javascript','.cjs':'text/javascript','.ts':'text/typescript','.tsx':'text/typescript','.py':'text/x-python','.java':'text/x-java-source','.c':'text/x-c','.h':'text/x-c','.cc':'text/x-c++','.cpp':'text/x-c++','.hpp':'text/x-c++','.rs':'text/x-rust','.go':'text/x-go','.rb':'text/x-ruby','.php':'text/x-php','.swift':'text/x-swift','.sh':'text/x-shellscript','.sql':'application/sql','.ipynb':'application/json','.r':'text/plain','.tex':'application/x-tex','.log':'text/plain',
  '.pdf':'application/pdf','.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp',
};

async function loadGoogleOAuthConfig() {
  const configFile = app.isPackaged ? join(process.resourcesPath, 'google-oauth.json') : join(__dirname, 'google-oauth.json');
  let contents: string;
  try {
    contents = await readFile(configFile, 'utf8');
  } catch {
    throw new Error('The bundled Google sign-in configuration is unavailable.');
  }
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    throw new Error('The bundled Google sign-in configuration is invalid.');
  }
  return googleOAuthSchema.parse(value);
}

function authorize(event: IpcMainInvokeEvent) {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== event.sender.mainFrame || event.senderFrame.url !== rendererUrl) {
    throw new Error('Desktop requests must come from the Centre window.');
  }
}

async function createWindow() {
  const window = new BrowserWindow({
    title: 'Centre', width: 1380, height: 900, minWidth: 960, minHeight: 660,
    show: false, backgroundColor: '#191919', titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true,
      nodeIntegration: false, webSecurity: true, allowRunningInsecureContent: false,
    },
  });
  mainWindow = window;
  actions.unready();
  window.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) actions.unready();
  });
  window.webContents.on('render-process-gone', () => actions.unready());
  const syncWindowChrome = () => window.webContents.send('centre:window-chrome', process.platform === 'darwin' && !window.isFullScreen());
  window.webContents.on('dom-ready', syncWindowChrome);
  window.on('enter-full-screen', syncWindowChrome);
  window.on('leave-full-screen', syncWindowChrome);
  window.webContents.setWindowOpenHandler(({ url }) => {
    try { void shell.openExternal(validateExternalUrl(url)).catch(() => {}); } catch { /* The renderer cannot open unsupported protocols. */ }
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (url === rendererUrl) return;
    event.preventDefault();
    try { void shell.openExternal(validateExternalUrl(url)).catch(() => {}); } catch { /* Ignore unsupported navigation targets. */ }
  });
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.on('ready-to-show', () => window.show());
  window.on('closed', () => { actions.unready(); mainWindow = null; });
  try { await window.loadURL(rendererUrl); }
  catch (error) { window.destroy(); throw error; }
}

async function start() {
  const googleOAuth = await loadGoogleOAuthConfig();
  process.env.GOOGLE_CLIENT_ID = googleOAuth.clientId;
  process.env.GOOGLE_CLIENT_SECRET = googleOAuth.clientSecret;
  service = await createService({ dataDir: process.env.CENTRE_DATA_DIR ?? join(app.getPath('userData'), 'data') });
  const updates = createUpdater();
  const isolatedDesktop = Boolean(process.env.CENTRE_DESKTOP_DIR && process.env.CENTRE_USER_DATA_DIR);
  const launchersSupported = process.platform === 'darwin' && (app.isPackaged || isolatedDesktop);
  let launcherManager: Promise<DesktopLauncherManager> | undefined;
  function launchers() {
    if (!launcherManager) launcherManager = (async () => {
      const desktopDirectory = await realpath(process.env.CENTRE_DESKTOP_DIR ?? app.getPath('desktop'));
      const profileDirectory = await realpath(app.getPath('userData'));
      return new DesktopLauncherManager({ desktopDirectory, manifestDirectory: join(profileDirectory, 'desktop-launchers') });
    })().catch(error => { launcherManager = undefined; throw error; });
    return launcherManager;
  }
  async function launcherList() {
    return {
      supported: launchersSupported,
      message: launchersSupported ? '' : 'Desktop icons are available in the installed Centre app for macOS.',
      launchers: launchersSupported ? await (await launchers()).list() : [],
    };
  }
  ipcMain.handle('centre:launchers:list', (event) => { authorize(event); return launcherList(); });
  ipcMain.handle('centre:launchers:change', async (event, action: unknown, operation: unknown) => {
    authorize(event);
    if (!launchersSupported) throw new Error('Open the installed Centre app for macOS to manage Desktop icons.');
    await (await launchers()).change(desktopActionSchema.parse(action), launcherOperationSchema.parse(operation));
    return launcherList();
  });
  ipcMain.handle('centre:actions:ready', (event) => { authorize(event); actions.ready(); });
  ipcMain.handle('centre:actions:acknowledge', (event, value: unknown) => {
    authorize(event);
    actions.acknowledge(z.string().uuid().parse(value));
  });
  ipcMain.handle('centre:copy-text', (event, value: unknown) => {
    authorize(event);
    return clipboard.writeText(z.string().max(4096).parse(value));
  });
  ipcMain.handle('centre:request', async (event, method: unknown, path: unknown, body: unknown) => {
    authorize(event);
    if (!service) throw new Error('The local Centre service is not running.');
    return proxyRequestForIpc(service, method, path, body);
  });
  ipcMain.handle('centre:choose-files', async (event) => {
    authorize(event);
    if (!mainWindow) throw new Error('The Centre window is unavailable.');
    const result = await dialog.showOpenDialog(mainWindow, {
      title:'Attach files to Centre', properties:['openFile','multiSelections'],
      filters:[{ name:'Supported study files',extensions:Object.keys(attachmentMimes).map(extension => extension.slice(1)) }],
    });
    if (result.canceled) return [];
    if (result.filePaths.length > 5) throw new Error('Choose up to 5 files at a time.');
    let totalBytes = 0;
    const selected: Array<z.infer<typeof nativeAttachmentSchema>> = [];
    for (const path of result.filePaths) {
      const name = basename(path);
      const extension = extname(name).toLowerCase();
      const mimeType = attachmentMimes[extension];
      if (!mimeType) throw new Error(`“${name}” is not a supported attachment type.`);
      const details = await stat(path);
      if (details.size === 0) throw new Error(`“${name}” is empty.`);
      if (details.size > maxAttachmentBytes) throw new Error(`“${name}” is larger than 20 MB.`);
      totalBytes += details.size;
      if (totalBytes > maxAttachmentSelectionBytes) throw new Error('Selected files must total 30 MB or less.');
      const contents = await readFile(path);
      if (contents.length !== details.size || contents.length > maxAttachmentBytes) throw new Error(`“${name}” changed while Centre was reading it.`);
      selected.push(nativeAttachmentSchema.parse({ name,mimeType,data:contents.toString('base64') }));
    }
    return selected;
  });
  ipcMain.handle('centre:open-external', async (event, value: unknown) => {
    authorize(event);
    await shell.openExternal(validateExternalUrl(value));
  });
  ipcMain.handle('centre:open-diagram', async (event,value:unknown) => {
    authorize(event);
    const input = z.object({id:z.string().min(1).max(200),theme:z.enum(['dark','light','midnight'])}).strict().parse(value);
    if (!service) throw new Error('The local Centre service is not running.');
    const file = saveFileSchema.parse(await proxyRequest(service,'GET',`/resources/${encodeURIComponent(input.id)}/export`,undefined));
    if (file.mimeType !== 'text/html') throw new Error('Only diagrams can be opened as HTML files.');
    const directory = join(app.getPath('userData'),'diagrams');
    await mkdir(directory,{recursive:true,mode:0o700});
    const filename = `${input.id.replace(/[^a-zA-Z0-9_-]/g,'_')}.html`;
    const path = join(directory,filename);
    await writeFile(path,diagramDocument(file.content,input.theme),{mode:0o600});
    const failure = await shell.openPath(path);
    if (failure) throw new Error(`The diagram file could not open: ${failure}`);
    return {opened:true};
  });
  ipcMain.handle('centre:save-file', async (event, value: unknown) => {
    authorize(event);
    const file = saveFileSchema.parse(value);
    const result = await dialog.showSaveDialog({ title: 'Export from Centre', defaultPath: join(app.getPath('downloads'), file.filename) });
    if (result.canceled || !result.filePath) return { saved: false };
    await writeFile(result.filePath, file.content, { encoding: 'utf8', mode: 0o600 });
    return { saved: true, filename: basename(result.filePath) };
  });
  ipcMain.handle('centre:print-paper', async (event, value: unknown) => {
    authorize(event);
    const paper = printPaperSchema.parse(value);
    const result = await dialog.showSaveDialog({ title: 'Save PDF for printing', defaultPath: join(app.getPath('downloads'), `${paper.title.replace(/[^a-zA-Z0-9 _-]/g, '').slice(0, 120) || 'Centre paper'}.pdf`), filters: [{ name: 'PDF document', extensions: ['pdf'] }] });
    if (result.canceled || !result.filePath) return { saved: false };
    const pdf = await compilePaper(paper.latex, process.resourcesPath);
    await writeFile(result.filePath, pdf, { mode: 0o600 });
    const failure = await shell.openPath(result.filePath);
    if (failure) throw new Error(`PDF saved, but macOS could not open it: ${failure}`);
    return { saved: true, filename: basename(result.filePath) };
  });
  ipcMain.handle('centre:updates:status', (event) => { authorize(event); return updates.status(); });
  ipcMain.handle('centre:updates:check', (event) => { authorize(event); return updates.check(); });
  ipcMain.handle('centre:updates:install', (event) => { authorize(event); return updates.install(); });
  ipcMain.handle('centre:updates:configure', (event, value: unknown) => { authorize(event); return updates.configure(value); });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Centre', submenu: [{ role: 'about' }, { type: 'separator' }, { label: 'Check for updates...', click: () => { void updates.check().then((status) => dialog.showMessageBox({ type: status.state === 'error' ? 'error' : 'info', message: status.message })).catch(() => dialog.showErrorBox('Update failed', 'Centre could not check for updates.')); } }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] },
    { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
  ]));
  await openCentreWindow();
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  actions.enqueueArgv(process.argv);
  app.on('second-instance', (_event, argv) => { actions.enqueueArgv(argv); revealCentre(); });
  app.whenReady().then(start).catch((error: unknown) => {
    dialog.showErrorBox('Centre could not start', error instanceof Error ? error.message : 'Unknown startup error');
    app.quit();
  });
  app.on('activate', revealCentre);
  app.on('window-all-closed', () => { if (!closing && process.platform !== 'darwin') app.quit(); });
  app.on('before-quit', (event) => {
    if (closing || !service) return;
    event.preventDefault();
    closing = true;
    mainWindow?.destroy();
    const timeout = setTimeout(() => app.exit(0), 4000);
    void service.close().catch((error: unknown) => console.error('Centre service could not close', error)).finally(() => { clearTimeout(timeout); app.quit(); });
  });
}
