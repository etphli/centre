import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { copyFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const directory = await mkdtemp(join(tmpdir(), 'centre-desktop-check-'));
await mkdir(join(directory, 'data'));
if (process.env.CENTRE_VERIFY_STATE) await copyFile(process.env.CENTRE_VERIFY_STATE, join(directory, 'data/state.json'));
await mkdir('.runtime', { recursive: true });
const entry = resolve('.runtime/verify-desktop.cjs');
const report = resolve('.runtime/native-home.png');
await writeFile(entry, `
const {app,BrowserWindow}=require('electron');
const {writeFile}=require('node:fs/promises');
const assert=require('node:assert/strict');
app.setPath('userData',${JSON.stringify(join(directory, 'runtime'))});
app.on('browser-window-created',(_event,window)=>{
  window.webContents.once('did-finish-load',async()=>{
    try{
      const evaluate=script=>window.webContents.executeJavaScript(script);
      for(let i=0;i<80;i++){
        if(await evaluate("Boolean(document.querySelector('h1')) && Boolean(window.centre)"))break;
        await new Promise(resolve=>setTimeout(resolve,100));
      }
      const check=await evaluate("(async()=>({title:document.title,heading:document.querySelector('h1')?.textContent,node:typeof require,state:await window.centre.request('GET','/state')}))()");
      assert.equal(check.title,'Centre');
      assert.ok(check.heading);
      assert.equal(check.node,'undefined');
      assert.ok(Array.isArray(check.state.subjects));
      await writeFile(${JSON.stringify(report)},(await window.webContents.capturePage()).toPNG());
      const blocked=await evaluate("window.centre.request('GET','/artifacts/escape').then(()=>false,()=>true)");
      assert.equal(blocked,true);
      console.log(JSON.stringify({passed:true,title:check.title,heading:check.heading,subjects:check.state.subjects.length,codex:check.state.codex,screenshot:${JSON.stringify(report)}}));
      app.quit();
    }catch(error){console.error(error);app.exit(1);}
  });
});
setTimeout(()=>{console.error('Native verification timed out.');app.exit(1)},30000).unref();
require(${JSON.stringify(resolve('dist-electron/main.cjs'))});
`);
const environment = { ...process.env, CENTRE_DATA_DIR: join(directory, 'data'), CENTRE_RENDERER_URL: pathToFileURL(resolve('dist/index.html')).href };
delete environment.ELECTRON_RUN_AS_NODE;
const child = spawn(require('electron'), [entry], { env: environment, stdio: 'inherit' });
child.on('exit', (code) => { process.exitCode = code ?? 1; });
child.on('error', (error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
