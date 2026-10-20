import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';
import { HttpError } from './errors';

export const calendarInputSchema = z.object({title:z.string().trim().min(1).max(500),date:z.iso.date(),time:z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).nullable().optional(),subjectId:z.string().nullable().optional(),notes:z.string().max(20000).default('')}).strict();
export const calendarPatchSchema = calendarInputSchema.partial().extend({notes:z.string().max(20000).optional(),completedAt:z.iso.datetime().nullable().optional()}).strict();
export function organatoDeadline(date: string,time: string | null | undefined,timeZone: string) {
  if (!time) return {dueAt:null,dueDateLocal:date,dueHasExplicitTime:false};
  try {
    const day = Temporal.PlainDate.from(date); const clock = Temporal.PlainTime.from(time);
    const instant = Temporal.ZonedDateTime.from({year:day.year,month:day.month,day:day.day,hour:clock.hour,minute:clock.minute,timeZone},{disambiguation:'reject'}).toInstant();
    return {dueAt:instant.toString(),dueDateLocal:null,dueHasExplicitTime:true};
  } catch { throw new HttpError(400,'This calendar date or time is invalid, ambiguous or does not exist in the selected time zone. Choose another time.'); }
}
export function calendarDate(dueAt: string | null,dueDateLocal: string | null,timeZone: string) {
  if (dueAt) {
    const value = Temporal.Instant.from(dueAt).toZonedDateTimeISO(timeZone);
    return {date:value.toPlainDate().toString(),time:value.toPlainTime().toString({smallestUnit:'minute'})};
  }
  if (dueDateLocal) return {date:dueDateLocal,time:null};
  return null;
}
