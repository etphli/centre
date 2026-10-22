import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';
import { HttpError } from './errors';
import { calendarStartInstant, calendarTimeKey } from '../shared/calendar-time';
import { calendarTimeSchema } from '../shared/schema';

const timeSchema = calendarTimeSchema;
const durationSchema = z.number().int().min(5).max(720);
export const calendarInputSchema = z.object({
  title:z.string().trim().min(1).max(200), date:z.iso.date(), time:timeSchema.nullable().optional(),
  plannedDurationMinutes:durationSchema.nullable().optional(), subjectId:z.string().nullable().optional(), notes:z.string().max(20000).default(''),
}).strict().refine(value => !value.plannedDurationMinutes || Boolean(value.time), 'A planned session needs a start time.');
export const calendarPatchSchema = z.object({
  title:z.string().trim().min(1).max(200).optional(), date:z.iso.date().optional(), time:timeSchema.nullable().optional(),
  plannedDurationMinutes:durationSchema.nullable().optional(), subjectId:z.string().nullable().optional(), notes:z.string().max(20000).optional(),
  completedAt:z.iso.datetime().nullable().optional(), expectedRevision:z.number().int().positive().optional(),
}).strict().refine(value => value.plannedDurationMinutes == null || value.time !== null, 'A planned session needs a start time.');
export const archiveCalendarEventSchema = z.object({expectedRevision:z.number().int().positive()}).strict();
export function organatoDeadline(date: string,time: string | null | undefined,timeZone: string) {
  if (!time) return {dueAt:null,dueDateLocal:date,dueHasExplicitTime:false};
  try {
    const instant = calendarStartInstant(date,time,timeZone);
    return {dueAt:instant.toString(),dueDateLocal:null,dueHasExplicitTime:true};
  } catch { throw new HttpError(400,'This calendar date or time is invalid, ambiguous or does not exist in the selected time zone. Choose another time.'); }
}
export function calendarDate(dueAt: string | null,dueDateLocal: string | null,timeZone: string) {
  if (dueAt) {
    try {
      const value = Temporal.Instant.from(dueAt).toZonedDateTimeISO(timeZone);
      return {date:value.toPlainDate().toString(),time:calendarTimeKey(value.toPlainTime()),startAt:Temporal.Instant.from(dueAt).toString()};
    } catch { throw new HttpError(400,'Organato returned a deadline Centre could not read in the selected time zone.'); }
  }
  if (dueDateLocal) return {date:dueDateLocal,time:null,startAt:null};
  return null;
}
