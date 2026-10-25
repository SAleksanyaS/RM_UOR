import type { EvaluationInput, Observation } from '../../domain/contracts';

/** Only fields capable of changing the business evaluation enter its fingerprint. */
export function businessObservation(row: Observation) {
  return {
    participantId: row.participantId, leaderId: row.leaderId, metricId: row.metricId,
    value: row.value, target: row.target, unit: row.unit, state: row.state,
    period: row.period, sourceId: row.sourceId,
  };
}

export const metricKey = (row: Observation) => JSON.stringify([row.participantId, row.metricId]);
const content = (row: Observation) => JSON.stringify(businessObservation(row));
const lexical = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
function sourceTime(row: Observation) {
  const time = row.sourceUpdatedAt ? Date.parse(row.sourceUpdatedAt) : NaN;
  return Number.isFinite(time) ? time : Number.NEGATIVE_INFINITY;
}

/**
 * Repeated exports must not double-weight a participant. Latest business date wins.
 * Conflicting rows at the same latest date remain ambiguous: neither input order,
 * generated row id nor download time is allowed to turn ambiguity into success.
 */
export function normalizeObservations(input: EvaluationInput) {
  const expected = input.expectedParticipants === undefined ? null : new Set(input.expectedParticipants);
  const scoped = input.observations.filter((row) => row.goalId === input.goal.id && row.period === input.period
    && (!input.leaderId || row.leaderId === input.leaderId));
  if (input.expectedMetricIds && expected) {
    for (const participantId of expected) for (const metricId of new Set(input.expectedMetricIds)) {
      if (scoped.some(row => row.participantId === participantId && row.metricId === metricId)) continue;
      const participant = scoped.find(row => row.participantId === participantId);
      scoped.push({ id: `missing:${participantId}:${metricId}`, goalId: input.goal.id, leaderId: participant?.leaderId ?? input.leaderId ?? null,
        participantId, participantName: participant?.participantName ?? participantId, metricId, metricName: metricId,
        value: null, target: null, unit: input.goal.unit, state: 'missing', reason: 'Ожидаемый показатель отсутствует в выгрузке',
        period: input.period, sourceId: 'expected-cohort', sourceUpdatedAt: null, downloadedAt: '' });
    }
  }
  const unexpectedParticipants = new Set(scoped.filter((row) => expected && !expected.has(row.participantId)).map((row) => row.participantId));
  const groups = new Map<string, Observation[]>();
  for (const row of scoped) {
    if (expected && !expected.has(row.participantId)) continue;
    const key = metricKey(row);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const observations: Observation[] = [];
  const conflicts: { key: string; variants: ReturnType<typeof businessObservation>[] }[] = [];
  let duplicates = 0;
  for (const [key, rows] of [...groups.entries()].sort(([a], [b]) => lexical(a, b))) {
    duplicates += rows.length - 1;
    const ordered = [...rows].sort((a, b) => sourceTime(b) - sourceTime(a) || lexical(content(a), content(b)));
    const latest = ordered[0];
    const latestVariants = [...new Map(ordered.filter((row) => sourceTime(row) === sourceTime(latest))
      .map((row) => [content(row), businessObservation(row)])).entries()].sort(([a], [b]) => lexical(a, b));
    if (latestVariants.length > 1) conflicts.push({ key, variants: latestVariants.map(([, value]) => value) });
    observations.push(latest);
  }
  return { observations, conflicts, duplicates, unexpectedParticipants: [...unexpectedParticipants].sort() };
}
