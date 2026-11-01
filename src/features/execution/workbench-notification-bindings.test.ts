import { afterEach, expect, it, vi } from 'vitest';
import type { CoreGoalDefinition, Work } from '../../domain/workbench/entities';
import { business, draftCleanups, draftFixture } from '../../../tests/fixtures/workbench/drafts';
import { fixtureId, makeEntityGraph, makeHeader, makeNumericFixture, makePublicationAnchor } from '../../../tests/fixtures/workbench/factories';
import { seedGraph } from '../../../tests/fixtures/workbench/repository';
import { createWorkbenchApp } from '../../server/workbench/app';
import { QueryRegistry } from '../../server/workbench/query-registry';
import { createLocalSessionStore } from '../../server/workbench/session';
import { createExecutionNotificationSource, createNotificationProvider } from './workbench-notification-causes';
import { createNotificationRuntime } from './workbench-notification-runtime';
import { createNotificationService, registerNotificationCommands } from './workbench-notifications';

afterEach(async () => { vi.useRealTimers(); while (draftCleanups.length) await draftCleanups.pop()!(); });
function fixture() {
  const f = draftFixture(); const anchor = makePublicationAnchor().id;
  const calendar = { ...makeHeader(150000), publicationAnchorId: anchor, timeZone: 'Europe/Moscow' as const, workingWeekdays: [1,2,3,4,5] as (1|2|3|4|5)[], exceptions: [] };
  const settings = { ...makeHeader(150001), publicationAnchorId: anchor, calendarId: calendar.id, dailyAt: '09:00', repeatEveryWorkdays: 1 };
  const work: Work = { ...makeHeader(150002), publicationAnchorId: anchor, title: 'Prepare', goalIds: [f.input.goal.id], responsibility: [{ scope: f.input.assignment.scope, personId: fixtureId(17) }], state: 'in_progress', dueOn: '2026-10-30', forecastOn: '2026-11-05', nextAction: 'Verify', reason: null, resultDescription: null, evidenceIds: [], risk: { reason: 'Delayed supplier', helpNeeded: 'Escalation' }, blocker: null };
  f.repository.transaction(() => { f.repository.append('business_calendar', calendar, null); f.repository.append('reminder_settings', settings, null); f.repository.append('work', work, null); });
  const source = createExecutionNotificationSource({ repository: f.repository });
  const provider = createNotificationProvider({ repository: f.repository, settingsRef: { entityType: 'reminder_settings', id: settings.id }, sources: [source] });
  const service = createNotificationService({ repository: f.repository, provider, preferences: () => ({ notificationPersonId: null }) });
  return { ...f, drafts: f.service, calendar, settings, work, source, provider, service };
}

it('published_work_causes_deduplicate_recipients_and_never_notify_unpublished_private_edits', async () => {
  const f = fixture(); const before = f.repository.getStateRevision();
  const causes = await f.source.current(f.context);
  expect(f.repository.getStateRevision()).toBe(before);
  expect(causes).toEqual([expect.objectContaining({ provider: 'execution', objectRef: { entityType: 'work', id: f.work.id }, sourceVersion: '1', kind: 'work_risk', recipientPersonIds: [fixtureId(17)], goalIds: [f.input.goal.id], recurring: true })]);
  f.repository.append('work', { ...f.work, revision: 2, publicationAnchorId: null, title: 'PRIVATE', risk: null, blocker: 'Private blocker' }, 1);
  expect(await f.source.current(f.context)).toEqual(causes);
  expect(f.count('observed_fact')).toBe(0); expect(f.count('attestation')).toBe(0);
  expect(f.repository.getStateRevision()).not.toBe(before); // only the explicit test append wrote state
});

it('a_goal_subscriber_without_person_receives_one_work_event_even_when_following_multiple_linked_goals', async () => {
  const f = fixture(); registerNotificationCommands(f.registry, f.service, { drafts: f.drafts });
  const other = makeNumericFixture({ seedBase: 3000 }); seedGraph(f.repository, makeEntityGraph(other));
  f.repository.append('work', { ...f.work, revision: 2, goalIds: [f.input.goal.id, other.goal.id] }, 1);
  // Runtime recipient has no identity; subscription remains personal technical state.
  f.context.ownAccess.personId = null; f.context.actor.profilePersonId = null; f.context.ownAccess.role = 'viewer';
  await f.execute('notifications.subscribe', { goalId: f.input.goal.id, subscribed: true });
  await f.execute('notifications.subscribe', { goalId: other.goal.id, subscribed: true });
  const before = f.repository.readPublishedHead<CoreGoalDefinition>({ entityType: 'core_goal_definition', id: f.input.goal.id });
  await f.service.pump(f.context); await f.service.pump(f.context);
  const events = f.service.list(f.context); expect(events).toHaveLength(1); expect(events[0].cause.objectRef.entityType).toBe('work');
  await f.execute('notifications.markRead', { notificationIds: [events[0].id] });
  expect(f.service.list(f.context)[0].readAt).not.toBeNull(); expect(f.repository.readPublishedHead({ entityType: 'core_goal_definition', id: f.input.goal.id })).toEqual(before);
  expect(f.context.actor.profilePersonId).toBeNull(); expect(f.context.ownAccess.role).toBe('viewer');
});

it('decision_request_is_one_off_but_overdue_state_starts_at_moscow_midnight', async () => {
  const f = fixture();
  f.repository.append('decision', { ...makeHeader(150010), publicationAnchorId: makePublicationAnchor().id, workId: f.work.id, request: 'Choose', requestedFromPersonId: fixtureId(17), dueOn: '2026-10-30', answer: null, answeredAt: null }, null);
  f.setNow('2026-10-30T20:59:59Z');
  expect((await f.source.current(f.context)).filter(c => c.objectRef.entityType === 'decision')).toEqual([expect.objectContaining({ kind: 'decision_requested', recurring: false })]);
  f.setNow('2026-10-30T21:00:00Z');
  expect((await f.source.current(f.context)).filter(c => c.objectRef.entityType === 'decision')).toEqual([expect.objectContaining({ kind: 'decision_requested' }), expect.objectContaining({ kind: 'decision_overdue', recurring: true })]);
});

it('closing_the_shared_work_stops_daily_reminders_without_deleting_old_events', async () => {
  const f = fixture(); await f.service.pump(f.context); const old = f.service.list(f.context)[0];
  f.repository.append('work', { ...f.work, revision: 2, state: 'completed', resultDescription: 'Done' }, 1);
  f.setNow('2026-11-02T06:00:00Z'); await f.service.pump(f.context);
  expect(f.service.list(f.context)).toEqual([old]);
});

it('one_off_verified_events_never_turn_into_daily_reminders_and_provider_failure_preserves_state', async () => {
  const f = fixture(); let offline = false;
  const extra = { id: 'publication', async current() { if (offline) throw Error('offline'); return [{ provider: 'publication', objectRef: { entityType: 'core_goal_definition', id: f.input.goal.id }, sourceVersion: 'verified-main-1', kind: 'main_updated', recipientPersonIds: [fixtureId(17)], route: '/overview', recurring: false }]; } };
  const provider = createNotificationProvider({ repository: f.repository, settingsRef: { entityType: 'reminder_settings', id: f.settings.id }, sources: [extra] });
  const service = createNotificationService({ repository: f.repository, provider, preferences: () => ({ notificationPersonId: null }) });
  await service.pump(f.context); const events = service.list(f.context); expect(events).toHaveLength(1);
  f.setNow('2026-11-02T06:00:00Z'); await service.pump(f.context); expect(service.list(f.context)).toEqual(events);
  offline = true; await expect(service.pump(f.context)).rejects.toThrow('offline'); expect(service.list(f.context)).toEqual(events);
});

it('profiled_notification_commands_cannot_replay_in_another_profile', async () => {
  const f = fixture(); registerNotificationCommands(f.registry, f.service);
  const commandId = fixtureId(150020); const payload = { goalId: f.input.goal.id, subscribed: true }; const baseRevision = f.token();
  await f.execute('notifications.subscribe', payload, { commandId, baseRevision });
  f.context.ownAccess.personId = fixtureId(150021); f.context.actor.profilePersonId = fixtureId(150021);
  await expect(f.execute('notifications.subscribe', payload, { commandId, baseRevision })).rejects.toMatchObject({ statusCode: 404 });
});

it('reminder_drafts_have_explicit_defaults_and_do_not_change_published_configuration', async () => {
  const f = fixture(); registerNotificationCommands(f.registry, f.service, { drafts: f.drafts });
  const calendar = await f.open('business_calendar'), settings = await f.open('reminder_settings');
  expect(f.store.getEntry(settings.draftId)!.definition).toEqual({ dailyAt: '09:00', repeatEveryWorkdays: 1 });
  await f.execute('reminders.draft.save', { draftId: calendar.draftId, definition: { timeZone: 'Europe/Moscow', workingWeekdays: [1,2,3,4,5], exceptions: [{ date: '2026-11-01', working: true }] } });
  await f.execute('reminders.draft.save', { draftId: settings.draftId, definition: { ...f.store.getEntry(settings.draftId)!.definition, calendarId: calendar.objectId } });
  expect(f.drafts.validateDraftPackage(f.packageId())).toMatchObject({ complete: true, problems: [] });
  expect(f.repository.readPublishedHead({ entityType: 'reminder_settings', id: f.settings.id })).toEqual(f.settings);
  await f.execute('reminders.draft.save', { draftId: settings.draftId, definition: { calendarId: calendar.objectId } });
  expect(f.store.getEntry(settings.draftId)!.definition).toEqual({ calendarId: calendar.objectId });
  expect(f.drafts.validateDraftPackage(f.packageId()).complete).toBe(false);
});

it('application_lifecycle_starts_real_pumping_and_stops_it_on_close', async () => {
  vi.useFakeTimers(); const f = fixture();
  const runtime = createNotificationRuntime({ repository: f.repository, clock: f.clock, installationId: f.context.installationId, accessPolicy: f.policy, commands: f.registry, provider: f.provider, preferences: () => ({ notificationPersonId: null }), pollIntervalMs: 1000 });
  const app = await createWorkbenchApp({ repository: f.repository, clock: f.clock, installationId: f.context.installationId, hostname: () => 'synthetic-host', accessPolicy: f.policy, commands: f.registry, queries: new QueryRegistry(), jobs: f.jobs, modules: [], sessions: createLocalSessionStore({ clock: f.clock }), allowedOrigins: ['http://localhost'], files: f.files, notifications: runtime });
  try {
    await vi.advanceTimersByTimeAsync(0); expect(runtime.service.list(f.context)).toHaveLength(1);
    f.repository.append('work', { ...f.work, revision: 2, risk: { reason: 'Changed risk', helpNeeded: 'Help' } }, 1);
    await app.inject({ method: 'GET', url: '/api/v1/session', headers: { host: 'localhost' } });
    expect(runtime.service.list(f.context)).toHaveLength(1);
  } finally { await app.close(); }
  f.repository.append('work', { ...f.work, revision: 3, blocker: 'New blocker' }, 2);
  await vi.advanceTimersByTimeAsync(5000); expect(runtime.service.list(f.context)).toHaveLength(1);
});

it('a_profile_change_during_provider_read_discards_the_old_persons_pending_delivery', async () => {
  const f = fixture(); const snapshot = await f.provider.current(f.context); const original = { ...f.context, ownAccess: { ...f.context.ownAccess } };
  let release!: (value: typeof snapshot) => void;
  const service = createNotificationService({ repository: f.repository, provider: { current: () => new Promise(resolve => { release = resolve; }) }, preferences: () => ({ notificationPersonId: null }), resolveOwnAccess: () => f.policy.resolveOwnAccess() });
  const pending = service.pump(f.context);
  f.context.ownAccess.personId = null; f.context.actor.profilePersonId = null;
  release(snapshot); await pending;
  expect(service.list(original)).toEqual([]); expect(service.list(f.context)).toEqual([]);
});

it('each_lifecycle_tick_resolves_the_current_profile_instead_of_reusing_an_old_grant', async () => {
  vi.useFakeTimers(); const f = fixture(); const original = { ...f.context, ownAccess: { ...f.context.ownAccess } };
  const runtime = createNotificationRuntime({ repository: f.repository, clock: f.clock, installationId: f.context.installationId, accessPolicy: f.policy, commands: f.registry, provider: f.provider, preferences: () => ({ notificationPersonId: null }), pollIntervalMs: 1000 });
  runtime.start();
  try {
    await vi.advanceTimersByTimeAsync(0); expect(runtime.service.list(original)).toHaveLength(1);
    f.context.ownAccess.personId = fixtureId(150021); f.context.actor.profilePersonId = fixtureId(150021);
    f.repository.append('work', { ...f.work, revision: 2, blocker: 'Changed' }, 1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(runtime.service.list(original)).toHaveLength(1); expect(runtime.service.list(f.context)).toEqual([]);
  } finally { await runtime.stop(); }
});

it('only_published_calendar_settings_change_the_next_reminder_time', async () => {
  const f = fixture(); f.repository.append('work', { ...f.work, revision: 2, dueOn: '2026-12-30' }, 1);
  await f.service.pump(f.context); const original = f.service.list(f.context)[0];
  f.repository.append('reminder_settings', { ...f.settings, revision: 2, dailyAt: '10:00' }, 1);
  f.repository.append('reminder_settings', { ...f.settings, revision: 3, dailyAt: '00:00', publicationAnchorId: null }, 2);
  f.setNow('2026-11-02T06:00:00Z'); await f.service.pump(f.context); expect(f.service.list(f.context)).toEqual([original]);
  f.setNow('2026-11-02T07:00:00Z'); await f.service.pump(f.context);
  expect(f.service.list(f.context)).toHaveLength(1); expect(f.service.list(f.context)[0]).toMatchObject({ category: 'reminder', emittedAt: '2026-11-02T07:00:00Z' });
});

it('invalid_calendar_configuration_is_rejected_even_for_one_off_events', async () => {
  const f = fixture(); const snapshot = await f.provider.current(f.context);
  const service = createNotificationService({ repository: f.repository, provider: { async current() { return { ...snapshot, settings: { ...snapshot.settings, dailyAt: '25:00' }, causes: snapshot.causes.map(cause => ({ ...cause, recurring: false })) }; } }, preferences: () => ({ notificationPersonId: null }) });
  await expect(service.pump(f.context)).rejects.toThrow(); expect(service.list(f.context)).toEqual([]);
});

it('an_invalid_additional_source_prevents_partial_delivery_and_missing_config_is_explicit', async () => {
  const f = fixture();
  const provider = createNotificationProvider({ repository: f.repository, settingsRef: { entityType: 'reminder_settings', id: f.settings.id }, sources: [f.source, { id: 'publication', async current() { return [{ provider: 'publication', objectRef: { entityType: 'core_goal_definition', id: f.input.goal.id }, sourceVersion: 'unknown', kind: 'main_updated', recipientPersonIds: [fixtureId(17)], route: 'javascript:unsafe', recurring: false }]; } }] });
  const service = createNotificationService({ repository: f.repository, provider, preferences: () => ({ notificationPersonId: null }) });
  await expect(service.pump(f.context)).rejects.toThrow(); expect(service.list(f.context)).toEqual([]);
  const missing = createNotificationProvider({ repository: f.repository, settingsRef: { entityType: 'reminder_settings', id: fixtureId(150040) }, sources: [f.source] });
  await expect(missing.current(f.context)).rejects.toMatchObject({ code: 'REMINDER_SETTINGS_UNAVAILABLE' });
});

it('cancelled_work_stops_its_open_decision_notifications_without_answering_or_deleting_it', async () => {
  const f = fixture(); const decision = { ...makeHeader(150060), publicationAnchorId: makePublicationAnchor().id, workId: f.work.id, request: 'Choose', requestedFromPersonId: fixtureId(17), dueOn: '2026-10-30', answer: null, answeredAt: null };
  f.repository.append('decision', decision, null); f.setNow('2026-11-02T06:00:00Z');
  await f.service.pump(f.context); const original = f.service.list(f.context); expect(original.some(event => event.cause.kind === 'decision_overdue')).toBe(true);
  f.repository.append('work', { ...f.work, revision: 2, state: 'cancelled', reason: 'No longer needed' }, 1);
  f.setNow('2026-11-03T06:00:00Z'); await f.service.pump(f.context);
  expect(f.service.list(f.context)).toEqual(original);
  expect(f.repository.readPublishedHead({ entityType: 'decision', id: decision.id })).toEqual(decision);
  f.repository.append('work', { ...f.work, revision: 3, state: 'completed', resultDescription: 'Other work done' }, 2);
  expect((await f.source.current(f.context)).some(cause => cause.kind === 'decision_overdue')).toBe(true); // a completed work does not answer a genuine open decision
});

it('runtime_stop_does_not_wait_for_a_hung_profile_lookup_or_start_a_late_pump', async () => {
  vi.useFakeTimers(); const f = fixture(); const access = { ...f.context.ownAccess }; let release!: (value: typeof access) => void;
  f.policy.resolveOwnAccess = () => new Promise(resolve => { release = resolve; });
  const runtime = createNotificationRuntime({ repository: f.repository, clock: f.clock, installationId: f.context.installationId, accessPolicy: f.policy, commands: f.registry, provider: f.provider, preferences: () => ({ notificationPersonId: null }), pollIntervalMs: 1000 });
  runtime.start(); await vi.advanceTimersByTimeAsync(0);
  let stopped = false; const stopping = runtime.stop().then(() => { stopped = true; });
  try { await vi.advanceTimersByTimeAsync(0); expect(stopped).toBe(true); }
  finally { release(access); await stopping; }
  expect(runtime.service.list(f.context)).toEqual([]);
});

it('application_close_is_bounded_during_provider_wait_and_late_delivery_is_discarded', async () => {
  vi.useFakeTimers(); const f = fixture(); const snapshot = await f.provider.current(f.context); let release!: (value: typeof snapshot) => void;
  const runtime = createNotificationRuntime({ repository: f.repository, clock: f.clock, installationId: f.context.installationId, accessPolicy: f.policy, commands: f.registry, provider: { current: () => new Promise(resolve => { release = resolve; }) }, preferences: () => ({ notificationPersonId: null }), pollIntervalMs: 1000 });
  const app = await createWorkbenchApp({ repository: f.repository, clock: f.clock, installationId: f.context.installationId, hostname: () => 'synthetic-host', accessPolicy: f.policy, commands: f.registry, queries: new QueryRegistry(), jobs: f.jobs, modules: [], sessions: createLocalSessionStore({ clock: f.clock }), allowedOrigins: ['http://localhost'], files: f.files, notifications: runtime });
  await vi.advanceTimersByTimeAsync(0); let closed = false; const closing = app.close().then(() => { closed = true; });
  try { await vi.advanceTimersByTimeAsync(0); expect(closed).toBe(true); }
  finally { release(snapshot); await closing; await vi.advanceTimersByTimeAsync(0); }
  expect(runtime.service.list(f.context)).toEqual([]);
});

it('stop_cancels_the_post_provider_identity_wait_and_handles_its_late_failure', async () => {
  vi.useFakeTimers(); const f = fixture(); const access = { ...f.context.ownAccess }; let reads = 0, failLater!: (reason: Error) => void;
  f.policy.resolveOwnAccess = async () => ++reads === 1 ? access : new Promise((_resolve, reject) => { failLater = reject; });
  const runtime = createNotificationRuntime({ repository: f.repository, clock: f.clock, installationId: f.context.installationId, accessPolicy: f.policy, commands: f.registry, provider: f.provider, preferences: () => ({ notificationPersonId: null }), pollIntervalMs: 1000 });
  runtime.start(); await vi.advanceTimersByTimeAsync(0); expect(reads).toBe(2);
  let stopped = false; const stopping = runtime.stop().then(() => { stopped = true; });
  try { await vi.advanceTimersByTimeAsync(0); expect(stopped).toBe(true); }
  finally { failLater(new Error('Late lookup failure')); await stopping; await vi.advanceTimersByTimeAsync(0); }
  expect(runtime.service.list(f.context)).toEqual([]);
});
