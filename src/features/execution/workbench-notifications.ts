import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { BusinessCalendar, PersonalOwner, ReminderSettings } from '../../domain/workbench/entities';
import { uuidSchema, type UUIDv4 } from '../../domain/workbench/primitives';
import type { OwnAccessProfile } from '../identity/workbench-access-policy';
import type { WorkbenchRepository } from '../../server/storage/workbench-repository';
import type { CommandContext, CommandRegistry } from '../../server/workbench/command-registry';
import type { QueryContext } from '../../server/workbench/query-registry';
import { commitCommandEffect } from '../../server/workbench/command-store';
import { WorkbenchHttpError } from '../../server/workbench/protocol';
import { createNotificationStore, type LocalNotification } from './workbench-notification-store';
import { notificationCauseSchema, planReminder, type NotificationCause } from './workbench-reminders';
import { draftDefinitionSchema, type DraftService, type DraftSaveInput } from '../catalog/workbench-drafts';
import { draftSaveResultSchema } from '../catalog/workbench-draft-commands';
import { createCommandStore } from '../../server/workbench/command-store';
import { businessCalendarSchema, reminderSettingsSchema } from '../../domain/workbench/schemas/extensions';

// A projection of personal preferences, not an identity or authorization input.
type RecipientPreferences = Pick<{ notificationPersonId: UUIDv4 | null }, 'notificationPersonId'>;
export function resolveNotificationRecipient(input: { ownAccess: OwnAccessProfile; preferences: RecipientPreferences }): UUIDv4 | null {
  const recipient = input.ownAccess.personId ?? input.preferences.notificationPersonId;
  return recipient === null ? null : uuidSchema.parse(recipient);
}
export type NotificationContext = Pick<QueryContext, 'installationId' | 'ownAccess' | 'clock'>;
export interface NotificationProvider {
  /** Read current causes only. This is called by lifecycle pump, never by list/read queries. */
  current(context: NotificationContext, signal?: AbortSignal): Promise<{ causes: NotificationCause[]; calendar: BusinessCalendar; settings: ReminderSettings }>;
}
export interface NotificationService {
  pump(context: NotificationContext, signal?: AbortSignal): Promise<void>;
  markRead(context: CommandContext, input: { notificationIds: UUIDv4[] }): Promise<{ notificationIds: UUIDv4[] }>;
  subscribe(context: CommandContext, input: { goalId: UUIDv4; subscribed: boolean }): Promise<{ goalId: UUIDv4; subscribed: boolean }>;
  list(context: NotificationContext): LocalNotification[];
}
const own = (context: NotificationContext): PersonalOwner => ({ installationId: context.installationId, profilePersonId: context.ownAccess.personId });
const dedup = (cause: NotificationCause, recipient: UUIDv4 | null): string => createHash('sha256').update(JSON.stringify([cause.provider, cause.objectRef.entityType, cause.objectRef.id, cause.sourceVersion, cause.kind, recipient])).digest('hex');

export function createNotificationService(options: { repository: WorkbenchRepository; provider: NotificationProvider; preferences: (installationId: UUIDv4) => RecipientPreferences; resolveOwnAccess?: () => Promise<OwnAccessProfile> }): NotificationService {
  const store = createNotificationStore(options);
  // Concurrent lifecycle ticks for one owner share preparation, never duplicate an event.
  const pumping = new Map<string, Promise<void>>();
  return {
    async pump(context, signal) {
      if (signal?.aborted) return;
      context = { ...context, ownAccess: { ...context.ownAccess } };
      const owner = own(context); const key = JSON.stringify(owner);
      const inFlight = pumping.get(key); if (inFlight) return inFlight;
      const action = (async () => {
        // Complete network/provider preparation before the short local transaction.
        const snapshot = await options.provider.current(context, signal);
        if (signal?.aborted) return;
        if (options.resolveOwnAccess && (await options.resolveOwnAccess()).personId !== context.ownAccess.personId) return;
        if (signal?.aborted) return;
        const recipient = resolveNotificationRecipient({ ownAccess: context.ownAccess, preferences: options.preferences(context.installationId) });
        businessCalendarSchema.parse(snapshot.calendar); reminderSettingsSchema.parse(snapshot.settings);
        if (snapshot.settings.calendarId !== snapshot.calendar.id) throw new WorkbenchHttpError(422, 'REMINDER_CALENDAR_MISMATCH', 'Reminder settings reference another calendar');
        const causes = z.array(notificationCauseSchema).parse(snapshot.causes);
        const now = context.clock.now();
        const eligible = causes.filter(cause => (recipient !== null && cause.recipientPersonIds.includes(recipient)) || [...new Set([...(cause.goalIds ?? []), ...(cause.objectRef.entityType === 'core_goal_definition' ? [cause.objectRef.id] : [])])].some(id => store.isSubscribed(owner, id)));
        // Validate the entire snapshot before recording any part of it.
        const plans = eligible.map(cause => {
          const causeKey = dedup(cause, recipient); const existing = store.find(owner, causeKey);
          const reminder = planReminder({ now, calendar: snapshot.calendar, settings: snapshot.settings, lastSentAt: existing?.emittedAt ?? null, cause });
          return { causeKey, cause: { ...cause, recipientPersonIds: [...new Set(cause.recipientPersonIds)] }, category: existing ? reminder ? 'reminder' as const : null : cause.kind === 'error' ? 'error' as const : 'new' as const };
        });
        options.repository.transaction(() => {
          const seen = new Set<string>();
          for (const plan of plans) if (plan.category && !seen.has(plan.causeKey)) { seen.add(plan.causeKey); store.record(owner, plan.causeKey, plan.cause, plan.category, now); }
        });
      })();
      pumping.set(key, action);
      try { await action; } finally { pumping.delete(key); }
    },
    async markRead(context, input) {
      const validated = z.strictObject({ notificationIds: z.array(uuidSchema).max(200) }).parse(input);
      if (context.repository !== options.repository) throw new Error('Notification repository context mismatch');
      return commitCommandEffect(context, () => {
        store.markRead(own(context), validated.notificationIds, context.clock.now());
        return { result: { notificationIds: [...new Set(validated.notificationIds)] }, changedRefs: [], editToken: null };
      }).result;
    },
    async subscribe(context, input) {
      const validated = z.strictObject({ goalId: uuidSchema, subscribed: z.boolean() }).parse(input);
      if (context.repository !== options.repository) throw new Error('Notification repository context mismatch');
      return commitCommandEffect(context, () => {
        if (!options.repository.readPublishedHead({ entityType: 'core_goal_definition', id: validated.goalId })) throw new WorkbenchHttpError(404, 'GOAL_NOT_FOUND', 'Published goal is unavailable');
        store.subscribe(own(context), validated.goalId, validated.subscribed);
        return { result: validated, changedRefs: [], editToken: null };
      }).result;
    },
    list(context) { return store.list(own(context)); },
  };
}

/** Calendar/reminder drafts are registered by T17's actual DraftService, when available. */
export function registerNotificationCommands(registry: CommandRegistry, service: NotificationService, options: { drafts?: DraftService } = {}): void {
  const markSchema = z.strictObject({ notificationIds: z.array(uuidSchema).max(200) });
  const subscribeSchema = z.strictObject({ goalId: uuidSchema, subscribed: z.boolean() });
  registry.register({ name: 'notifications.markRead', inputSchema: markSchema, outputSchema: markSchema, capability: 'personal.write', ownership: 'person-if-present', effect: 'local', execution: 'sync', async handler(context, input) { return { result: await service.markRead(context, input), changedRefs: [], editToken: null }; } });
  registry.register({ name: 'notifications.subscribe', inputSchema: subscribeSchema, outputSchema: subscribeSchema, capability: 'personal.write', ownership: 'person-if-present', effect: 'local', execution: 'sync', async handler(context, input) { return { result: await service.subscribe(context, input), changedRefs: [], editToken: null }; } });
  const drafts = options.drafts;
  if (drafts) {
    drafts.registerOwnerPolicy(['business_calendar','reminder_settings'], { initialDefinition(type) { return type === 'reminder_settings' ? { dailyAt: '09:00', repeatEveryWorkdays: 1 } : { timeZone: 'Europe/Moscow' }; } });
    registry.register({ name: 'reminders.draft.save', inputSchema: z.strictObject({ draftId: uuidSchema, definition: z.union([draftDefinitionSchema('business_calendar'), draftDefinitionSchema('reminder_settings')]) }), outputSchema: draftSaveResultSchema, capability: 'uor.prepare', ownership: 'person', effect: 'sharedDraft', execution: 'sync', async handler(context, input) {
      await drafts.saveDefinition(context, input as DraftSaveInput, ['business_calendar','reminder_settings']);
      const receipt = createCommandStore(context.repository).get(context.installationId, context.commandId)?.receipt_json;
      if (!receipt) throw Error('Reminder draft effect did not commit its receipt'); return JSON.parse(receipt);
    } });
  }
}

/** The application starts this while open and stops it on shutdown; list() never starts polling. */
export function startNotificationPolling(options: {
  service: NotificationService; context: NotificationContext | (() => Promise<NotificationContext>); pollIntervalMs?: number; maxBackoffMs?: number;
  onError?: (error: unknown) => void;
}): { stop(): void; finished: Promise<void> } {
  const interval = options.pollIntervalMs ?? 15000;
  const maximum = options.maxBackoffMs ?? 60000;
  if (!Number.isInteger(interval) || interval < 1000 || interval > 60000 || !Number.isInteger(maximum) || maximum < interval || maximum > 300000) throw new Error('Invalid notification polling bounds');
  const controller = new AbortController();
  const cancelled = Symbol('notification-polling-cancelled');
  // Stop does not depend on a registry/provider promise cooperating. Attach both
  // continuations so a late rejection is observed after the lifecycle has ended.
  const cancellable = <T>(pending: Promise<T>): Promise<T | typeof cancelled> => new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => { controller.signal.removeEventListener('abort', onAbort); };
    const onAbort = () => { if (!settled) { settled = true; cleanup(); resolve(cancelled); } };
    controller.signal.addEventListener('abort', onAbort, { once: true });
    pending.then(value => { if (!settled) { settled = true; cleanup(); resolve(value); } }, error => { if (!settled) { settled = true; cleanup(); reject(error); } });
    if (controller.signal.aborted) onAbort();
  });
  const wait = (delay: number) => new Promise<void>(resolve => {
    const done = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, delay);
    controller.signal.addEventListener('abort', done, { once: true });
    if (controller.signal.aborted) done();
  });
  const finished = (async () => {
    let delay = interval;
    while (!controller.signal.aborted) {
      try {
        const context = typeof options.context === 'function' ? await cancellable(options.context()) : options.context;
        if (context === cancelled || controller.signal.aborted) break;
        if (await cancellable(options.service.pump(context, controller.signal)) === cancelled) break;
        delay = interval;
      }
      catch (error) { delay = Math.min(maximum, delay * 2); options.onError?.(error); }
      if (!controller.signal.aborted) await wait(delay);
    }
  })();
  return { stop() { controller.abort(); }, finished };
}
