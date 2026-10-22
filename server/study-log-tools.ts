import { z } from 'zod';
import { localStudyInstant, studyTagsSchema, type StudySegment } from '../shared/study-log';
import { HttpError, requireFound } from './errors';
import type { StudyLogService } from './study-log';

const localDateTime = z.string().max(40).regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?$/, 'Use a local date-time without a UTC offset, such as 2026-10-21T19:30.');
export const logStudyInputSchema = studyTagsSchema.extend({
  id: z.uuid().describe('New stable UUID for this entry. Reuse it if retrying the exact same save.'),
  confirmedByUser: z.literal(true).describe('True only when the student explicitly requests recording this actual study.'),
  segments: z.array(z.object({ start: localDateTime, end: localDateTime }).strict()).min(1).max(100).describe('Actual local start/end date-times in timeZone. Overnight end uses the following date. Gaps and pauses are excluded.'),
}).strict();

export const studyLogInstructions = `Centre has an actual study Log, separate from planned Calendar sessions. Use centre_get_study_log to read recorded sessions and weekly aims. When the student explicitly asks you to log study they actually completed, use centre_log_study now with their actual start/end dates and times, IANA timeZone, title, notes, and existing subject/task IDs or null. Set confirmedByUser=true only for that explicit request. Interpret relative dates using the app's current date and learner timezone. Ask for missing actual dates/times using Centre's question popup; never invent an interval from a duration alone. Never count planned sessions, generated resources, a chat's elapsed time or assumed study as actual time. Local times have no UTC suffix or offset; Centre performs timezone conversion and rejects ambiguous/missing DST times, future time and overlaps. Use one new UUID per entry and the same UUID for an exact retry. Only say it was logged after the tool succeeds. Report the saved title, date and actual duration; the student can inspect or edit it in Log. These tools do not start, resume or stop a timer, edit past entries, or change Calendar.`;

export async function logStudy(service: StudyLogService, value: unknown) {
  const { confirmedByUser: _confirmed, segments: localSegments, ...input } = logStudyInputSchema.parse(value);
  let segments: StudySegment[];
  try {
    segments = localSegments.map(segment => ({
      start: localStudyInstant(segment.start.slice(0, 10), segment.start.slice(11), input.timeZone),
      end: localStudyInstant(segment.end.slice(0, 10), segment.end.slice(11), input.timeZone),
    }));
  } catch {
    throw new HttpError(400, 'Use valid, unambiguous local study dates and times. Times during a daylight-saving clock change may need correction.');
  }
  const log = await service.route('POST', '/api/study-log/sessions', { ...input, segments });
  return requireFound(log.sessions.find(session => session.id === input.id), 'Saved study entry');
}
