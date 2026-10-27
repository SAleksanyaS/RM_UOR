import type { Capture, ObservedFact, WeeklyPoint } from '../../../domain/workbench/entities';
import type { MoscowDate, ScopeRef, UtcInstant, VersionRef } from '../../../domain/workbench/primitives';
import { moscowDateSchema, utcInstantSchema, versionRefSchema } from '../../../domain/workbench/primitives';
import { toRational } from '../../../domain/workbench/exact-number';
import { addMoscowDays, moscowEnd } from '../../../domain/workbench/time';
import { WorkbenchError } from '../../../domain/workbench/errors';

export type FridaySeriesInput = { assignmentRef: VersionRef; metricRef: VersionRef; scope: ScopeRef; facts: ObservedFact[]; captures: Capture[]; fromInclusive: MoscowDate; toExclusive: MoscowDate; evaluatedAt: UtcInstant };

/** Presentation only. Does not create measurements, refresh dates or confirm a result. */
export function projectFridaySeries(input: FridaySeriesInput): WeeklyPoint[] {
  moscowDateSchema.parse(input.fromInclusive); moscowDateSchema.parse(input.toExclusive); utcInstantSchema.parse(input.evaluatedAt);
  versionRefSchema.parse(input.assignmentRef); versionRefSchema.parse(input.metricRef);
  if (input.assignmentRef.entityType !== 'goal_assignment' || input.metricRef.entityType !== 'metric_definition') throw new WorkbenchError('REFERENCE_TYPE_MISMATCH');
  if (input.fromInclusive >= input.toExclusive) throw new WorkbenchError('INVALID_SERIES_RANGE');
  const captures = new Map(input.captures.map(c => [c.id, c]));
  const dateOf = (f: ObservedFact): string | null => f.businessTime.kind === 'as_of' ? f.businessTime.date : f.businessTime.kind === 'period' ? addMoscowDays(f.businessTime.endExclusive, -1) : null;
  const weekday = new Date(input.fromInclusive + 'T00:00:00.000Z').getUTCDay();
  let friday = addMoscowDays(input.fromInclusive, (5 - weekday + 7) % 7);
  const points: WeeklyPoint[] = [];
  while (friday < input.toExclusive) {
    const cutoff = Math.min(Date.parse(input.evaluatedAt), Date.parse(moscowEnd(friday)));
    const eligible = input.facts.filter(f => f.metricId === input.metricRef.id && f.scope.kind === input.scope.kind && f.scope.id === input.scope.id && f.state === 'known' && f.value !== null && captures.has(f.captureId) && Date.parse(captures.get(f.captureId)!.capturedAt) <= cutoff && Date.parse(f.recordedAt) <= Date.parse(input.evaluatedAt) && (dateOf(f) === null || dateOf(f)! <= friday));
    if (new Set(eligible.map(f => f.unitCode)).size > 1) throw new WorkbenchError('INCOMPATIBLE_SERIES_UNITS');
    const known = eligible.filter(f => dateOf(f) !== null);
    if (new Set(known.map(f => f.businessTime.kind)).size > 1) throw new WorkbenchError('INCOMPATIBLE_SERIES_TIME');
    const candidates = known.length ? known : eligible;
    candidates.sort((a, b) => {
      const ad = dateOf(a); const bd = dateOf(b);
      if (ad !== bd && ad !== null && bd !== null) return ad < bd ? 1 : -1;
      return Date.parse(captures.get(b.captureId)!.capturedAt) - Date.parse(captures.get(a.captureId)!.capturedAt);
    });
    const first = candidates[0];
    if (!first) points.push({ assignmentId: input.assignmentRef.id, metricId: input.metricRef.id, friday, value: null, sourceFactRef: null, sourceBusinessTime: null, sourceCapturedAt: null, carried: false, warning: null });
    else {
      const tied = candidates.filter(f => dateOf(f) === dateOf(first) && Date.parse(captures.get(f.captureId)!.capturedAt) === Date.parse(captures.get(first.captureId)!.capturedAt));
      const heads = new Map<string, ObservedFact>(); for (const f of tied) if (!heads.has(f.id) || heads.get(f.id)!.revision < f.revision) heads.set(f.id, f);
      const alternatives = [...heads.values()];
      const semantic = (f: ObservedFact) => JSON.stringify([toRational(f.value!), f.businessTime, captures.get(f.captureId)!.payloadHash, [...f.lineage.sourceRowKeys].sort()]);
      if (new Set(alternatives.map(semantic)).size > 1) throw new WorkbenchError('AMBIGUOUS_FACT_SELECTION');
      // Equivalent aliases have identical mathematical meaning and provenance; stable ref selection is safe here.
      alternatives.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : b.revision - a.revision);
      const chosen = alternatives[0]; const carried = dateOf(chosen) !== friday;
      points.push({ assignmentId: input.assignmentRef.id, metricId: input.metricRef.id, friday, value: typeof chosen.value === 'string' ? chosen.value : { ...chosen.value! }, sourceFactRef: { entityType: 'observed_fact', id: chosen.id, revision: chosen.revision }, sourceBusinessTime: { ...chosen.businessTime }, sourceCapturedAt: captures.get(chosen.captureId)!.capturedAt, carried, warning: carried ? 'Данные не обновлялись' : null });
    }
    // Avoid stepping beyond the supported four-digit calendar after the final requested point.
    if (Date.parse(input.toExclusive + 'T00:00:00Z') - Date.parse(friday + 'T00:00:00Z') <= 7 * 86_400_000) break;
    friday = addMoscowDays(friday, 7);
  }
  return points;
}
