import { closeRunning, recoverStudySession, sessionSegments, studyCreateSchema, studyEditSchema, studyGoalInputSchema, studyLogSchema, studyRevisionSchema, studySessionSchema, timerActionSchema, timerCommandSchema, timerStartSchema, type StudyLog, type StudySegment, type StudySession, type StudyTags } from '../shared/study-log';
import { HttpError, requireFound } from './errors';
import type { Store } from './store';

export class StudyLogService {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly store: Store, private readonly clock = Date.now) {}

  private async transaction(change: (log: StudyLog, now: number) => void): Promise<StudyLog> {
    const work = this.queue.then(async () => {
      const previous = this.store.state.studyLog;
      const next = structuredClone(previous);
      change(next, this.clock());
      studyLogSchema.parse(next);
      if (JSON.stringify(next) !== JSON.stringify(previous)) {
        await this.store.saveStudyLog(next);
      }
      return structuredClone(next);
    });
    this.queue = work.catch(() => undefined);
    return work;
  }
  recover(restart = false) {
    return this.transaction((log, now) => { log.sessions = log.sessions.map(session => recoverStudySession(session, now, restart)); });
  }
  private tags(tags: StudyTags) {
    if (tags.subjectId && !this.store.state.subjects.some(subject => subject.id === tags.subjectId)) throw new HttpError(400, 'Choose an existing subject.');
    if (tags.taskId) {
      const task = this.store.state.assignments.find(task => task.id === tags.taskId);
      if (!task || (tags.subjectId && task.subjectId !== tags.subjectId)) throw new HttpError(400, 'Choose a task from this subject.');
    }
  }
  private revision(session: { revision: number }, expectedRevision: number) {
    if (session.revision !== expectedRevision) throw new HttpError(409, 'This study record changed. Refresh and try again.');
  }
  private overlap(log: StudyLog, candidate: StudySession, now: number, intervals: StudySegment[] = sessionSegments(candidate, now)) {
    for (const other of log.sessions) {
      if (other.id === candidate.id || other.deletedAt) continue;
      if (intervals.some(a => sessionSegments(other, now).some(b => Date.parse(a.start) < Date.parse(b.end) && Date.parse(b.start) < Date.parse(a.end)))) throw new HttpError(409, 'This time overlaps another study entry. Edit that entry or choose another time.');
    }
  }
  route(method: string, path: string, value: unknown): Promise<StudyLog> {
    return this.transaction((log, now) => {
      log.sessions = log.sessions.map(session => recoverStudySession(session, now));
      const timestamp = new Date(now).toISOString();
      const metadata: Pick<StudySession, 'schemaVersion' | 'revision' | 'createdAt' | 'updatedAt' | 'deletedAt'> = { schemaVersion: 1, revision: 1, createdAt: timestamp, updatedAt: timestamp, deletedAt: null };
      if (method === 'GET' && path === '/api/study-log') return;
      if (method === 'POST' && path === '/api/study-log/goals') {
        const input = studyGoalInputSchema.parse(value);
        const existing = log.goals.find(goal => goal.id === input.id || (!goal.deletedAt && goal.weekStart === input.weekStart && goal.timeZone === input.timeZone));
        if (existing) {
          if (existing.id !== input.id || existing.weekStart !== input.weekStart || existing.timeZone !== input.timeZone) throw new HttpError(409, 'This week already has an aim. Refresh before editing it.');
          if (input.expectedRevision === undefined) {
            if (existing.targetMinutes === input.targetMinutes) return;
            throw new HttpError(409, 'Refresh before editing this aim.');
          }
          this.revision(existing, input.expectedRevision);
          existing.targetMinutes = input.targetMinutes; existing.revision++; existing.updatedAt = timestamp;
        } else {
          if (input.expectedRevision !== undefined) throw new HttpError(409, 'This aim no longer exists.');
          log.goals.push({ ...metadata, id: input.id, weekStart: input.weekStart, timeZone: input.timeZone, targetMinutes: input.targetMinutes });
        }
        return;
      }
      if (method === 'POST' && (path === '/api/study-log/sessions' || path === '/api/study-log/timer/start')) {
        const timer = path.endsWith('/start');
        const input = timer ? timerStartSchema.parse(value) : studyCreateSchema.parse(value);
        this.tags(input);
        const existing = log.sessions.find(session => session.id === input.id);
        if (existing) {
          const same = ['subjectId', 'taskId', 'title', 'notes', 'timeZone'].every(key => Reflect.get(existing, key) === Reflect.get(input, key));
          if (!existing.deletedAt && same && existing.source === (timer ? 'timer' : 'manual') && (timer || ('segments' in input && JSON.stringify(existing.segments) === JSON.stringify(input.segments)))) return;
          throw new HttpError(409, 'This study ID is already in use.');
        }
        if (timer && log.sessions.some(session => !session.deletedAt && session.state.kind !== 'completed')) throw new HttpError(409, 'Stop the current timer before starting another.');
        const session = studySessionSchema.parse({ ...metadata, ...input, source: timer ? 'timer' : 'manual', segments: 'segments' in input ? input.segments : [], state: timer ? { kind: 'running', since: timestamp, checkpointAt: timestamp, lastActivityAt: timestamp, confirmedAt: timestamp } : { kind: 'completed' } });
        if (session.segments.some(segment => Date.parse(segment.end) > now)) throw new HttpError(400, 'Actual study cannot be in the future. Use Calendar to plan study.');
        this.overlap(log, session, now, timer ? [{ start: timestamp, end: new Date(now + 1).toISOString() }] : session.segments); log.sessions.push(session); return;
      }
      const entryMatch = /^\/api\/study-log\/sessions\/([^/]+)(\/delete)?$/.exec(path);
      if (entryMatch && ((method === 'PATCH' && !entryMatch[2]) || (method === 'POST' && entryMatch[2]))) {
        const session = requireFound(log.sessions.find(session => session.id === entryMatch[1] && !session.deletedAt), 'Study entry');
        if (session.state.kind !== 'completed') throw new HttpError(409, 'Stop this timer before editing or deleting it.');
        if (entryMatch[2]) {
          const input = studyRevisionSchema.parse(value); this.revision(session, input.expectedRevision);
          session.deletedAt = timestamp; session.updatedAt = timestamp; session.revision++; return;
        }
        const { expectedRevision, ...input } = studyEditSchema.parse(value);
        this.revision(session, expectedRevision); this.tags(input);
        if (input.segments.some(segment => Date.parse(segment.end) > now)) throw new HttpError(400, 'Actual study cannot be in the future.');
        const edited = { ...session, ...input, revision: session.revision + 1, updatedAt: timestamp };
        this.overlap(log, edited, now); log.sessions = log.sessions.map(item => item.id === edited.id ? edited : item); return;
      }
      const timerMatch = /^\/api\/study-log\/timer\/([^/]+)\/([^/]+)$/.exec(path);
      if (method === 'POST' && timerMatch) {
        const action = timerActionSchema.parse(timerMatch[2]);
        const input = timerCommandSchema.parse(value);
        const session = requireFound(log.sessions.find(session => session.id === timerMatch[1] && !session.deletedAt && session.source === 'timer'), 'Timer');
        // A safety pause discovered by this command wins over the caller's stale running revision.
        const original = this.store.state.studyLog.sessions.find(item => item.id === session.id);
        const safetyPaused = session.state.kind === 'paused' && original?.state.kind === 'running' && original.revision === input.expectedRevision;
        if (safetyPaused && action !== 'stop') return;
        if (!safetyPaused) this.revision(session, input.expectedRevision);
        if (session.state.kind === 'completed') throw new HttpError(409, 'This timer has already stopped.');
        let next = session;
        if (action === 'stop') next = closeRunning(session, now, { kind: 'completed' });
        else if (action === 'pause') {
          if (session.state.kind !== 'running') throw new HttpError(409, 'This timer is already paused.');
          next = closeRunning(session, now, { kind: 'paused', reason: 'user' });
        } else if (action === 'resume') {
          if (session.state.kind !== 'paused') throw new HttpError(409, 'This timer is already running.');
          if (log.sessions.some(other => other.id !== session.id && !other.deletedAt && other.state.kind === 'running')) throw new HttpError(409, 'Pause or stop the other running timer first.');
          next = { ...session, state: { kind: 'running', since: timestamp, checkpointAt: timestamp, lastActivityAt: timestamp, confirmedAt: timestamp } };
        } else if (session.state.kind === 'running') {
          next = { ...session, state: { ...session.state, checkpointAt: timestamp, lastActivityAt: input.activity || action === 'confirm' ? timestamp : session.state.lastActivityAt, confirmedAt: action === 'confirm' ? timestamp : session.state.confirmedAt } };
        } else throw new HttpError(409, 'Resume this paused timer first.');
        if (action === 'resume') this.overlap(log, next, now, [{ start: timestamp, end: new Date(now + 1).toISOString() }]);
        if ((action === 'heartbeat' || action === 'confirm') && session.state.kind === 'running' && now > Date.parse(session.state.checkpointAt)) {
          this.overlap(log, next, now, [{ start: session.state.checkpointAt, end: timestamp }]);
        }
        Object.assign(session, next, { updatedAt: timestamp, revision: session.revision + 1 }); return;
      }
      throw new HttpError(404, 'Study-log route not found.');
    });
  }
}
