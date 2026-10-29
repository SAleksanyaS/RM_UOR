import { z } from 'zod';
import type { BusinessCalendar, ReminderSettings } from '../../domain/workbench/entities';
import { entityRefSchema, moscowDateSchema, utcInstantSchema, uuidSchema, type EntityRef, type MoscowDate, type UtcInstant, type UUIDv4 } from '../../domain/workbench/primitives';
import { businessCalendarSchema, reminderSettingsSchema } from '../../domain/workbench/schemas/extensions';
import { moscowEnd } from '../../domain/workbench/time';

export type NotificationCause = { provider: string; objectRef: EntityRef; sourceVersion: string; kind: string; recipientPersonIds: UUIDv4[]; route: string; goalIds?: UUIDv4[]; recurring?: boolean };
export type ReminderPlan = { localDate: MoscowDate; cause: NotificationCause };
export const notificationCauseSchema = z.strictObject({
  provider: z.string().min(1), objectRef: entityRefSchema, sourceVersion: z.string().min(1), kind: z.string().min(1), recipientPersonIds: z.array(uuidSchema),
  goalIds: z.array(uuidSchema).optional(), recurring: z.boolean().optional(),
  route: z.string().refine(route => {
    if (route.startsWith('/') && !route.startsWith('//') && !route.includes('\\')) return true;
    try { const url = new URL(route); return url.protocol === 'https:' && !url.username && !url.password; } catch { return false; }
  }, 'Expected an internal route or credential-free HTTPS URL'),
});
export function moscowLocalDate(instant: UtcInstant): MoscowDate { utcInstantSchema.parse(instant); return new Date(Date.parse(instant) + 10_800_000).toISOString().slice(0, 10); }
function weekday(date: MoscowDate): BusinessCalendar['workingWeekdays'][number] { const day = new Date(date + 'T00:00:00Z').getUTCDay(); return (day || 7) as BusinessCalendar['workingWeekdays'][number]; }
export function isWorkingDate(date: MoscowDate, calendar: BusinessCalendar): boolean {
  moscowDateSchema.parse(date);
  return calendar.exceptions.find(item => item.date === date)?.working ?? calendar.workingWeekdays.includes(weekday(date));
}
export function isDeadlineOverdue(dueOn: MoscowDate | null, now: UtcInstant): boolean {
  utcInstantSchema.parse(now);
  return dueOn !== null && Date.parse(now) > Date.parse(moscowEnd(dueOn));
}
function elapsedWorkingDays(startExclusive: MoscowDate, endInclusive: MoscowDate, calendar: BusinessCalendar): number {
  const start = Date.parse(startExclusive + 'T00:00:00Z');
  const days = Math.floor((Date.parse(endInclusive + 'T00:00:00Z') - start) / 86_400_000);
  if (days <= 0) return 0;
  const wholeWeeks = Math.floor(days / 7);
  let count = wholeWeeks * calendar.workingWeekdays.length;
  for (let index = wholeWeeks * 7 + 1; index <= days; index++) if (calendar.workingWeekdays.includes(weekday(new Date(start + index * 86_400_000).toISOString().slice(0, 10)))) count++;
  for (const exception of calendar.exceptions) if (exception.date > startExclusive && exception.date <= endInclusive) count += Number(exception.working) - Number(calendar.workingWeekdays.includes(weekday(exception.date)));
  return count;
}

/** One current occurrence; a missed week never produces a queue of historical reminders. */
export function planReminder(input: { now: UtcInstant; calendar: BusinessCalendar; settings: ReminderSettings; lastSentAt: UtcInstant | null; cause: NotificationCause }): ReminderPlan | null {
  const calendar = businessCalendarSchema.parse(input.calendar);
  const settings = reminderSettingsSchema.parse(input.settings);
  const cause = notificationCauseSchema.parse(input.cause);
  if (settings.calendarId !== calendar.id) throw new Error('Reminder settings reference another calendar');
  if (cause.recurring === false) return null;
  const localDate = moscowLocalDate(input.now);
  const localTime = new Date(Date.parse(input.now) + 10_800_000).toISOString().slice(11, 16);
  if (!isWorkingDate(localDate, calendar) || localTime < settings.dailyAt) return null;
  if (input.lastSentAt !== null) {
    const lastDate = moscowLocalDate(input.lastSentAt);
    if (lastDate >= localDate || elapsedWorkingDays(lastDate, localDate, calendar) < settings.repeatEveryWorkdays) return null;
  }
  return { localDate, cause: { ...cause, recipientPersonIds: [...new Set(cause.recipientPersonIds)] } };
}
