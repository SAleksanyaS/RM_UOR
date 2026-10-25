import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Attestation, CatalogSnapshot, LocalSnapshot, Session } from '../../domain/contracts';
import type { ApplicationContext } from '../../server/workspace/context';
import { evaluateGoal } from '../evaluation/evaluate';
import { selectFacts, snapshotFreshness } from '../snapshots/select-facts';
import { ActionError } from '../identity/role-service';
import type { ReportRow, ReportSelection, ReportSnapshot } from './report-contracts';
import { formatGoalTarget } from '../overview/goal-target';

export const reportSelectionSchema = z.object({ goalIds: z.array(z.string().min(1).max(500)).min(1).max(500), leaderIds: z.array(z.string().min(1).max(500)).max(500), period: z.iso.date() }).strict();
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Pure read projection. Historical reports never invalidate a present-day attestation. */
export function buildReport(catalog: CatalogSnapshot, snapshots: LocalSnapshot[], attestations: Attestation[], selection: ReportSelection, actor: string, now = new Date().toISOString()): ReportSnapshot {
  const input = reportSelectionSchema.parse(selection);
  input.goalIds = [...new Set(input.goalIds)]; input.leaderIds = [...new Set(input.leaderIds)];
  if (input.goalIds.some(id => !catalog.goals.some(goal => goal.id === id)) || input.leaderIds.some(id => !catalog.leaders.some(leader => leader.id === id))) throw new ActionError('Выбранная цель или ИТ-лидер не найдены', 404);
  const facts = snapshots.filter(snapshot => snapshot.classification === catalog.classification && catalog.sources.some(source => source.id === snapshot.sourceId));
  const rows: ReportRow[] = [];
  for (const goal of catalog.goals.filter(goal => input.goalIds.includes(goal.id))) {
    const active = catalog.assignments.filter(assignment => assignment.goalId === goal.id && assignment.active !== false);
    const activeLeaders = new Set(active.map(assignment => assignment.leaderId));
    for (const leaderId of [null, ...input.leaderIds.filter(id => activeLeaders.has(id))]) {
      const selected = catalog.sources.filter(source => source.goalIds.includes(goal.id)).flatMap(source => {
        const candidates = facts.filter(snapshot => snapshot.sourceId === source.id);
        const result = selectFacts({ mode: 'auto', goalId: goal.id, leaderId, period: input.period, sourceId: source.id,
          personal: candidates.filter(snapshot => snapshot.status === 'personal'), published: candidates.filter(snapshot => snapshot.status === 'validated'), freshnessHours: source.freshnessHours, now });
        return result.snapshot ? [{ snapshot: result.snapshot, stale: snapshotFreshness(result.snapshot, source.freshnessHours, now).isStale }] : [];
      });
      const assignments = active.filter(assignment => !leaderId || assignment.leaderId === leaderId);
      const observations = selected.flatMap(item => item.snapshot.observations).filter(row => row.goalId === goal.id && (leaderId ? row.leaderId === leaderId : row.leaderId === null || activeLeaders.has(row.leaderId)));
      const dimensional = observations.some(row => row.metricId !== goal.id);
      const expectedParticipants = goal.measurement && goal.scopeType === 'global' && !active.length ? ['global-dit'] : (goal.measurement || dimensional) && assignments.length && assignments.every(item => item.participantIds !== undefined) ? [...new Set(assignments.flatMap(item => item.participantIds!))] : undefined;
      const scopeRevision = JSON.stringify(assignments.map(a => ({ id: a.id, teams: [...a.teams].sort(), participantIds: a.participantIds ? [...a.participantIds].sort() : null, target: a.target ?? null })).sort((a, b) => a.id.localeCompare(b.id)));
      const evaluationInput = { goal, observations, period: input.period, leaderId, expectedParticipants, expectedMetricIds: goal.measurement ? goal.measurement.metrics.map(metric => metric.id) : dimensional ? goal.requiredMetricIds : undefined, scopeRevision };
      let evaluation = evaluateGoal(evaluationInput);
      const confirmation = attestations.filter(item => item.goalId === goal.id && item.leaderId === leaderId && item.period === input.period && !item.invalidatedAt && item.fingerprint === evaluation.fingerprint).sort((a, b) => b.confirmedAt.localeCompare(a.confirmedAt))[0] ?? null;
      if (confirmation) evaluation = evaluateGoal({ ...evaluationInput, attestation: confirmation });
      if (!goal.measurement && dimensional && (expectedParticipants === undefined || !goal.requiredMetricIds?.length)) {
        evaluation.qualityFlags.push('unknown_coverage');
        if (evaluation.official === 'met') evaluation.official = 'unknown';
        if (evaluation.internal === 'met') evaluation.internal = 'unknown';
        evaluation.validation = 'not_required';
      }
      if (selected.some(item => item.stale) && observations.length) { evaluation.qualityFlags.push('stale'); if (evaluation.validation === 'confirmed') evaluation.validation = 'pending'; }
      if (observations.length && !selected.some(item => item.snapshot.sourceUpdatedAt)) evaluation.qualityFlags.push('source_date_unknown');
      evaluation.snapshotIds = selected.map(item => item.snapshot.id);
      rows.push({ goalId: goal.id, goalTitle: goal.title, leaderId, leaderName: leaderId ? catalog.leaders.find(item => item.id === leaderId)!.name : 'Общий результат ДИТ', unit: goal.unit, officialTargetLabel: formatGoalTarget(goal),
        officialDueDate: goal.dueDate, evaluation, confirmation: evaluation.validation === 'confirmed' ? confirmation : null,
        comments: catalog.comments.filter(comment => comment.goalId === goal.id && comment.leaderId === leaderId && comment.createdAt <= now && (!comment.validUntil || comment.validUntil.slice(0, 10) >= now.slice(0, 10))),
        plan: (leaderId ? assignments[0]?.plan : goal.plan) ?? null,
        sources: selected.map(({ snapshot: s }) => ({ id: s.id, sourceId: s.sourceId, sourceName: catalog.sources.find(source => source.id === s.sourceId)!.name, sourceUrl: catalog.sources.find(source => source.id === s.sourceId)!.url, period: s.period, dataHash: s.dataHash, origin: s.origin, status: s.status, collectedAt: s.collectedAt, sourceUpdatedAt: s.sourceUpdatedAt, curatorName: s.curatorName, validatedAt: s.validatedAt, limitations: s.limitations })),
        availablePeriods: [...new Set(facts.filter(snapshot => snapshot.observations.some(row => row.goalId === goal.id && (!leaderId || row.leaderId === leaderId))).map(snapshot => snapshot.period))].sort(),
      });
    }
  }
  const goals = rows.filter(row => row.leaderId === null);
  const report: ReportSnapshot = { id: randomUUID(), createdAt: now, createdBy: actor, selection: input, template: { id: 'uor-director-v1', version: '1.0', name: 'Статус целей и ИТ-лидеров' },
    versions: { application: '0.1.0', catalog: hash(catalog), facts: hash(facts), confirmations: hash(attestations) }, catalogName: catalog.name, classification: catalog.classification, rows,
    summary: { goals: goals.length, confirmed: goals.filter(row => row.evaluation.official === 'met' && row.evaluation.validation === 'confirmed').length, pending: goals.filter(row => row.evaluation.official === 'met' && row.evaluation.validation !== 'confirmed').length, notMet: goals.filter(row => row.evaluation.official === 'not_met').length, unknown: goals.filter(row => row.evaluation.official === 'unknown').length },
    limitations: ['Расчёт выполнен по правилам каталога на дату формирования. Историческая редакция методики не восстанавливается.', 'Комментарии и планы зафиксированы на дату формирования и могут быть позднее выбранного периода.', 'Периоды перечисляют только имеющиеся снимки. Сравнительный тренд не рассчитывается.', 'Ожидание подтверждения УОР не означает окончательное выполнение.', 'Первый шаблон встроенный. Импорт произвольного PPTX пока недоступен.', ...new Set(rows.flatMap(row => row.sources.flatMap(source => source.limitations)))] };
  return structuredClone(report);
}
export async function generateReport(context: ApplicationContext, session: Session, selection: ReportSelection) {
  const catalog = await context.catalogs.readForSession(session);
  const report = buildReport(catalog, context.db.list<LocalSnapshot>('snapshots'), context.db.list<Attestation>('attestations'), selection, session.name);
  // Only the snapshot is persisted. Generating a report is available to readers and never changes the shared catalog.
  context.db.set('reports', report.id, { sessionId: session.id, report });
  return report;
}
export function readReport(context: ApplicationContext, session: Session, id: string): ReportSnapshot {
  const saved = context.db.get<{ sessionId: string; report: ReportSnapshot }>('reports', id);
  if (!saved || saved.sessionId !== session.id) throw new ActionError('Отчёт не найден в этой сессии. Сформируйте новый снимок.', 404);
  return saved.report;
}
