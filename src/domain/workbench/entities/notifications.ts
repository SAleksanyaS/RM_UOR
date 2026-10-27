import type { Header, MoscowDate, PositiveInt, UtcInstant, UUIDv4 } from '../primitives';

export type BusinessCalendar = Header & { timeZone: 'Europe/Moscow'; workingWeekdays: (1 | 2 | 3 | 4 | 5 | 6 | 7)[]; exceptions: { date: MoscowDate; working: boolean }[] };
export type ReminderSettings = Header & { calendarId: UUIDv4; dailyAt: string; repeatEveryWorkdays: PositiveInt };
export type PersonalOwner = { installationId: UUIDv4; profilePersonId: UUIDv4 | null };
export type NotificationSubscription = { schemaVersion: 1; id: UUIDv4; owner: PersonalOwner; goalId: UUIDv4; enabled: boolean; createdAt: UtcInstant };
export type NotificationReadState = { schemaVersion: 1; owner: PersonalOwner; eventId: UUIDv4; readAt: UtcInstant | null };
