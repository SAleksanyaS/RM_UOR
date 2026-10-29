import { describe, expect, it } from 'vitest';
import type { BusinessCalendar, ReminderSettings } from '../../domain/workbench/entities';
import { isDeadlineOverdue, planReminder, type NotificationCause } from './workbench-reminders';
const id = '11111111-1111-4111-8111-111111111111';
const header = { schemaVersion: 1 as const, id, revision: 1, recordedAt: '2026-10-28T00:00:00Z', actor: { hostname: 'synthetic', installationId: id, profilePersonId: null }, publicationAnchorId: null };
export const calendar: BusinessCalendar = { ...header, timeZone: 'Europe/Moscow', workingWeekdays: [1, 2, 3, 4, 5], exceptions: [] };
export const settings: ReminderSettings = { ...header, calendarId: id, dailyAt: '09:00', repeatEveryWorkdays: 1 };
export const cause: NotificationCause = { provider: 'execution', objectRef: { entityType: 'decision', id }, sourceVersion: '1', kind: 'overdue', recipientPersonIds: [id, id], route: '/execution/decisions/' + id };
describe('Moscow reminders', () => {
  it('deadline ends at Moscow midnight without shifting weekend deadlines', () => {
    expect(isDeadlineOverdue('2026-10-30', '2026-10-30T20:59:59Z')).toBe(false);
    expect(isDeadlineOverdue('2026-10-30', '2026-10-30T21:00:00Z')).toBe(true);
    expect(isDeadlineOverdue('2026-10-31', '2026-10-31T21:00:00Z')).toBe(true);
  });
  it('waits until nine on a workday and never repeats the same local day', () => {
    const input = { calendar, settings, cause, lastSentAt: null };
    expect(planReminder({ ...input, now: '2026-11-02T05:59:59Z' })).toBeNull();
    expect(planReminder({ ...input, now: '2026-11-02T06:00:00Z' })).toMatchObject({ localDate: '2026-11-02' });
    expect(planReminder({ ...input, now: '2026-11-02T20:00:00Z', lastSentAt: '2026-11-02T06:00:00Z' })).toBeNull();
    expect(planReminder({ ...input, now: '2026-11-01T06:00:00Z' })).toBeNull();
  });
  it('uses date exceptions and repeat intervals without creating missed-day backlog', () => {
    const workingSunday = { ...calendar, exceptions: [{ date: '2026-11-01', working: true }] };
    expect(planReminder({ calendar: workingSunday, settings, cause, now: '2026-11-01T06:00:00Z', lastSentAt: null })).not.toBeNull();
    expect(planReminder({ calendar, settings: { ...settings, repeatEveryWorkdays: 2 }, cause, now: '2026-11-03T06:00:00Z', lastSentAt: '2026-11-02T06:00:00Z' })).toBeNull();
    expect(planReminder({ calendar, settings, cause, now: '2026-11-10T06:00:00Z', lastSentAt: '2026-11-02T06:00:00Z' })).toMatchObject({ localDate: '2026-11-10' });
  });
  it('rejects duplicate dates, invalid times, mismatched calendar and unsafe routes', () => {
    const input = { calendar, settings, cause, now: '2026-11-02T06:00:00Z', lastSentAt: null };
    expect(() => planReminder({ ...input, calendar: { ...calendar, exceptions: [{ date: '2026-11-02', working: true }, { date: '2026-11-02', working: false }] } })).toThrow();
    expect(() => planReminder({ ...input, settings: { ...settings, dailyAt: '25:00' } })).toThrow();
    expect(() => planReminder({ ...input, settings: { ...settings, calendarId: '22222222-2222-4222-8222-222222222222' } })).toThrow();
    expect(() => planReminder({ ...input, cause: { ...cause, route: 'javascript:alert(1)' } })).toThrow();
  });
  it('one_off_causes_have_no_planned_daily_reminder', () => {
    expect(planReminder({ calendar, settings, cause: { ...cause, recurring: false }, now: '2026-11-02T06:00:00Z', lastSentAt: '2026-10-23T06:00:00Z' })).toBeNull();
  });
});
