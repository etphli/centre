import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'vite';
import './build-electron.mjs';

const require = createRequire(import.meta.url);
const vite = await createServer({ server: { host: '127.0.0.1', port: 5186, strictPort: false } });
await vite.listen();
let desktop;
const stop = () => { desktop?.kill(); void vite.close(); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
try {
  const environment = { ...process.env };
  environment.CENTRE_RENDERER_URL = vite.resolvedUrls?.local[0] ?? 'http://127.0.0.1:5186/';
  delete environment.ELECTRON_RUN_AS_NODE;
  desktop = spawn(require('electron'), ['.'], { stdio: 'inherit', env: environment });
  desktop.on('exit', (code) => { void vite.close(); process.exitCode = code ?? 1; });
  desktop.on('error', (error) => { stop(); process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
} catch (error) {
  stop();
  throw error;
}
