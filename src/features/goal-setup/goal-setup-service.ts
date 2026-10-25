import { createHash, randomUUID } from 'node:crypto';
import type { Assignment, CatalogSnapshot, CuratorSession, Draft, Goal, Observation, Operation, SourceDefinition } from '../../domain/contracts';
import type { ApplicationContext } from '../../server/workspace/context';
import { ActionError } from '../identity/role-service';
import { evaluateGoal } from '../evaluation/evaluate';
import { applyDraft, catalogCollection } from '../catalog/catalog-store';
import { canonicalJson } from '../publishing/merge-object';
import { validateCatalog } from '../publishing/validate-version';
import { goalSetupInputSchema } from './goal-setup-schema';
import type { GoalSetupCommit, GoalSetupInput, GoalSetupPreview } from './goal-setup-contracts';

const TTL = 30 * 60_000;
const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
interface PrivatePreview { public: GoalSetupPreview; curatorId: string; requestId: string; inputHash: string; signature: string; changes: Draft['change'][] }
const privatePreviews = new WeakMap<ApplicationContext, Map<string, PrivatePreview>>();
interface Committed { inputHash: string; result: GoalSetupCommit }
function previews(context: ApplicationContext) {
  let map = privatePreviews.get(context);
  if (!map) { map = new Map(); privatePreviews.set(context, map); }
  for (const [id, stored] of map) if (Date.parse(stored.public.expiresAt) < Date.now()) map.delete(id);
  return map;
}
function requireCurator(session: CuratorSession) { if (session.role !== 'curator' || !session.curatorId) throw new ActionError('Настройка доступна только куратору УОР', 403); }
const requestKey = (curatorId: string, requestId: string) => hash([curatorId, requestId]);
function signature(context: ApplicationContext, session: CuratorSession) {
  return hash({ catalog: context.db.get('catalog', 'active'), drafts: context.db.list<Draft>('drafts').filter(draft => draft.curatorId === session.curatorId).sort((a, b) => a.id.localeCompare(b.id)) });
}
export async function previewGoalSetup(context: ApplicationContext, session: CuratorSession, raw: GoalSetupInput): Promise<GoalSetupPreview> {
  requireCurator(session);
  const input = goalSetupInputSchema.parse(raw), inputHash = hash(input), map = previews(context);
  const global = input.goal.scopeType === 'global';
  const committed = context.db.get<Committed>('goal-setup-commits', requestKey(session.curatorId, input.requestId));
  if (committed && committed.inputHash !== inputHash) throw new ActionError('Этот идентификатор запроса уже использован с другим содержимым. Создайте новую проверку.', 409);
  const prior = [...map.values()].find(item => item.curatorId === session.curatorId && item.requestId === input.requestId);
  if (prior) {
    if (prior.inputHash !== inputHash) throw new ActionError('Этот идентификатор запроса уже использован с другим содержимым. Создайте новую проверку.', 409);
    if (prior.signature === signature(context, session) || committed) return structuredClone(prior.public);
  }
  const basisSignature = signature(context, session), catalog = await context.catalogs.readForSession(session);
  if (basisSignature !== signature(context, session)) throw new ActionError('Каталог изменился. Повторите проверку.', 409);
  const existing = input.goalId ? catalog.goals.find(goal => goal.id === input.goalId) : undefined;
  if (input.goalId && !existing) throw new ActionError('Цель не найдена', 404);
  if (existing && input.baseRevision !== existing.revision) throw new ActionError('Цель изменилась. Обновите её и повторите проверку.', 409);
  if (!existing && input.baseRevision) throw new ActionError('Для новой цели не задаётся исходная версия');
  if (new Set(input.assignments.map(item => item.leaderId)).size !== input.assignments.length) throw new ActionError('ИТ-лидер повторяется в назначениях');
  const seenParticipants = new Set<string>();
  for (const item of input.assignments) {
    if (!catalog.leaders.some(leader => leader.id === item.leaderId)) throw new ActionError('Выбран неизвестный ИТ-лидер');
    for (const participantId of item.participantIds) {
      if (seenParticipants.has(participantId)) throw new ActionError('Участник повторяется в назначениях');
      seenParticipants.add(participantId);
      if (participantId !== item.leaderId && !catalog.entities.some(entity => entity.id === participantId && !entity.archivedAt && (!entity.leaderId || entity.leaderId === item.leaderId)))
        throw new ActionError('Участник не найден в составе выбранного ИТ-лидера');
    }
  }
  const id = existing?.id ?? committed?.result.goalId ?? randomUUID();
  const goal: Goal = { id, target: '', metric: input.measurement.metrics.map(metric => metric.name).join(', '),
    status: '', summary: '', actions: [], scopeType: 'participant', links: [], ownerId: null, curatorId: session.curatorId,
    baseline: null, weight: null, priority: null, dueDate: null,
    ...existing, ...input.goal, revision: randomUUID(), measurement: input.measurement, requiredMetricIds: input.measurement.metrics.map(metric => metric.id) };
  const assignments: Assignment[] = input.assignments.map(item => {
    const old = catalog.assignments.find(assignment => assignment.goalId === id && assignment.leaderId === item.leaderId);
    return { ...old, id: old?.id ?? randomUUID(), goalId: id, leaderId: item.leaderId, participantIds: item.participantIds,
      teams: item.participantIds.map(participantId => catalog.entities.find(entity => entity.id === participantId)?.name ?? catalog.leaders.find(leader => leader.id === participantId)?.name ?? participantId), active: true };
  });
  const superseded = catalog.assignments.filter(item => item.goalId === id && item.active !== false && !assignments.some(current => current.id === item.id)).map(item => ({ ...item, active: false }));
  const sourceOriginal = input.source.existingSourceId ? catalog.sources.find(source => source.id === input.source.existingSourceId) : undefined;
  if (input.source.existingSourceId && !sourceOriginal) throw new ActionError('Источник не найден', 404);
  if (!sourceOriginal && (!input.source.kind || !input.source.name)) throw new ActionError('Укажите название и вид нового источника');
  const source: SourceDefinition = sourceOriginal ? { ...sourceOriginal, goalIds: [...new Set([...sourceOriginal.goalIds, id])] } : {
    id: randomUUID(), name: input.source.name!, kind: input.source.kind!, url: input.source.url ?? null, accessUrl: input.source.accessUrl ?? null,
    freshnessHours: input.source.freshnessHours ?? 168, goalIds: [id], mode: ['manual', 'file', 'demo', 'attachment'].includes(input.source.kind!) ? 'local' : 'stub' };
  for (const row of input.sample.rows) {
    if (global ? row.leaderId !== null || row.participantId !== 'global-dit' : !assignments.some(item => item.leaderId === row.leaderId && item.participantIds!.includes(row.participantId))) throw new ActionError('Пробная строка относится к участнику вне выбранного состава');
    if (!goal.requiredMetricIds!.includes(row.metricId)) throw new ActionError('Пробная строка содержит неизвестный показатель');
    if (row.state === 'numeric' && row.value === null) throw new ActionError('Для числовой строки укажите значение');
    if (row.state !== 'numeric' && row.value !== null) throw new ActionError('У исключения или пропуска не должно быть числового значения');
    if (['exception', 'no_events'].includes(row.state) && !row.reason?.trim()) throw new ActionError('Укажите основание исключения или отсутствия событий');
  }
  const changes: Draft['change'][] = [ { kind: 'goal', id, baseRevision: existing?.revision ?? null, patch: { ...goal } },
    ...[...assignments, ...superseded].map(assignment => ({ kind: 'assignment' as const, id: assignment.id, baseRevision: null, patch: { ...assignment } })),
    { kind: 'source', id: source.id, baseRevision: null, patch: { ...source } } ];
  const candidate = structuredClone(catalog);
  for (const change of changes) applyDraft(candidate, { change } as Draft);
  validateCatalog(candidate);
  const observations: Observation[] = input.sample.rows.map((row, index) => {
    const metric = input.measurement.metrics.find(metric => metric.id === row.metricId)!;
    return { ...row, id: `sample-${index}`, goalId: id, participantName: row.participantId, metricName: metric.name, target: metric.target, unit: metric.unit,
      period: input.sample.period, sourceId: source.id, sourceUpdatedAt: null, downloadedAt: '' };
  });
  const evaluations = [null, ...assignments.map(item => item.leaderId)].map(leaderId => evaluateGoal({ goal, observations, period: input.sample.period, leaderId,
    expectedParticipants: global ? ['global-dit'] : assignments.filter(item => !leaderId || item.leaderId === leaderId).flatMap(item => item.participantIds!), expectedMetricIds: goal.requiredMetricIds }));
  const warnings = ['Пробные значения не сохраняются в рабочих данных. Выполнение требует отдельного подтверждения УОР.'];
  if (evaluations.some(item => item.official === 'unknown')) warnings.push('Пробный набор неполон или неоднозначен. Рабочий результат остаётся неизвестным.');
  if (source.mode === 'stub') warnings.push('Автоматический сбор из этого источника ещё не подключён.');
  const result: GoalSetupPreview = { previewId: randomUUID(), expiresAt: new Date(Date.now() + TTL).toISOString(), goal, assignments, source, evaluations, warnings };
  map.set(result.previewId, { public: result, curatorId: session.curatorId, requestId: input.requestId, inputHash, signature: basisSignature, changes });
  return structuredClone(result);
}

export async function commitGoalSetup(context: ApplicationContext, session: CuratorSession, previewId: string): Promise<GoalSetupCommit> {
  requireCurator(session);
  // Read expired entries first to return an explicit expiry error; pruning happens on preview creation.
  const stored = privatePreviews.get(context)?.get(previewId);
  if (!stored || stored.curatorId !== session.curatorId) throw new ActionError('Предварительная проверка не найдена. Повторите её.', 404);
  const key = requestKey(session.curatorId, stored.requestId), committed = context.db.get<Committed>('goal-setup-commits', key);
  if (committed) {
    if (committed.inputHash !== stored.inputHash) throw new ActionError('Запрос уже сохранён с другим содержимым', 409);
    return committed.result;
  }
  if (Date.parse(stored.public.expiresAt) < Date.now()) throw new ActionError('Срок предварительной проверки истёк. Повторите её.', 409);
  const catalog = await context.catalogs.readForSession(session);
  return context.db.transaction(() => {
    const alreadySaved = context.db.get<Committed>('goal-setup-commits', key);
    if (alreadySaved) {
      if (alreadySaved.inputHash !== stored.inputHash) throw new ActionError('Запрос уже сохранён с другим содержимым', 409);
      return alreadySaved.result;
    }
    if (signature(context, session) !== stored.signature) throw new ActionError('Каталог или черновики изменились. Предварительная проверка устарела; повторите её.', 409);
    const candidate = structuredClone(catalog);
    for (const change of stored.changes) applyDraft(candidate, { change } as Draft);
    validateCatalog(candidate);
    const baseCatalog = structuredClone(context.db.get<CatalogSnapshot>('catalog', 'active')!);
    for (const draft of context.db.list<Draft>('drafts').filter(item => item.curatorId === session.curatorId && item.status === 'published')) applyDraft(baseCatalog, draft);
    const at = new Date().toISOString(), operationId = randomUUID();
    const operation: Operation = { id: operationId, kind: 'import', label: 'Настройка цели', status: 'completed', startedAt: at, stageStartedAt: at, finishedAt: at,
      stage: { key: 'drafts', label: 'Связанные черновики сохранены' }, result: { status: 'completed', message: 'Паспорт, методика, назначения и источник сохранены. Опубликуйте общие определения.' },
      events: [{ id: 1, at, stage: { key: 'drafts', label: 'Связанные черновики сохранены' }, message: 'Пробные значения не добавлялись к рабочим фактам' }] };
    const draftIds: string[] = [];
    for (const change of stored.changes) {
      const previous = context.db.list<Draft>('drafts').find(item => item.curatorId === session.curatorId && item.status === 'local' && item.change.kind === change.kind && item.change.id === change.id);
      const original = catalogCollection(baseCatalog, change.kind).find(item => item.id === change.id);
      const draft: Draft = { id: previous?.id ?? randomUUID(), curatorId: session.curatorId, change: { ...change, patch: { ...previous?.change.patch, ...change.patch } },
        base: previous ? previous.base : original ? structuredClone(original) as unknown as Record<string, unknown> : null, createdAt: at, status: 'local', error: null };
      context.db.set('drafts', draft.id, draft); draftIds.push(draft.id);
      context.catalogs.recordChange(session, 'goal_setup', change.id, stored.public.goal.title, original ? { ...original } : {}, change.patch, operationId);
    }
    context.db.set('operations', operationId, operation);
    const result: GoalSetupCommit = { goalId: stored.public.goal.id, draftIds, operationId };
    context.db.set('goal-setup-commits', key, { inputHash: stored.inputHash, result } satisfies Committed);
    return result;
  });
}
