import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { StudyLog } from '../shared/study-log';
import { snapshotSchema, type Snapshot } from '../shared/schema';

export const emptySnapshot = (): Snapshot => snapshotSchema.parse({ subjects: [], topics: [], resources: [], chats: [], events: [], memories: [], assignments: [], settings: {}, codex: { available: false, authenticated: false, message: 'Connecting to Codex CLI…' }, lastSyncedAt: null });

export type StoreMutation<T> = { value:T; apply:((state:Snapshot) => void) | null };
export type StateWriter = (directory:string, content:string) => Promise<void>;

export async function writeStateFile(directory:string, content:string): Promise<void> {
  const temporary = join(directory, 'state.json.tmp');
  await writeFile(temporary, content, { mode: 0o600 });
  await rename(temporary, join(directory, 'state.json'));
}

export class Store {
  private queue: Promise<void> = Promise.resolve();
  private constructor(readonly directory: string, readonly state: Snapshot, private readonly writer:StateWriter) {}
  static async open(directory: string, writer:StateWriter = writeStateFile) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    let state = emptySnapshot();
    try { state = snapshotSchema.parse(JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'))); }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw new Error('Centre data could not be read. The existing state file has been preserved.', { cause: error }); }
    return new Store(directory, state, writer);
  }
  private enqueue<T>(work:() => Promise<T>):Promise<T> {
    const pending = this.queue.then(work);
    this.queue = pending.then(() => undefined, () => undefined);
    return pending;
  }
  private write(state:Snapshot):Promise<void> {
    return this.writer(this.directory, JSON.stringify(snapshotSchema.parse(state), null, 2));
  }
  save(): Promise<void> {
    return this.enqueue(() => this.write(this.state));
  }
  saveStudyLog(studyLog:StudyLog):Promise<void> {
    return this.atomic(() => ({value:undefined,apply:state=>{state.studyLog=studyLog;}}));
  }
  update(change:(state:Snapshot) => void):Promise<void> {
    return this.atomic(() => ({value:undefined,apply:change}));
  }
  /** Prepare stable IDs/timestamps once; apply the same patch before persistence and after success. */
  atomic<T>(prepare:(current:Snapshot) => StoreMutation<T>):Promise<T> {
    return this.enqueue(async () => {
      const proposed = structuredClone(this.state);
      const mutation = prepare(proposed);
      if (!mutation.apply) return mutation.value;
      mutation.apply(proposed);
      await this.write(proposed);
      mutation.apply(this.state);
      return mutation.value;
    });
  }
}
