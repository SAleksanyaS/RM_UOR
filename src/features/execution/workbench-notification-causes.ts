import type { CoreGoalDefinition, DirectoryEntity } from '../../domain/workbench/entities';
import type { EntityRef } from '../../domain/workbench/primitives';
import { entityRefSchema } from '../../domain/workbench/primitives';
import { businessCalendarSchema, reminderSettingsSchema } from '../../domain/workbench/schemas/extensions';
import type { WorkbenchRepository } from '../../server/storage/workbench-repository';
import { WorkbenchHttpError } from '../../server/workbench/protocol';
import { projectExecution } from './workbench-execution';
import { notificationCauseSchema, type NotificationCause } from './workbench-reminders';
import type { NotificationContext, NotificationProvider } from './workbench-notifications';

/** A source owns interpretation of verified current state; it must never capture,
 * materialize an evaluation, or infer a successful external event from an outage. */
export type NotificationCauseSource = { id: string; current(context: NotificationContext, signal?: AbortSignal): Promise<NotificationCause[]> };

export function createExecutionNotificationSource({ repository }: { repository: WorkbenchRepository }): NotificationCauseSource {
  return { id: 'execution', async current(context, signal) {
    if (signal?.aborted) return [];
    const graph = repository.readPublishedExecutionGraph(); const projection = projectExecution({ ...graph, now: context.clock.now() });
    const goals = new Map<string, CoreGoalDefinition>(); const people = new Set<string>();
    const person = (id: string) => {
      if (!people.has(id)) { const value = repository.readPublishedHead<DirectoryEntity>({ entityType: 'directory_entity', id }); if (!value || value.kind !== 'person') throw new WorkbenchHttpError(422, 'NOTIFICATION_PERSON_INVALID', 'Notification recipient is not a public person'); people.add(id); }
      return id;
    };
    const goal = (id: string) => {
      let value = goals.get(id); if (!value) { const found = repository.readPublishedHead<CoreGoalDefinition>({ entityType: 'core_goal_definition', id }); if (!found) throw new WorkbenchHttpError(422, 'NOTIFICATION_GOAL_INVALID', 'Notification goal is not published'); value = found; goals.set(id, value); } return value;
    };
    const causes: NotificationCause[] = [];
    for (const view of projection.works) {
      const work = view.work; if (['completed','cancelled'].includes(work.state)) continue;
      const kinds: string[] = [];
      if (work.risk) kinds.push('work_risk');
      if (work.blocker || work.state === 'in_progress' && view.blockingWorkIds.length) kinds.push('work_blocker');
      if (view.overdue) kinds.push('work_overdue');
      if (!kinds.length) continue;
      const recipients = [...new Set([...work.goalIds.map(id => person(goal(id).primaryCuratorPersonId)), ...work.responsibility.map(r => person(r.personId))])];
      for (const kind of kinds) causes.push({ provider: 'execution', objectRef: { entityType: 'work', id: work.id }, sourceVersion: String(work.revision), kind, recipientPersonIds: recipients, route: `/execution?workId=${work.id}`, goalIds: work.goalIds, recurring: true });
    }
    const works = new Map(graph.works.map(work => [work.id, work]));
    for (const view of projection.decisions) {
      if (view.status !== 'open') continue;
      const decision = view.decision, work = works.get(decision.workId);
      if (!work) throw new WorkbenchHttpError(422, 'NOTIFICATION_WORK_INVALID', 'Decision work is not published');
      if (work.state === 'cancelled') continue;
      work.goalIds.forEach(id => goal(id));
      const base = { provider: 'execution', objectRef: { entityType: 'decision', id: decision.id }, sourceVersion: String(decision.revision), recipientPersonIds: [person(decision.requestedFromPersonId)], route: `/execution?decisionId=${decision.id}`, goalIds: work.goalIds };
      causes.push({ ...base, kind: 'decision_requested', recurring: false });
      if (view.overdue) causes.push({ ...base, kind: 'decision_overdue', recurring: true });
    }
    return causes;
  } };
}

/** Explicit configured settings and typed sources. No guessed first calendar,
 * private draft data, source capture or external write is used by polling. */
export function createNotificationProvider({ repository, settingsRef, sources }: { repository: WorkbenchRepository; settingsRef: EntityRef; sources: NotificationCauseSource[] }): NotificationProvider {
  entityRefSchema.parse(settingsRef);
  if (settingsRef.entityType !== 'reminder_settings' || new Set(sources.map(source => source.id)).size !== sources.length || sources.some(source => !/^[a-z][a-z0-9-]*$/.test(source.id))) throw new WorkbenchHttpError(422, 'NOTIFICATION_CONFIGURATION_INVALID', 'Invalid notification configuration');
  return { async current(context, signal) {
    const settingsValue = repository.readPublishedHead(settingsRef);
    if (!settingsValue) throw new WorkbenchHttpError(409, 'REMINDER_SETTINGS_UNAVAILABLE', 'Published reminder settings are unavailable');
    const settings = reminderSettingsSchema.parse(settingsValue);
    const calendarValue = repository.readPublishedHead({ entityType: 'business_calendar', id: settings.calendarId });
    if (!calendarValue) throw new WorkbenchHttpError(409, 'REMINDER_CALENDAR_UNAVAILABLE', 'Published reminder calendar is unavailable');
    const calendar = businessCalendarSchema.parse(calendarValue);
    // All providers finish and validate before the service makes any local write.
    const batches = await Promise.all(sources.map(async source => {
      if (signal?.aborted) return [];
      const values = await source.current(context, signal);
      return values.map(value => { const parsed = notificationCauseSchema.parse(value); if (parsed.provider !== source.id) throw new WorkbenchHttpError(422, 'NOTIFICATION_PROVIDER_MISMATCH', 'Cause provider does not match its source'); return parsed; });
    }));
    return { causes: batches.flat(), calendar, settings };
  } };
}
