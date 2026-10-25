import {rotateExecutionJournal} from './execution-journal';
import { randomUUID } from 'node:crypto';
import type { CatalogSnapshot, Draft, KnowledgeEntity, LocalSnapshot, Session } from '../../domain/contracts';
import type { ApplicationContext } from '../../server/workspace/context';
import { ActionError } from '../identity/role-service';
import { canonicalJson } from '../publishing/merge-object';
import { buildPlanningModel, moscowToday } from '../planning/planning-model';
import { buildPortfolioModel } from '../overview/portfolio-model';
import { getGoalHistory } from '../history/history-service';
import { historicalRules } from '../reporting/evaluation-basis';
import { completionInputSchema, checkInputSchema, configInputSchema, packageInputSchema, readExecutionConfig, readWorkPackage, validateExecutionEntities } from './execution-schema';
import { forecastGoal, isCompleted, retentionStatus, weightedAchievement } from './execution-model';
import type { ConfigInput, ExecutionConfig, ExecutionView, InboxItem, PackageInput, WorkPackage } from './execution-contracts';
const signature = (context: ApplicationContext, session: Session) => canonicalJson({ catalog: context.db.get('catalog', 'active'), drafts: context.db.list<Draft>('drafts').filter(d => d.curatorId === session.curatorId) });
function curator(session: Session) { if (session.role !== 'curator' || !session.curatorId) throw new ActionError('Изменение исполнения доступно куратору УОР', 403); }
function scope(catalog: CatalogSnapshot, goalId: string, leaderId: string | null) {
  const active = buildPortfolioModel({ catalog, evaluations: [], snapshots: [] }).goals.some(g => g.goal.id === goalId);
  if (!active) throw new ActionError('Выберите активную цель', 404);
  if (leaderId && !catalog.assignments.some(a => a.goalId === goalId && a.leaderId === leaderId && a.active !== false)) throw new ActionError('Нет активного назначения в выбранном контуре', 404);
}
async function persist(context: ApplicationContext, session: Session, catalog: CatalogSnapshot, initial: string, value: WorkPackage | ExecutionConfig, type: 'work_package' | 'execution_config', before?: KnowledgeEntity) {
  const rotated=rotateExecutionJournal(value,catalog),stored=rotated.record;
  const entity: KnowledgeEntity = { id: value.id, type, name: 'title' in value ? value.title : 'Исполнение и удержание', goalIds: [value.goalId], leaderId: value.leaderId, revision: value.revision, body: JSON.stringify(stored) };
  if (entity.body!.length > 100000) throw new ActionError('Журнал исполнения превышает размер одной записи. Сократите текст нового комментария или создайте следующую веху с новой базой.');
  const candidate = structuredClone(catalog);candidate.entities.push(...rotated.segments);const index = candidate.entities.findIndex(e => e.id === entity.id);
  if (index < 0) candidate.entities.push(entity); else candidate.entities[index] = entity;
  try { validateExecutionEntities(candidate); } catch (error) { throw new ActionError((error as Error).message, 400); }
  const draft = await context.catalogs.saveDraft(session, { kind: 'entity', id: entity.id, baseRevision: before?.revision ?? null, patch: { ...entity } }, {
    beforeSave: () => { if (signature(context, session) !== initial) throw new ActionError('Исполнение уже изменилось. Обновите версию; введённые данные сохранены в форме.', 409);for(const segment of rotated.segments){const draft:Draft={id:randomUUID(),curatorId:session.curatorId!,base:null,status:'local',error:null,createdAt:new Date().toISOString(),change:{kind:'entity',id:segment.id,baseRevision:null,patch:{...segment}}};context.db.set('drafts',draft.id,draft);} },
    afterSave: () => { context.catalogs.recordChange(session, 'execution_updated', entity.id, entity.name, before ? { ...before } : {}, { ...entity }); },
  });
  return { record: value, draftId: draft.id };
}
export async function saveWorkPackage(context: ApplicationContext, session: Session, raw: PackageInput) {
  curator(session); const input = packageInputSchema.parse(raw), initial = signature(context, session), catalog = await context.catalogs.readForSession(session);
  scope(catalog, input.goalId, input.leaderId);
  const before = input.id ? catalog.entities.find(e => e.id === input.id) : undefined;
  if (input.id && (!before || before.type !== 'work_package')) throw new ActionError('Веха не найдена', 404);
  if ((before?.revision ?? null) !== input.baseRevision) throw new ActionError('Веха уже изменена. Обновите версию; введённые данные остаются в форме.', 409);
  const previous = before ? readWorkPackage(before,catalog) : undefined;
  if (previous && (previous.goalId !== input.goalId || previous.leaderId !== input.leaderId)) throw new ActionError('Контур существующей вехи изменить нельзя');
  const { baseRevision: _, ...fields } = input;
  return persist(context, session, catalog, initial, { ...fields, id: before?.id ?? randomUUID(), revision: randomUUID(), baseline: previous?.baseline ?? null, ...(previous?.eventArchiveId?{eventArchiveId:previous.eventArchiveId}:{}), events: previous?.events ?? [] }, 'work_package', before);
}
export async function saveExecutionConfig(context: ApplicationContext, session: Session, raw: ConfigInput) {
  curator(session); const input = configInputSchema.parse(raw), initial = signature(context, session), catalog = await context.catalogs.readForSession(session);
  scope(catalog, input.goalId, input.leaderId);
  const before = input.id ? catalog.entities.find(e => e.id === input.id) : undefined;
  if (input.id && (!before || before.type !== 'execution_config')) throw new ActionError('Настройка не найдена', 404);
  if ((before?.revision ?? null) !== input.baseRevision) throw new ActionError('Настройки уже изменены. Обновите версию; введённые данные остаются в форме.', 409);
  const previous = before ? readExecutionConfig(before,catalog) : undefined;
  if (previous && (previous.goalId !== input.goalId || previous.leaderId !== input.leaderId)) throw new ActionError('Контур настройки изменить нельзя');
  const { baseRevision: _, ...fields } = input;
  return persist(context, session, catalog, initial, { ...fields, id: before?.id ?? randomUUID(), revision: randomUUID(), ...(previous?.checkArchiveId?{checkArchiveId:previous.checkArchiveId}:{}), checks: previous?.checks ?? [] }, 'execution_config', before);
}
async function editRecord(context: ApplicationContext, session: Session, id: string, baseRevision: string, type: 'work_package' | 'execution_config', change: (value: WorkPackage | ExecutionConfig, catalog: CatalogSnapshot) => WorkPackage | ExecutionConfig) {
  curator(session); const initial = signature(context, session), catalog = await context.catalogs.readForSession(session), before = catalog.entities.find(e => e.id === id && e.type === type);
  if (!before) throw new ActionError('Запись исполнения не найдена', 404);
  if (before.revision !== baseRevision) throw new ActionError('Запись уже изменилась. Обновите версию; введённые данные остаются в форме.', 409);
  const previous = type === 'work_package' ? readWorkPackage(before,catalog) : readExecutionConfig(before,catalog); scope(catalog, previous.goalId, previous.leaderId);
  return persist(context, session, catalog, initial, { ...change(previous, catalog), revision: randomUUID() }, type, before);
}
export async function baselinePackage(context: ApplicationContext, session: Session, id: string, baseRevision: string) {
  return editRecord(context, session, id, baseRevision, 'work_package', raw => {
    const p = raw as WorkPackage; if (p.baseline) throw new ActionError('Базовый план уже установлен и неизменяем', 409);
    return { ...p, baseline: { at: new Date().toISOString(), dueDate: p.dueDate, weight: p.weight, effortHours: p.effortHours } };
  });
}
export async function completePackage(context: ApplicationContext, session: Session, id: string, raw: unknown) {
  const input = completionInputSchema.parse(raw);
  return editRecord(context, session, id, input.baseRevision, 'work_package', (value, catalog) => {
    const p = value as WorkPackage;
    if (input.completed && p.dependencies.some(dep => !isCompleted(readWorkPackage(catalog.entities.find(e => e.id === dep)!,catalog)))) throw new ActionError('Сначала завершите все зависимости вехи', 409);
    return { ...p, events: [...p.events, { id: randomUUID(), at: new Date().toISOString(), completed: input.completed, comment: input.comment, evidence: input.evidence, actor: session.name }] };
  });
}
export async function checkRetention(context: ApplicationContext, session: Session, id: string, raw: unknown) {
  const input = checkInputSchema.parse(raw);
  return editRecord(context, session, id, input.baseRevision, 'execution_config', value => {
    const config = value as ExecutionConfig;
    if (!config.cadenceDays) throw new ActionError('Сначала настройте периодичность удержания');
    const at = new Date().toISOString(); const next = new Date(`${moscowToday()}T00:00:00Z`); next.setUTCDate(next.getUTCDate() + config.cadenceDays);
    return { ...config, nextCheckDate: next.toISOString().slice(0, 10), checks: [...config.checks, { id: randomUUID(), at, actor: session.name, comment: input.comment, evidence: input.evidence, result: input.result }] };
  });
}
export async function getExecutionView(context: ApplicationContext, session: Session): Promise<ExecutionView> {
  const state = await context.state(session), portfolio = buildPortfolioModel(state), activeIds = new Set(portfolio.goals.map(g => g.goal.id));
  const activeScope = (p: { goalId: string; leaderId: string | null }) => activeIds.has(p.goalId) && (p.leaderId === null || state.catalog.assignments.some(a => a.goalId === p.goalId && a.leaderId === p.leaderId && a.active !== false));
  const packages = state.catalog.entities.filter(e => e.type === 'work_package').map(entity=>readWorkPackage(entity,state.catalog)).filter(activeScope);
  const configs = state.catalog.entities.filter(e => e.type === 'execution_config').map(entity=>readExecutionConfig(entity,state.catalog)).filter(activeScope);
  const rows = [...buildPlanningModel(state).rows, ...state.catalog.leaders.flatMap(l => buildPlanningModel(state, { leaderId: l.id }).rows)];
  const forecasts = await Promise.all(rows.map(async row => {
    const leaderId = row.leader?.id ?? null, history = await getGoalHistory(context, session, row.goal.id, leaderId);
    let forecast = forecastGoal(row.goal, history.points);
    if (forecast.date) {
      const assignments = state.catalog.assignments.filter(a => a.goalId === row.goal.id && a.active !== false && (!leaderId || a.leaderId === leaderId));
      const currentRules = canonicalJson(historicalRules(row.goal, assignments));
      const compatible = history.points.at(-1)!.snapshotIds.every(id => {
        const basis = context.db.get<LocalSnapshot>('snapshots', id)?.evaluationBasis;
        return !!basis && canonicalJson(historicalRules(basis.goal, basis.assignments.filter(a => a.goalId === row.goal.id && a.active !== false && (!leaderId || a.leaderId === leaderId)))) === currentRules;
      });
      if (!compatible) forecast = { ...forecast, date: null, ratePerDay: null, reason: 'Текущая методика или ожидаемый состав отличаются от исторического ряда. Нужны новые сопоставимые периоды.' };
    }
    return { goalId: row.goal.id, leaderId, forecast };
  }));
  const inbox: InboxItem[] = [];
  for (const row of rows) {
    const prefix = `${row.goal.id}:${row.leader?.id ?? 'global'}`, same = (p: { goalId: string; leaderId: string | null }) => p.goalId === row.goal.id && p.leaderId === (row.leader?.id ?? null);
    const add = (category: InboxItem['category'], title: string, detail: string, overdue = false) => inbox.push({ id: `${prefix}:${category}`, goalId: row.goal.id, leaderId: row.leader?.id ?? null, category, title, detail, overdue });
    if (row.evaluation?.official === 'met' && row.evaluation.validation !== 'confirmed') add('achievement', 'Результат ожидает подтверждения', 'Положительный факт требует проверки куратора.');
    if (!row.evaluation || row.evaluation.official === 'unknown' || row.evaluation.qualityFlags.length) add('facts', 'Неполные или устаревшие факты', row.evaluation?.qualityFlags.join(', ') || 'Нет достаточных данных');
    if (!configs.some(same)) add('configuration', 'Настройка исполнения отсутствует', 'Не заданы ресурсные ограничения и правила удержания.');
    if (row.missingPlan || !packages.some(same)) add('plan', 'План требует заполнения', 'Нужны план работ и вехи данного контура.');
    const forecast = forecasts.find(f => same(f))!.forecast;
    if (!row.forecastDate && !forecast.date) add('forecast', 'Прогноз отсутствует', forecast.reason);
    for (const config of configs.filter(same)) { const status = retentionStatus(config, moscowToday()); if (status.status !== 'scheduled') add('retention', status.status === 'overdue' ? 'Просрочена проверка удержания' : 'Требуется проверка удержания', status.nextCheckDate ?? 'Периодичность не настроена', status.status === 'overdue'); }
  }
  if (session.role === 'curator') {
    for (const draft of state.drafts.filter(d => d.status === 'local')) inbox.push({ id: `draft:${draft.id}`, goalId: draft.change.kind === 'goal' ? draft.change.id : null, leaderId: null, category: 'draft', title: 'Неопубликованная правка', detail: `${draft.change.kind} · ${draft.error ?? 'Сохранена локально, не отправлена в общий каталог'}` });
    const diagnostics = context.db.list<{ ownerSessionId: string; sourceId: string; status: string; at: string; message: string }>('connector-diagnostics').filter(d => d.ownerSessionId === session.id);
    for (const diagnostic of diagnostics.filter(d => d.status !== 'accepted')) inbox.push({ id: `source:${diagnostic.sourceId}`, goalId: null, leaderId: null, category: 'source', title: `Не получен источник: ${state.catalog.sources.find(s => s.id === diagnostic.sourceId)?.name ?? diagnostic.sourceId}`, detail: `${diagnostic.at} · ${diagnostic.status} · ${diagnostic.message}` });
    if (!diagnostics.length) {
      const latest = state.operations.filter(o => o.kind === 'update').sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
      if (latest && ['failed', 'partial'].includes(latest.status)) inbox.push({ id: `source:${latest.id}`, goalId: null, leaderId: null, category: 'source', title: 'Ошибка последнего обновления источников', detail: `${latest.label}: ${latest.result?.message ?? latest.status}` });
    }
  }
  return { packages, configs, forecasts, inbox, weighted: weightedAchievement(portfolio.goals.map(g => g.goal), state.evaluations) };
}
