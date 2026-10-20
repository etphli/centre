import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { paperSandboxProfile } from './paper-sandbox';

const run = promisify(execFile);
test('compiler sandbox permits its work directory while denying outside reads and writes', { skip: process.platform !== 'darwin' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'centre-compiler-sandbox-'));
  const outside = await mkdtemp(join(tmpdir(), 'centre-outside-sandbox-'));
  const secret = join(outside, 'private.txt');
  await writeFile(secret, 'This must not enter a generated paper.');
  const linkedSecret = join(directory, 'link-to-private.txt');
  await symlink(secret, linkedSecret);
  const script = join(directory, 'probe.js');
  await writeFile(script, `const fs=require('node:fs');
    fs.writeFileSync(${JSON.stringify(join(directory, 'permitted.txt'))}, 'allowed');
    for (const operation of [()=>fs.readFileSync(${JSON.stringify(secret)}),()=>fs.readFileSync(${JSON.stringify(linkedSecret)}),()=>fs.writeFileSync(${JSON.stringify(secret)}, 'overwritten'),()=>require('node:child_process').execFileSync('/bin/echo',['escape'])]) {
      try { operation(); process.exit(5); } catch(error) { if(error.code!=='EPERM' && error.code!=='EACCES') throw error; }
    }
    process.stdout.write('confined');`);
  try {
    const result = await run('/usr/bin/sandbox-exec', ['-p', paperSandboxProfile(process.execPath, directory), process.execPath, script], { cwd: directory, timeout: 10000 });
    assert.equal(result.stdout, 'confined');
    assert.equal(await readFile(join(directory, 'permitted.txt'), 'utf8'), 'allowed');
    assert.equal(await readFile(secret, 'utf8'), 'This must not enter a generated paper.');
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
