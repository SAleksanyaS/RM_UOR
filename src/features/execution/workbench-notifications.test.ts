import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createWorkbenchRepository, type WorkbenchRepository } from '../../server/storage/workbench-repository';
import { createNotificationService, resolveNotificationRecipient, startNotificationPolling } from './workbench-notifications';
import { createNotificationStore } from './workbench-notification-store';
import type { BusinessCalendar, ReminderSettings } from '../../domain/workbench/entities';
import type { OwnAccessProfile } from '../identity/workbench-access-policy';
import type { NotificationCause } from './workbench-reminders';
import { newUuid } from '../../domain/workbench/primitives';
import { createCommandStore, withCommandExecution } from '../../server/workbench/command-store';
import { z } from 'zod';
import type { CommandContext } from '../../server/workbench/command-registry';
import { fixtureId, makeEntityGraph } from '../../../tests/fixtures/workbench/factories';
import { seedGraph } from '../../../tests/fixtures/workbench/repository';
const id = '11111111-1111-4111-8111-111111111111';
const person = '22222222-2222-4222-8222-222222222222';
const goal = fixtureId(11);
const other = '44444444-4444-4444-8444-444444444444';
const header = { schemaVersion: 1 as const, id, revision: 1, recordedAt: '2026-10-28T00:00:00Z', actor: { hostname: 'synthetic', installationId: id, profilePersonId: null }, publicationAnchorId: null };
const calendar: BusinessCalendar = { ...header, timeZone: 'Europe/Moscow', workingWeekdays: [1, 2, 3, 4, 5], exceptions: [] };
const settings: ReminderSettings = { ...header, calendarId: id, dailyAt: '09:00', repeatEveryWorkdays: 1 };
const ownAccess: OwnAccessProfile = { role: 'viewer', displayName: null, personId: null, policyState: 'unavailable', checkedAt: null };
const cleanup: (() => void)[] = [];
afterEach(() => { vi.useRealTimers(); for (const close of cleanup.splice(0)) close(); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'uor-notifications-'));
  let repository = createWorkbenchRepository({ filename: join(root, 'database.sqlite'), artifactRoot: join(root, 'artifacts') });
  seedGraph(repository, makeEntityGraph());
  let now = '2026-11-02T06:00:00Z'; let fail = false;
  let causes: NotificationCause[] = [{ provider: 'execution', objectRef: { entityType: 'core_goal_definition', id: goal }, sourceVersion: '1', kind: 'attention', recipientPersonIds: [person, person], route: '/goals/' + goal }];
  const context = (): CommandContext => ({ requestId: id, commandId: id, installationId: id, repository, ownAccess, clock: { now: () => now }, actor: header.actor });
  const options = () => ({ repository, preferences: () => ({ notificationPersonId: null }), provider: { async current() { if (fail) throw new Error('offline'); return { causes, calendar, settings }; } } });
  const commandService = () => {
    const real = createNotificationService(options());
    const run = <T>(ctx: ReturnType<typeof context>, name: string, payload: Record<string, unknown>, execute: (commandContext: ReturnType<typeof context>) => Promise<T>) => {
      const commandContext = { ...ctx, commandId: newUuid() };
      createCommandStore(repository).begin({ commandId: commandContext.commandId, name, baseRevision: null, payload }, commandContext.installationId);
      return withCommandExecution(commandContext, z.record(z.string(), z.unknown()), () => execute(commandContext));
    };
    return { ...real, subscribe: (ctx: ReturnType<typeof context>, input: { goalId: string; subscribed: boolean }) => run(ctx, 'notifications.subscribe', input, context => real.subscribe(context, input)), markRead: (ctx: ReturnType<typeof context>, input: { notificationIds: string[] }) => run(ctx, 'notifications.markRead', input, context => real.markRead(context, input)) };
  };
  let service = commandService();
  cleanup.push(() => { repository.close(); rmSync(root, { recursive: true, force: true }); });
  return { context, get service() { return service; }, repository: () => repository, now: (value: string) => { now = value; }, fail: (value: boolean) => { fail = value; }, causes: (value: NotificationCause[]) => { causes = value; }, reopen() { repository.close(); repository = createWorkbenchRepository({ filename: join(root, 'database.sqlite'), artifactRoot: join(root, 'artifacts') }); service = commandService(); } };
}
describe('local notifications', () => {
  it('registry recipient precedes optional preference without granting identity or role', () => {
    expect(resolveNotificationRecipient({ ownAccess: { ...ownAccess, personId: person }, preferences: { notificationPersonId: other } })).toBe(person);
    expect(resolveNotificationRecipient({ ownAccess, preferences: { notificationPersonId: other } })).toBe(other);
    expect(resolveNotificationRecipient({ ownAccess, preferences: { notificationPersonId: null } })).toBeNull();
    expect(ownAccess.role).toBe('viewer'); expect(ownAccess.personId).toBeNull();
  });
  it('anonymous subscriptions survive restart, dedup polls and preserve read state', async () => {
    const f = fixture(); const before = f.repository().getHead({ entityType: 'core_goal_definition', id: goal });
    await f.service.subscribe(f.context(), { goalId: goal, subscribed: true });
    await f.service.pump(f.context()); await f.service.pump(f.context());
    let events = f.service.list(f.context()); expect(events).toHaveLength(1);
    await f.service.markRead(f.context(), { notificationIds: [events[0].id] });
    f.reopen(); events = f.service.list(f.context()); expect(events[0].readAt).not.toBeNull();
    await f.service.pump(f.context()); expect(f.service.list(f.context())[0].readAt).not.toBeNull();
    expect(f.repository().getHead({ entityType: 'core_goal_definition', id: goal })).toEqual(before);
    expect(f.context().actor.profilePersonId).toBeNull();
  });
  it('missed workdays emit one current reminder and marking read never closes cause', async () => {
    const f = fixture(); await f.service.subscribe(f.context(), { goalId: goal, subscribed: true });
    await f.service.pump(f.context()); f.now('2026-11-10T06:00:00Z');
    await f.service.pump(f.context()); await f.service.pump(f.context());
    const events = f.service.list(f.context()); expect(events).toHaveLength(1); expect(events[0].category).toBe('reminder'); expect(events[0].emittedAt).toBe('2026-11-10T06:00:00Z');
    await f.service.markRead(f.context(), { notificationIds: [events[0].id] });
    f.now('2026-11-11T06:00:00Z'); await f.service.pump(f.context()); expect(f.service.list(f.context())[0].readAt).toBeNull();
  });
  it('foreign installation cannot list or mark own events; batch mark is atomic', async () => {
    const f = fixture(); await f.service.subscribe(f.context(), { goalId: goal, subscribed: true }); await f.service.pump(f.context());
    const event = f.service.list(f.context())[0];
    expect(f.service.list({ ...f.context(), installationId: other })).toEqual([]);
    await expect(f.service.markRead({ ...f.context(), installationId: other }, { notificationIds: [event.id] })).rejects.toMatchObject({ statusCode: 403 });
    await expect(f.service.markRead(f.context(), { notificationIds: [event.id, other] })).rejects.toMatchObject({ statusCode: 403 });
    expect(f.service.list(f.context())[0].readAt).toBeNull();
  });
  it('records personal command effects and durable receipts together', async () => {
    const f = fixture(); await f.service.subscribe(f.context(), { goalId: goal, subscribed: true }); await f.service.pump(f.context());
    await f.service.markRead(f.context(), { notificationIds: [f.service.list(f.context())[0].id] });
    const rows = f.repository().sqlForModule('commands').all<{ receipt_json: string | null }>('SELECT receipt_json FROM wb_commands_intents');
    expect(rows).toHaveLength(2); expect(rows.every(row => row.receipt_json !== null)).toBe(true);
  });
  it('rejects subscriptions to a nonexistent public goal', async () => {
    const f = fixture();
    await expect(f.service.subscribe(f.context(), { goalId: other, subscribed: true })).rejects.toMatchObject({ statusCode: 404 });
  });
  it('offline provider preserves the last state and never invents merged/declined events', async () => {
    const f = fixture(); await f.service.subscribe(f.context(), { goalId: goal, subscribed: true }); await f.service.pump(f.context());
    const previous = f.service.list(f.context()); f.fail(true);
    await expect(f.service.pump(f.context())).rejects.toThrow('offline');
    expect(f.service.list(f.context())).toEqual(previous);
  });
  it('store is restart-safe and addressed recipient duplicates produce one current event', async () => {
    const f = fixture(); const context = { ...f.context(), ownAccess: { ...ownAccess, personId: person } };
    await f.service.pump(context); await f.service.pump(context); expect(f.service.list(context)).toHaveLength(1);
    expect(createNotificationStore({ repository: f.repository() }).list({ installationId: id, profilePersonId: person })).toHaveLength(1);
  });
  it('polling backs off after errors and cancellation ends the lifecycle without another pump', async () => {
    vi.useFakeTimers(); const f = fixture(); const pump = vi.fn().mockRejectedValue(new Error('offline'));
    const polling = startNotificationPolling({ service: { ...f.service, pump }, context: f.context(), pollIntervalMs: 1000, maxBackoffMs: 4000 });
    await vi.advanceTimersByTimeAsync(0); expect(pump).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1999); expect(pump).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(pump).toHaveBeenCalledTimes(2);
    polling.stop(); await polling.finished;
    await vi.advanceTimersByTimeAsync(10000); expect(pump).toHaveBeenCalledTimes(2);
  });
  it('cancellation after provider read prevents a late local write', async () => {
    const f = fixture(); let release!: (value: { causes: NotificationCause[]; calendar: BusinessCalendar; settings: ReminderSettings }) => void;
    const provider = { current: () => new Promise<{ causes: NotificationCause[]; calendar: BusinessCalendar; settings: ReminderSettings }>(resolve => { release = resolve; }) };
    const service = createNotificationService({ repository: f.repository(), preferences: () => ({ notificationPersonId: person }), provider });
    const controller = new AbortController(); const pending = service.pump(f.context(), controller.signal); controller.abort();
    release({ causes: [{ provider: 'execution', objectRef: { entityType: 'core_goal_definition', id: goal }, sourceVersion: '1', kind: 'attention', recipientPersonIds: [person], route: '/goals/' + goal }], calendar, settings });
    await pending; expect(service.list(f.context())).toEqual([]);
  });
});
