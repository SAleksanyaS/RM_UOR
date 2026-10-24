import { createHash } from 'node:crypto';
import type { Assignment, Attestation, Goal, LocalSnapshot, Observation, Session } from '../../domain/contracts';
import type { ApplicationContext } from '../../server/workspace/context';
import { ActionError } from '../identity/role-service';
import { evaluateGoal } from '../evaluation/evaluate';
import { selectFacts } from '../snapshots/select-facts';
import type { GoalHistory, GoalHistoryPoint } from './history-contracts';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const scopeOf = (assignments: Assignment[]) => assignments.map(a => ({ id: a.id, teams: [...a.teams].sort(),
  participantIds: a.participantIds ? [...a.participantIds].sort() : null, target: a.target ?? null })).sort((a, b) => a.id.localeCompare(b.id));
const rulesOf = (goal: Goal, assignments: Assignment[]) => ({ goal: { id: goal.id, officialTarget: goal.officialTarget,
  internalTarget: goal.internalTarget, baseline: goal.baseline, direction: goal.direction, unit: goal.unit,
  scopeType: goal.scopeType, requiredMetricIds: [...(goal.requiredMetricIds ?? [])].sort() }, scope: scopeOf(assignments) });
const rowKey = (row: Observation) => JSON.stringify([row.sourceId, row.participantId, row.metricId]);
const rowContent = (row: Observation) => JSON.stringify([row.goalId, row.leaderId, row.value, row.target, row.state, row.unit]);
function difference(before: Observation[], after: Observation[]) {
  const a = new Map(before.map(row => [rowKey(row), rowContent(row)])), b = new Map(after.map(row => [rowKey(row), rowContent(row)]));
  return { added: [...b.keys()].filter(key => !a.has(key)).length,
    changed: [...b.keys()].filter(key => a.has(key) && a.get(key) !== b.get(key)).length,
    removed: [...a.keys()].filter(key => !b.has(key)).length };
}

/** Read-only projection. In particular, never call context.state/evaluations on historical data. */
export async function getGoalHistory(context: ApplicationContext, session: Session, goalId: string, leaderId: string | null): Promise<GoalHistory> {
  const catalog = await context.catalogs.readForSession(session);
  const currentGoal = catalog.goals.find(goal => goal.id === goalId);
  if (!currentGoal) throw new ActionError('Цель не найдена', 404);
  if (leaderId && !catalog.leaders.some(leader => leader.id === leaderId)) throw new ActionError('ИТ-лидер не найден', 404);
  const snapshots = context.db.list<LocalSnapshot>('snapshots').filter(snapshot => snapshot.classification === catalog.classification
    && catalog.sources.some(source => source.id === snapshot.sourceId && source.goalIds.includes(goalId))
    && snapshot.observations.some(row => row.goalId === goalId && (!leaderId || row.leaderId === leaderId)));
  const attestations = context.db.list<Attestation>('attestations');
  const points: GoalHistoryPoint[] = [];
  for (const period of [...new Set(snapshots.map(snapshot => snapshot.period))].sort()) {
    const periodSnapshots = snapshots.filter(snapshot => snapshot.period === period);
    const selected: LocalSnapshot[] = [];
    for (const sourceId of [...new Set(periodSnapshots.map(snapshot => snapshot.sourceId))].sort()) {
      const candidates = periodSnapshots.filter(snapshot => snapshot.sourceId === sourceId);
      const chosen = selectFacts({ mode: 'auto', goalId, leaderId, period, sourceId,
        personal: candidates.filter(snapshot => snapshot.status === 'personal'), published: candidates.filter(snapshot => snapshot.status === 'validated'),
        freshnessHours: catalog.sources.find(source => source.id === sourceId)?.freshnessHours }).snapshot;
      if (chosen) selected.push(chosen);
    }
    if (!selected.length) continue;
    const bases = selected.map(snapshot => snapshot.evaluationBasis).filter(basis => basis?.goal.id === goalId);
    const known = bases.length === selected.length;
    const basis = known ? bases[0] : undefined;
    const scopedAssignments = (items: Assignment[]) => items.filter(a => a.goalId === goalId && a.active !== false && (!leaderId || a.leaderId === leaderId));
    const goal = basis?.goal ?? currentGoal;
    const assignments = scopedAssignments(basis?.assignments ?? catalog.assignments);
    const compatibleRules = known && bases.every(item => hash(rulesOf(item!.goal, scopedAssignments(item!.assignments))) === hash(rulesOf(goal, assignments)));
    const activeLeaders = new Set(assignments.map(a => a.leaderId));
    const scopedRows = (items: LocalSnapshot[]) => items.flatMap(snapshot => snapshot.observations).filter(row => row.goalId === goalId
      && (leaderId ? row.leaderId === leaderId : row.leaderId === null || activeLeaders.has(row.leaderId)));
    const observations = scopedRows(selected);
    const dimensional = observations.some(row => row.metricId !== goalId);
    const expectedParticipants = dimensional && assignments.length && assignments.every(a => a.participantIds !== undefined)
      ? [...new Set(assignments.flatMap(a => a.participantIds!))] : undefined;
    const input = { goal, observations, period, leaderId, expectedParticipants,
      expectedMetricIds: dimensional ? goal.requiredMetricIds : undefined, scopeRevision: JSON.stringify(scopeOf(assignments)) };
    let evaluation = evaluateGoal(input);
    const confirmations = attestations.filter(item => item.goalId === goalId && item.leaderId === leaderId
      && item.period === period && item.fingerprint === evaluation.fingerprint).sort((a, b) => b.confirmedAt.localeCompare(a.confirmedAt));
    const active = confirmations.find(item => !item.invalidatedAt);
    if (active) evaluation = evaluateGoal({ ...input, attestation: active });
    if (dimensional && (expectedParticipants === undefined || !goal.requiredMetricIds?.length)) {
      evaluation.qualityFlags.push('unknown_coverage');
      if (evaluation.official === 'met') evaluation.official = 'unknown';
      evaluation.validation = 'not_required';
    }
    if (!known) evaluation.qualityFlags.push('historical_rules_unknown');
    else if (!compatibleRules) {
      evaluation.qualityFlags.push('historical_rules_conflict');
      evaluation.actual = null; evaluation.official = 'unknown'; evaluation.validation = 'not_required';
    }
    // Thresholds are part of comparability; values and acquisition timestamps are not.
    const thresholds = [...new Map(observations.map(row => [rowKey(row), [rowKey(row), row.target, row.unit]])).values()]
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    const cohortKey = hash({ version: basis?.methodVersion ?? null, rules: rulesOf(goal, assignments),
      sources: selected.map(snapshot => snapshot.sourceId).sort(), thresholds });
    const previous = points.at(-1);
    const comparableToPrevious = !!previous && known && compatibleRules && previous.cohortKey === cohortKey
      && !previous.qualityFlags.some(flag => flag === 'historical_rules_unknown' || flag === 'historical_rules_conflict');
    const revisions = periodSnapshots.filter(snapshot => selected.some(item => item.sourceId === snapshot.sourceId)).length;
    const predecessors = selected.map(snapshot => periodSnapshots.filter(item => item.sourceId === snapshot.sourceId && item.id !== snapshot.id
      && item.collectedAt <= snapshot.collectedAt).sort((a, b) => b.collectedAt.localeCompare(a.collectedAt))[0] ?? snapshot);
    points.push({ period, actual: evaluation.actual, officialTarget: evaluation.officialTarget, official: evaluation.official,
      validation: evaluation.validation, eligibleParticipants: evaluation.eligibleParticipants, metParticipants: evaluation.metParticipants,
      coverage: evaluation.coverage, qualityFlags: evaluation.qualityFlags, snapshotIds: selected.map(snapshot => snapshot.id),
      fingerprint: evaluation.fingerprint, cohortKey, comparableToPrevious, revisions,
      ...(revisions > selected.length ? { changes: difference(scopedRows(predecessors), observations) } : {}),
      historicalConfirmedAt: confirmations[0]?.confirmedAt ?? null });
  }
  return { goalId, leaderId, points };
}
