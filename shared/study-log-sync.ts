import { z } from 'zod';
import { recoverStudySession, studySessionSchema, weeklyStudyGoalSchema, type StudyLog } from './study-log';

// The cloud owner supplies its CAS envelope; domain revisions stay inside data.
export const studyCloudRecordSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('studySession'), id: z.uuid(), deleted: z.boolean(), data: studySessionSchema.nullable() }),
  z.object({ kind: z.literal('studyGoal'), id: z.uuid(), deleted: z.boolean(), data: weeklyStudyGoalSchema.nullable() }),
]);
export type StudyCloudRecord = z.infer<typeof studyCloudRecordSchema>;
export function studyLogToCloudRecords(log: StudyLog): StudyCloudRecord[] {
  return [
    ...log.sessions.map(data => ({ kind: 'studySession' as const, id: data.id, deleted: data.deletedAt !== null, data })),
    ...log.goals.map(data => ({ kind: 'studyGoal' as const, id: data.id, deleted: data.deletedAt !== null, data })),
  ];
}
export function applyStudyCloudRecord(log: StudyLog, value: unknown, now: number): StudyLog {
  const record = studyCloudRecordSchema.parse(value);
  if (record.data && record.data.id !== record.id) throw new Error('Cloud study ID does not match its data.');
  if (record.deleted) {
    const deletedAt = new Date(now).toISOString();
    if (record.kind === 'studySession') {
      const previous = record.data ?? log.sessions.find(session => session.id === record.id);
      if (!previous) return log;
      const session = { ...recoverStudySession(previous, now, true), deletedAt: previous.deletedAt ?? deletedAt, state: { kind: 'completed' as const } };
      return { ...log, sessions: [...log.sessions.filter(item => item.id !== record.id), session] };
    }
    const previous = record.data ?? log.goals.find(goal => goal.id === record.id);
    if (!previous) return log;
    return { ...log, goals: [...log.goals.filter(item => item.id !== record.id), { ...previous, deletedAt: previous.deletedAt ?? deletedAt }] };
  }
  if (!record.data || record.data.deletedAt) throw new Error('A live cloud study record needs live data.');
  if (record.kind === 'studySession') {
    const session = recoverStudySession(record.data, now, true);
    return { ...log, sessions: [...log.sessions.filter(item => item.id !== record.id), session] };
  }
  return { ...log, goals: [...log.goals.filter(item => item.id !== record.id), record.data] };
}
