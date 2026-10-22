import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, '.runtime', 'clean-shutdown');
await mkdir(output, { recursive: true });
const run = spawnSync(process.execPath, [join(root, 'scripts/verify-flows.mjs')], {
  cwd: root, env: process.env, encoding: 'utf8', timeout: 180_000, maxBuffer: 8 * 1024 * 1024,
});
const log = `${run.stdout ?? ''}\n${run.stderr ?? ''}`;
await writeFile(join(output, 'native.log'), log);
const flows = JSON.parse(await readFile(join(root, '.runtime', 'qa-results.json'), 'utf8'));
const ipcErrors = [...log.matchAll(/Error occurred in handler for 'centre:request': ([^\n]*)/g)].map(match => match[1]);
const report = {
  passed: run.status === 0 && flows.passed === true && flows.consoleErrors.length === 0 && ipcErrors.length === 0,
  exitCode: run.status, checks: flows.checks.length, rendererErrors: flows.consoleErrors.length,
  shutdownIpcErrors: ipcErrors,
  log: join(output, 'native.log'),
};
await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
assert.equal(run.status, 0, 'Native flow runner must exit successfully');
assert.equal(flows.passed, true, 'Native flows must pass');
assert.equal(flows.consoleErrors.length, 0, 'Renderer must report no errors');
assert.deepEqual(ipcErrors, [], 'Quitting must not leave IPC requests racing a closed service');
