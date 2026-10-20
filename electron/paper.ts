import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { paperSandboxProfile } from './paper-sandbox';

const run = promisify(execFile);

export async function compilePaper(latex: string, resourcesPath: string): Promise<Buffer> {
  if (process.platform !== 'darwin') throw new Error('PDF compilation currently requires the macOS compiler sandbox. Export the LaTeX source to compile it separately.');
  const candidates = [
    join(resourcesPath, 'bin', 'tectonic'),
    join(homedir(), '.cargo', 'bin', 'tectonic'),
    '/opt/homebrew/bin/tectonic',
    '/usr/local/bin/tectonic',
  ];
  let executable: string | undefined;
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); executable = candidate; break; } catch { /* Try the next installed binary. */ }
  }
  if (!executable) {
    throw new Error('PDF printing needs Tectonic. Install it with "brew install tectonic", then retry. You can export the LaTeX source now.');
  }
  const directory = await mkdtemp(join(tmpdir(), 'centre-paper-'));
  try {
    await writeFile(join(directory, 'paper.tex'), latex, { mode: 0o600 });
    try {
      await run('/usr/bin/sandbox-exec', ['-p', paperSandboxProfile(executable, directory), executable, '--untrusted', '--outdir', directory, join(directory, 'paper.tex')], {
        cwd: directory, timeout: 240_000, maxBuffer: 2_000_000,
        env: { HOME: homedir(), TMPDIR: directory, PATH: '/usr/bin:/bin', LANG: 'en_AU.UTF-8', TECTONIC_UNTRUSTED_MODE: '1' },
      });
    } catch (error) {
      const details = error instanceof Error ? error.message : 'Unknown compiler error';
      if (/bundle isn't cached|error sending request for url|Could not resolve|dns error/.test(details)) {
        throw new Error('Tectonic could not download its LaTeX support files. Connect to the internet and retry. The LaTeX source can still be exported while PDF compilation is unavailable.');
      }
      throw new Error(`The LaTeX paper could not compile. Export the source to inspect it. ${details.slice(-1000)}`);
    }
    return await readFile(join(directory, 'paper.pdf'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
