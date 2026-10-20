import { mkdir, open, readFile, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const ownerSchema = z.object({ pid:z.number().int().positive(), nonce:z.string() });
const missing = (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT';
const exists = (error: unknown) => error instanceof Error && 'code' in error && error.code === 'EEXIST';
function alive(pid: number) { try { process.kill(pid,0); return true; } catch (error) { return !(error instanceof Error && 'code' in error && error.code === 'ESRCH'); } }
/** Exclusive creation prevents npm dev and Electron from writing the same state directory. */
export async function acquireServiceLock(directory: string): Promise<() => Promise<void>> {
  await mkdir(directory,{ recursive:true,mode:0o700 });
  const path = join(directory,'service.lock'); const owner = { pid:process.pid,nonce:randomUUID() };
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const file = await open(path,'wx',0o600);
      try { await file.writeFile(JSON.stringify(owner)); } finally { await file.close(); }
      return async () => {
        try { const current = ownerSchema.safeParse(JSON.parse(await readFile(path,'utf8'))); if (current.success && current.data.nonce === owner.nonce) await unlink(path); }
        catch (error) { if (!missing(error)) throw error; }
      };
    } catch (error) {
      if (!exists(error)) throw error;
      try {
        const before = await stat(path);
        const parsed = ownerSchema.safeParse(JSON.parse(await readFile(path,'utf8')));
        if (parsed.success && alive(parsed.data.pid)) throw new Error(`Centre is already running with this data directory (process ${parsed.data.pid}). Close the other Centre service first.`);
        if (!parsed.success && Date.now() - before.mtimeMs < 30000) throw new Error('Another Centre service is starting with this data directory.');
        const after = await stat(path);
        if (before.ino === after.ino && before.mtimeMs === after.mtimeMs) await unlink(path);
      } catch (failure) {
        if (missing(failure)) continue;
        if (failure instanceof SyntaxError) {
          // A newly created, empty lock belongs to a process that is still starting.
          const metadata = await stat(path);
          if (Date.now() - metadata.mtimeMs < 30000) throw new Error('Another Centre service is starting with this data directory.');
          await unlink(path); continue;
        }
        throw failure;
      }
    }
  }
  throw new Error('Could not acquire the Centre data directory lock. Try again after closing the other service.');
}
