import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Attestation, CatalogSnapshot, LocalSnapshot, Session } from '../../domain/contracts';
import type { ApplicationContext } from '../../server/workspace/context';
import { evaluateGoal } from '../evaluation/evaluate';
import { selectFacts, snapshotFreshness } from '../snapshots/select-facts';
import { ActionError } from '../identity/role-service';
import type { ReportRow, ReportSelection, ReportSnapshot } from './report-contracts';
import { reportStatus } from './report-contracts';
import { formatGoalTarget } from '../overview/goal-target';
import { evaluationScope, historicalRules } from './evaluation-basis';
import { decisionEntitySchema } from '../director/decision-schema';
import { getReportTemplate, decodeTemplateBase64 } from '../report-templates/service';
import { renderTemplate, assertTemplateCoverage } from '../report-templates/ooxml';
import type { TemplateProfile } from '../report-templates/contracts';
import { APP_VERSION } from '../../domain/app-version';
import { canReadSnapshot } from '../connectors/service';
import { readWorkPackage } from '../execution/execution-schema';

export const reportSelectionSchema = z.object({ goalIds: z.array(z.string().min(1).max(500)).min(1).max(500), leaderIds: z.array(z.string().min(1).max(500)).max(500), period: z.iso.date(), baselinePeriod: z.iso.date().optional(), templateId: z.string().uuid().optional() }).strict().refine(value => !value.baselinePeriod || value.baselinePeriod < value.period, 'Базовый период должен быть раньше отчётного');
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Pure projection: no context.state, no changes to present-day confirmations. */
export function buildReport(catalog: CatalogSnapshot, snapshots: LocalSnapshot[], attestations: Attestation[], selection: ReportSelection, actor: string, now = new Date().toISOString()): ReportSnapshot {
  const input = reportSelectionSchema.parse(selection);
  input.goalIds = [...new Set(input.goalIds)]; input.leaderIds = [...new Set(input.leaderIds)];
  const facts = snapshots.filter(s => s.classification === catalog.classification);
  if (input.goalIds.some(id => !catalog.goals.some(g => g.id === id) && !facts.some(s => s.evaluationBasis?.goal.id === id)) || input.leaderIds.some(id => !catalog.leaders.some(l => l.id === id) && !facts.some(s => s.evaluationBasis?.organization?.leaders.some(l => l.id === id)))) throw new ActionError('Выбранная цель или ИТ-лидер не найдены', 404);
  const rows: ReportRow[] = [];
  for (const goalId of input.goalIds) {
    const relevant = facts.filter(s => s.period === input.period && s.observations.some(o => o.goalId === goalId));
    const historicalAssignments = relevant.flatMap(s => s.evaluationBasis?.goal.id === goalId ? s.evaluationBasis.assignments : []);
    const currentGoal = catalog.goals.find(g => g.id === goalId) ?? relevant.find(s => s.evaluationBasis?.goal.id === goalId)!.evaluationBasis!.goal;
    const activeLeaders = new Set((historicalAssignments.length ? historicalAssignments : catalog.assignments.filter(a => a.goalId === goalId)).filter(a => a.active !== false).map(a => a.leaderId));
    for (const leaderId of [null, ...input.leaderIds.filter(id => activeLeaders.has(id))]) {
      const selected = [...new Set(relevant.map(s => s.sourceId))].flatMap(sourceId => {
        const candidates = relevant.filter(s => s.sourceId === sourceId), source = catalog.sources.find(s => s.id === sourceId);
        const chosen = selectFacts({ mode: 'auto', goalId, leaderId, period: input.period, sourceId, personal: candidates.filter(s => s.status === 'personal'), published: candidates.filter(s => s.status === 'validated'), freshnessHours: source?.freshnessHours, now }).snapshot;
        return chosen ? [chosen] : [];
      });
      const bases = selected.map(s => s.evaluationBasis).filter(b => b?.goal.id === goalId);
      const known = selected.length > 0 && bases.length === selected.length;
      const basis = known ? bases[0]! : undefined;
      const goal = basis?.goal ?? currentGoal;
      const scoped = (items: CatalogSnapshot['assignments']) => items.filter(a => a.goalId === goalId && a.active !== false && (!leaderId || a.leaderId === leaderId));
      const assignments = scoped(basis?.assignments ?? catalog.assignments);
      const rules = hash(historicalRules(goal, assignments));
      const compatible = known && bases.every(b => hash(historicalRules(b!.goal, scoped(b!.assignments))) === rules);
      const orgs = bases.map(b => b!.organization);
      const orgKnown = known && orgs.every(o => !!o) && orgs.every(o => hash(o) === hash(orgs[0]));
      const organization = orgKnown ? orgs[0] : undefined;
      const cohortLeaders = new Set(assignments.map(a => a.leaderId));
      const observations = selected.flatMap(s => s.observations).filter(o => o.goalId === goalId && (leaderId ? o.leaderId === leaderId : o.leaderId === null || cohortLeaders.has(o.leaderId)));
      const dimensional = observations.some(o => o.metricId !== goalId);
      const expectedParticipants = goal.measurement && goal.scopeType === 'global' && !assignments.length && !leaderId ? ['global-dit'] : (goal.measurement || dimensional) && assignments.length && assignments.every(a => a.participantIds !== undefined) ? [...new Set(assignments.flatMap(a => a.participantIds!))] : undefined;
      const evaluationInput = { goal, observations, period: input.period, leaderId, expectedParticipants, expectedMetricIds: goal.measurement ? goal.measurement.metrics.map(m => m.id) : dimensional ? goal.requiredMetricIds : undefined, scopeRevision: JSON.stringify(evaluationScope(assignments)) };
      let evaluation = evaluateGoal(evaluationInput);
      // An invalidation in a later period does not erase an earlier confirmation.
      const at = known ? new Date(Math.min(Date.parse(now),Date.parse(`${input.period}T23:59:59.999Z`))).toISOString() : now;
      const confirmation = attestations.filter(a => a.goalId === goalId && a.leaderId === leaderId && a.period === input.period && a.confirmedAt <= at && (!a.invalidatedAt || a.invalidatedAt > at) && a.fingerprint === evaluation.fingerprint).sort((a, b) => b.confirmedAt.localeCompare(a.confirmedAt))[0] ?? null;
      if (confirmation) evaluation = evaluateGoal({ ...evaluationInput, attestation: { ...confirmation, invalidatedAt: null } });
      if (!goal.measurement && dimensional && (expectedParticipants === undefined || !goal.requiredMetricIds?.length)) {
        evaluation.qualityFlags.push('unknown_coverage'); if (evaluation.official === 'met') evaluation.official = 'unknown'; if (evaluation.internal === 'met') evaluation.internal = 'unknown'; evaluation.validation = 'not_required';
      }
      if (known && !compatible) { evaluation.qualityFlags.push('historical_rules_conflict'); evaluation.actual = null; evaluation.official = 'unknown'; evaluation.internal = 'unknown'; evaluation.validation = 'not_required'; }
      if (selected.some(s => snapshotFreshness(s, (organization?.sources ?? catalog.sources).find(source => source.id === s.sourceId)?.freshnessHours, at).isStale) && observations.length) { evaluation.qualityFlags.push('stale'); if (evaluation.validation === 'confirmed') evaluation.validation = 'pending'; }
      if (observations.length && !selected.some(s => s.sourceUpdatedAt)) evaluation.qualityFlags.push('source_date_unknown');
      evaluation.snapshotIds = selected.map(s => s.id);
      const entities = organization?.entities ?? [];
      const decisions = entities.flatMap(e => { const parsed = decisionEntitySchema.safeParse(e); return parsed.success && (!parsed.data.goalId || parsed.data.goalId === goalId) ? [parsed.data] : []; });
      const workPackages = entities.filter(e => e.type === 'work_package').flatMap(e => {
        const work = readWorkPackage(e);
        if (work.goalId !== goalId || work.leaderId !== leaderId) return [];
        const last = work.events.filter(event => event.at <= `${input.period}T23:59:59.999Z`).sort((a,b) => b.at.localeCompare(a.at))[0];
        return [{ id:work.id, title:work.title, owner:work.owner, dueDate:work.dueDate, baselineDueDate:work.baseline?.dueDate ?? null, completed:last?.completed ?? false, lastEventAt:last?.at ?? null }];
      });
      rows.push({ goalId, goalTitle: goal.title, leaderId, leaderName: leaderId ? (organization?.leaders ?? (!known ? catalog.leaders : [])).find(l => l.id === leaderId)?.name ?? `${leaderId} (имя не сохранено)` : 'Общий результат ДИТ', unit: goal.unit,
        officialTargetLabel: formatGoalTarget(goal), officialDueDate: goal.dueDate, evaluation, confirmation: evaluation.validation === 'confirmed' ? confirmation : null,
        comments: (organization?.comments ?? (!known ? catalog.comments : [])).filter(c => c.goalId === goalId && c.leaderId === leaderId && c.createdAt <= now && (!c.validUntil || c.validUntil.slice(0, 10) >= input.period)),
        plan: (leaderId ? assignments[0]?.plan : goal.plan) ?? null, decisions, workPackages,
        historicalBasis: !known ? 'legacy' : compatible ? 'captured' : 'conflict', organizationCaptured: orgKnown,
        cohortKey: compatible ? hash({ rules, version: basis!.methodVersion, sources: selected.map(s => s.sourceId).sort(), thresholds: observations.map(o => [o.sourceId, o.participantId, o.metricId, o.target, o.unit]).sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) }) : null,
        sources: selected.map(s => { const source = (organization?.sources ?? (!known ? catalog.sources : [])).find(source => source.id === s.sourceId); return { id: s.id, sourceId: s.sourceId, sourceName: source?.name ?? `${s.sourceId} (название не сохранено)`, sourceUrl: source?.url ?? null, period: s.period, dataHash: s.dataHash, origin: s.origin, status: s.status, collectedAt: s.collectedAt, sourceUpdatedAt: s.sourceUpdatedAt, curatorName: s.curatorName, validatedAt: s.validatedAt, limitations: s.limitations }; }),
        availablePeriods: [...new Set(facts.filter(s => s.observations.some(o => o.goalId === goalId && (!leaderId || o.leaderId === leaderId))).map(s => s.period))].sort() });
    }
  }
  const goals = rows.filter(r => r.leaderId === null);
  const report: ReportSnapshot = { id: randomUUID(), createdAt: now, createdBy: actor, selection: input, template: { id: 'uor-director-v1', version: '1.0', name: 'Статус целей и ИТ-лидеров' }, versions: { application: APP_VERSION, catalog: hash(catalog), facts: hash(facts), confirmations: hash(attestations) }, catalogName: catalog.name, classification: catalog.classification, rows,
    summary: { goals: goals.length, confirmed: goals.filter(r => r.evaluation.official === 'met' && r.evaluation.validation === 'confirmed').length, pending: goals.filter(r => r.evaluation.official === 'met' && r.evaluation.validation !== 'confirmed').length, notMet: goals.filter(r => r.evaluation.official === 'not_met').length, unknown: goals.filter(r => r.evaluation.official === 'unknown').length },
    limitations: [...(rows.some(r => r.historicalBasis === 'legacy') ? ['У части снимков отсутствует историческая основа: пересчёт по текущей методике, имена и планы не считаются историческими. Числовое сравнение запрещено.'] : []), ...(rows.some(r => !r.organizationCaptured) ? ['У части снимков не сохранена историческая организация. Прошлые имена, решения и связи не восстанавливаются.'] : []), 'Организация и объявленные работы зафиксированы при принятии фактов. Дата получения снимка может быть позднее периода фактов.', 'Факты, объявленные работы и подтверждение УОР разделены. Сформированный отчёт сохраняется без последующего пересчёта.', ...new Set(rows.flatMap(r => r.sources.flatMap(s => s.limitations)))] };
  if (input.baselinePeriod) {
    const baseline = buildReport(catalog, facts, attestations, { goalIds: input.goalIds, leaderIds: input.leaderIds, period: input.baselinePeriod }, actor, `${input.baselinePeriod}T23:59:59.999Z`);
    report.limitations.push(...baseline.limitations.filter(message => message.includes('У части')).map(message => `Базовый период: ${message}`));
    report.comparison = { baselinePeriod: input.baselinePeriod, rows: rows.map(current => {
      const before = baseline.rows.find(r => r.goalId === current.goalId && r.leaderId === current.leaderId) ?? null;
      const comparable = !!before?.cohortKey && before.cohortKey === current.cohortKey && before.evaluation.actual !== null && current.evaluation.actual !== null;
      const changes: { field: string; before: string | null; after: string | null }[] = [];
      const change = (field: string, a: string | null | undefined, b: string | null | undefined) => { if ((a ?? null) !== (b ?? null)) changes.push({ field, before: a ?? null, after: b ?? null }); };
      if (before) { change('Расчётный статус', before.evaluation.official, current.evaluation.official); change('Подтверждение УОР', before.evaluation.validation, current.evaluation.validation);
        if (before.historicalBasis === 'captured' && current.historicalBasis === 'captured') for (const key of ['targetDate', 'forecastDate', 'nextCheckDate', 'nextAction', 'blocker', 'decisionNeeded'] as const) change(key, before.plan?.[key], current.plan?.[key]);
        if (before.organizationCaptured && current.organizationCaptured) for (const id of new Set([...(before.decisions ?? []).map(d => d.id), ...(current.decisions ?? []).map(d => d.id)])) change('Решение', JSON.stringify(before.decisions?.find(d => d.id === id)) ?? null, JSON.stringify(current.decisions?.find(d => d.id === id)) ?? null);
        if (before.organizationCaptured && current.organizationCaptured) for (const id of new Set([...(before.workPackages ?? []).map(d => d.id), ...(current.workPackages ?? []).map(d => d.id)])) change('Работа / веха', JSON.stringify(before.workPackages?.find(d => d.id === id)) ?? null, JSON.stringify(current.workPackages?.find(d => d.id === id)) ?? null);
      }
      return { goalId: current.goalId, leaderId: current.leaderId, baseline: before, current, comparable, actualDelta: comparable ? current.evaluation.actual! - before!.evaluation.actual! : null, reason: comparable ? 'Совпадают методика, состав, источники и пороги' : 'Нет двух сопоставимых фактов с зафиксированной методикой и составом', changes };
    }), dueActions: rows.flatMap(row => [...(row.plan?.nextAction && row.plan.nextCheckDate ? [{ goalId: row.goalId, leaderId: row.leaderId, action: row.plan.nextAction, dueDate: row.plan.nextCheckDate, owner: row.leaderName }] : []), ...(row.decisions ?? []).filter(d => d.state === 'open' && d.dueDate).map(d => ({ goalId: row.goalId, leaderId: row.leaderId, action: d.name, dueDate: d.dueDate!, owner: d.owner })), ...(row.workPackages ?? []).filter(work => !work.completed).map(work => ({goalId:row.goalId,leaderId:row.leaderId,action:work.title,dueDate:work.dueDate,owner:work.owner}))]).filter((a, index, all) => all.findIndex(b => JSON.stringify(a) === JSON.stringify(b)) === index).sort((a,b) => a.dueDate.localeCompare(b.dueDate)) };
  }
  return structuredClone(report);
}
export async function generateReport(context: ApplicationContext, session: Session, selection: ReportSelection) {
  const catalog = await context.catalogs.readForSession(session);
  const report = buildReport(catalog, context.db.list<LocalSnapshot>('snapshots').filter(s => canReadSnapshot(s,session,context.installationId)), context.db.list<Attestation>('attestations'), selection, session.name);
  const template = selection.templateId ? getReportTemplate(context, session, selection.templateId) : null;
  if (template && template.classification !== report.classification) throw new ActionError('Классификация шаблона и отчёта различается',400);
  if (template) assertTemplateCoverage(template.inspection,template.profile,report);
  if (template) report.template = { id: template.id, version: template.revision, name: template.profile.name };
  context.db.set('reports', report.id, { sessionId: session.id, report, ...(template ? { frozenTemplate: { base64: template.base64, profile: template.profile } } : {}) }); return report;
}
export async function readFrozenTemplatePptx(context: ApplicationContext, session: Session, id: string) {
  const report = readReport(context,session,id);
  const record = context.db.get<{ frozenTemplate?: { base64: string; profile: TemplateProfile } }>('reports',id);
  return record?.frozenTemplate ? renderTemplate(decodeTemplateBase64(record.frozenTemplate.base64),record.frozenTemplate.profile,report) : null;
}
export function readReport(context: ApplicationContext, session: Session, id: string): ReportSnapshot {
  const saved = context.db.get<{ sessionId: string; report: ReportSnapshot }>('reports', id);
  if (!saved || saved.sessionId !== session.id) throw new ActionError('Отчёт не найден в этой сессии. Сформируйте новый снимок.', 404);
  return saved.report;
}
