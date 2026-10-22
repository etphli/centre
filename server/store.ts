import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { StudyLog } from '../shared/study-log';
import { snapshotSchema, type Snapshot } from '../shared/schema';

export const emptySnapshot = (): Snapshot => snapshotSchema.parse({ subjects: [], topics: [], resources: [], chats: [], events: [], memories: [], learningNeeds:[], practiceDrafts:[], assignments: [], settings: {}, codex: { available: false, authenticated: false, message: 'Connecting to Codex CLI…' }, lastSyncedAt: null });

export type StoreMutation<T> = { value:T; apply:((state:Snapshot) => void) | null };
export type StateWriter = (directory:string, content:string) => Promise<void>;

export async function writeStateFile(directory:string, content:string): Promise<void> {
  const temporary = join(directory, 'state.json.tmp');
  await writeFile(temporary, content, { mode: 0o600 });
  await rename(temporary, join(directory, 'state.json'));
}

export class Store {
  private queue: Promise<void> = Promise.resolve();
  private readonly committed = new Set<() => void>();
  onCommitted(listener:() => void) {
    this.committed.add(listener);
    return () => { this.committed.delete(listener); };
  }
  private publishCommit() {
    for (const listener of this.committed) listener();
  }
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
  saveStudyLog(studyLog:StudyLog):Promise<void> {
    return this.atomic(() => ({ value:undefined, apply:state => { state.studyLog = studyLog; } }));
  }
  save(): Promise<void> {
    return this.enqueue(async () => {
      for (;;) {
        const before = JSON.stringify(this.state);
        await this.write(this.state);
        if (JSON.stringify(this.state) !== before) continue;
        this.publishCommit();
        return;
      }
    });
  }
  update(change:(state:Snapshot) => void):Promise<void>;
  update<K extends keyof Snapshot>(key:K, change:(current:Snapshot[K]) => Snapshot[K]|undefined):Promise<void>;
  update<K extends keyof Snapshot>(keyOrChange:K | ((state:Snapshot) => void), change?:(current:Snapshot[K]) => Snapshot[K]|undefined):Promise<void> {
    if (typeof keyOrChange === 'function') return this.atomic(() => ({value:undefined,apply:keyOrChange}));
    if (!change) throw new Error('A keyed update needs a change function.');
    return this.atomic(current => {
      const next = change(current[keyOrChange]);
      return {value:undefined,apply:next === undefined ? null : state => { state[keyOrChange] = next; }};
    });
  }
  /** Re-prepare against the latest state if a legacy direct mutation races the queued write. */
  atomic<T>(prepare:(current:Snapshot) => StoreMutation<T>):Promise<T> {
    return this.enqueue(async () => {
      let retry = false;
      for (;;) {
        const before = JSON.stringify(this.state);
        const proposed = structuredClone(this.state);
        const mutation = prepare(proposed);
        if (!mutation.apply && !retry) return mutation.value;
        mutation.apply?.(proposed);
        await this.write(proposed);
        if (JSON.stringify(this.state) !== before) { retry = true; continue; }
        mutation.apply?.(this.state);
        this.publishCommit();
        return mutation.value;
      }
    });
  }
}
