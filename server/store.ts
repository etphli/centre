import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { StudyLog } from '../shared/study-log';
import { snapshotSchema, type Snapshot } from '../shared/schema';

export const emptySnapshot = (): Snapshot => snapshotSchema.parse({ subjects: [], topics: [], resources: [], chats: [], events: [], memories: [], assignments: [], settings: {}, codex: { available: false, authenticated: false, message: 'Connecting to Codex CLI…' }, lastSyncedAt: null });

export class Store {
  private queue: Promise<void> = Promise.resolve();
  private constructor(readonly directory: string, readonly state: Snapshot) {}
  static async open(directory: string) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    let state = emptySnapshot();
    try { state = snapshotSchema.parse(JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'))); }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw new Error('Centre data could not be read. The existing state file has been preserved.', { cause: error }); }
    return new Store(directory, state);
  }
  save(): Promise<void> { return this.persist(); }
  saveStudyLog(studyLog: StudyLog): Promise<void> { return this.persist(studyLog); }
  private persist(studyLog?: StudyLog): Promise<void> {
    const write = this.queue.then(async () => {
      const content = JSON.stringify(snapshotSchema.parse({ ...this.state, studyLog: studyLog ?? this.state.studyLog }), null, 2);
      const temporary = join(this.directory, 'state.json.tmp');
      await writeFile(temporary, content, { mode: 0o600 });
      await rename(temporary, join(this.directory, 'state.json'));
      if (studyLog) this.state.studyLog = studyLog;
    });
    this.queue = write.catch(() => undefined);
    return write;
  }
}
