import { constants, closeSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { desktopActionSchema, desktopActionUrl, type DesktopAction } from '../shared/desktop-actions';
import { launcherOperationSchema, type LauncherOperation, type LauncherStatus } from '../shared/desktop-launchers';

const filenames = {
  'study-log.manual': 'Centre – Log study.inetloc',
  'study-log.timer': 'Centre – Study timer.inetloc',
  'study-log.week': 'Centre – Study summary.inetloc',
  'chat.new': 'Centre – New chat.inetloc',
  'app.search': 'Centre – Search Centre.inetloc',
  'app.resources': 'Centre – Resources.inetloc',
  'app.calendar': 'Centre – Calendar.inetloc',
  'app.settings': 'Centre – Settings.inetloc',
} satisfies Record<DesktopAction, string>;

export type DesktopLauncherStatus = LauncherStatus;
export type DesktopLauncherOperation = LauncherOperation;
export type DesktopLauncherOptions = { desktopDirectory: string; manifestDirectory: string };

const entrySchema = z.object({
  action: desktopActionSchema,
  token: z.string().uuid(),
  device: z.string().regex(/^\d+$/),
  inode: z.string().regex(/^\d+$/),
}).strict();
const manifestSchema = z.object({ version: z.literal(1), entries: z.array(entrySchema) }).strict()
  .refine(value => new Set(value.entries.map(entry => entry.action)).size === value.entries.length);
type Entry = z.infer<typeof entrySchema>;
type Manifest = z.infer<typeof manifestSchema>;

function contents(action: DesktopAction): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n  <key>URL</key>\n  <string>${desktopActionUrl(action)}</string>\n</dict>\n</plist>\n`;
}

function syncDirectory(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY);
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function stat(path: string) {
  try { return lstatSync(path, { bigint: true }); } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
}

// Reject symlink directory components as well as symlink launcher/manifest files.
function checkDirectory(path: string): void {
  if (dirname(path) !== path) checkDirectory(dirname(path));
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Unsafe launcher directory: ${path}`);
}

function readRegular(path: string): { text: string; device: string; inode: string } {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(descriptor, { bigint: true });
    if (!info.isFile() || info.size > 64_000n) throw new Error('Unsafe launcher file');
    return { text: readFileSync(descriptor, 'utf8'), device: String(info.dev), inode: String(info.ino) };
  } finally { closeSync(descriptor); }
}

/** Main-process only. Directories must be trusted absolute paths on the same filesystem. */
export class DesktopLauncherManager {
  private readonly desktopDirectory: string;
  private readonly manifestDirectory: string;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(options: DesktopLauncherOptions) {
    if (!isAbsolute(options.desktopDirectory) || !isAbsolute(options.manifestDirectory)) {
      throw new Error('Launcher directories must be absolute');
    }
    this.desktopDirectory = resolve(options.desktopDirectory);
    this.manifestDirectory = resolve(options.manifestDirectory);
    if (this.desktopDirectory === this.manifestDirectory) throw new Error('Ownership directory must be private');
  }

  private serialize<T>(operation: () => T): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => undefined);
    return result;
  }

  private load(): Manifest {
    checkDirectory(this.desktopDirectory);
    // Only the private final component may be created, never a redirected parent.
    checkDirectory(dirname(this.manifestDirectory));
    if (!stat(this.manifestDirectory)) mkdirSync(this.manifestDirectory, { mode: 0o700 });
    checkDirectory(this.manifestDirectory);
    const path = join(this.manifestDirectory, 'manifest.json');
    if (!stat(path)) return { version: 1, entries: [] };
    return manifestSchema.parse(JSON.parse(readRegular(path).text));
  }

  private save(manifest: Manifest): void {
    const temporary = join(this.manifestDirectory, `${randomUUID()}.tmp`);
    const descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      writeFileSync(descriptor, `${JSON.stringify(manifest)}\n`);
      fsyncSync(descriptor);
    } finally { closeSync(descriptor); }
    // Atomic replacement leaves either the old or new complete ownership record.
    renameSync(temporary, join(this.manifestDirectory, 'manifest.json'));
    syncDirectory(this.manifestDirectory);
  }

  private source(entry: Entry): string { return join(this.manifestDirectory, `${entry.token}.inetloc`); }
  private target(action: DesktopAction): string { return join(this.desktopDirectory, filenames[action]); }

  private verified(path: string, entry: Entry): boolean {
    try {
      const file = readRegular(path);
      return file.device === entry.device && file.inode === entry.inode && file.text === contents(entry.action);
    } catch { return false; }
  }

  private status(action: DesktopAction, manifest: Manifest): DesktopLauncherStatus {
    const entry = manifest.entries.find(value => value.action === action);
    const target = this.target(action);
    const info = stat(target);
    const state = !entry ? (info ? 'conflict' : 'absent')
      : !info ? 'missing'
      : !this.verified(this.source(entry), entry) ? 'conflict'
      : this.verified(target, entry) ? 'installed' : 'conflict';
    return { action, state, filename: filenames[action] };
  }

  private statuses(manifest: Manifest): DesktopLauncherStatus[] {
    return desktopActionSchema.options.map(action => this.status(action, manifest));
  }

  list(): Promise<DesktopLauncherStatus[]> {
    return this.serialize(() => this.statuses(this.load()));
  }

  change(input: unknown, operation: DesktopLauncherOperation): Promise<DesktopLauncherStatus[]> {
    return this.serialize(() => {
      const action = desktopActionSchema.parse(input);
      const verb = launcherOperationSchema.parse(operation);
      const manifest = this.load();
      const status = this.status(action, manifest);
      if (status.state === 'conflict') throw new Error(`Launcher conflict: ${status.filename}`);
      const entry = manifest.entries.find(value => value.action === action);
      if (verb === 'remove') {
        if (!entry) return this.statuses(manifest);
        if (status.state === 'installed') {
          // No asynchronous gap between checking identity/content and unlinking.
          if (!this.verified(this.target(action), entry)) throw new Error('Launcher changed before removal');
          unlinkSync(this.target(action));
          syncDirectory(this.desktopDirectory);
        }
        this.save({ version: 1, entries: manifest.entries.filter(value => value.action !== action) });
        if (this.verified(this.source(entry), entry)) unlinkSync(this.source(entry));
      } else if (entry && this.verified(this.source(entry), entry)) {
        if (status.state === 'missing') {
          linkSync(this.source(entry), this.target(action));
          syncDirectory(this.desktopDirectory);
        }
      } else {
        if (!entry && verb === 'repair') throw new Error('Cannot repair an unowned launcher');
        const token = randomUUID();
        const source = join(this.manifestDirectory, `${token}.inetloc`);
        const descriptor = openSync(source, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        let ownership: Entry;
        try {
          writeFileSync(descriptor, contents(action));
          fsyncSync(descriptor);
          const info = fstatSync(descriptor, { bigint: true });
          ownership = { action, token, device: String(info.dev), inode: String(info.ino) };
        } finally { closeSync(descriptor); }
        // Commit ownership BEFORE exclusive publication. A crash leaves a repairable
        // missing launcher, never an untracked Desktop file that we later adopt.
        this.save({ version: 1, entries: [...manifest.entries.filter(value => value.action !== action), ownership] });
        linkSync(source, this.target(action));
        syncDirectory(this.desktopDirectory);
      }
      return this.statuses(this.load());
    });
  }
}
