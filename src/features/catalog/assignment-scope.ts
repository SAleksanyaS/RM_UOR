import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { CatalogSnapshot, CuratorSession, Draft, KnowledgeEntity } from '../../domain/contracts';
import type { ApplicationContext } from '../../server/workspace/context';
import { ActionError } from '../identity/role-service';
import { canonicalJson } from '../publishing/merge-object';
import { validateCatalog } from '../publishing/validate-version';
import type { AssignmentScopeInput, AssignmentScopeResult } from './scope-contracts';
import { applyDraft } from './catalog-store';

const name = z.string().trim().min(1).max(500);
const inputSchema = z.object({ baseAssignment: z.object({ id: name, goalId: name, leaderId: name }).passthrough(),
  active: z.boolean(), teams: z.array(name).max(500), participantIds: z.array(name).max(5000).optional(),
  target: z.string().max(10000), summary: z.string().max(10000),
  newEntities: z.array(z.object({ clientId: name, type: z.enum(['team', 'product', 'it_service', 'scope']), name, selected: z.boolean() })).max(200).default([]) });
const cleanName = (value: string) => value.replace(/\s+/gu, ' ').trim();
const normalizeName = (value: string) => cleanName(value.normalize('NFKC')).toLocaleLowerCase('ru');
function uniqueNames(values: string[]) { return [...new Map(values.map(value => [normalizeName(value), cleanName(value)])).values()]; }
function signature(context: ApplicationContext, session: CuratorSession) {
  return canonicalJson({ catalog: context.db.get('catalog', 'active'),
    drafts: context.db.list<Draft>('drafts').filter(draft => draft.curatorId === session.curatorId).sort((a, b) => a.id.localeCompare(b.id)) });
}
/** The shared base excludes this curator's unpublished changes, preserving three-way merging. */
function sharedBase(context: ApplicationContext, session: CuratorSession): CatalogSnapshot {
  const catalog = structuredClone(context.db.get<CatalogSnapshot>('catalog', 'active')!);
  for (const draft of context.db.list<Draft>('drafts').filter(item => item.curatorId === session.curatorId && item.status === 'published').sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    applyDraft(catalog, draft);
  }
  return catalog;
}
function prepareDraft(context: ApplicationContext, session: CuratorSession, base: CatalogSnapshot,
  kind: 'entity' | 'assignment', id: string, patch: Record<string, unknown>): Draft {
  const previous = context.db.list<Draft>('drafts').find(item => item.curatorId === session.curatorId && item.status === 'local' && item.change.kind === kind && item.change.id === id);
  const original = (kind === 'entity' ? base.entities : base.assignments).find(item => item.id === id);
  return { id: previous?.id ?? randomUUID(), curatorId: session.curatorId, change: { kind, id, baseRevision: null, patch: { ...(previous?.change.patch ?? {}), ...patch } },
    base: previous ? previous.base : original ? structuredClone(original) as unknown as Record<string, unknown> : null,
    createdAt: new Date().toISOString(), status: 'local', error: null };
}

/** Accept scope and knowledge drafts in one transaction; never deletes history or shared entities. */
export async function saveAssignmentScope(context: ApplicationContext, session: CuratorSession, assignmentId: string, raw: AssignmentScopeInput): Promise<AssignmentScopeResult> {
  if (session.role !== 'curator' || !session.curatorId) throw new ActionError('Изменение состава доступно куратору УОР', 403);
  const input = inputSchema.parse(raw);
  if (new Set(input.newEntities.map(item => item.clientId)).size !== input.newEntities.length) throw new ActionError('Повторяются новые пункты списка. Уберите дубликат.', 400);
  const initialSignature = signature(context, session);
  const catalog = await context.catalogs.readForSession(session);
  const assignment = catalog.assignments.find(item => item.id === assignmentId);
  if (!assignment) throw new ActionError('Назначение не найдено', 404);
  if (canonicalJson(input.baseAssignment) !== canonicalJson(assignment)) throw new ActionError('Состав назначения уже изменился. Обновите карточку перед сохранением; введённые данные остаются в форме.', 409);
  const base = sharedBase(context, session);
  const createdEntities: AssignmentScopeResult['createdEntities'] = [], newRecords: KnowledgeEntity[] = [];
  for (const item of input.newEntities) {
    const entityType = item.type === 'it_service' ? 'service' : item.type;
    const matches = [...catalog.entities, ...newRecords].filter(entity => (entity.type === entityType || entityType === 'service' && entity.type === 'it_service')
      && (entity.leaderId === assignment.leaderId || item.type !== 'team' && !entity.leaderId)
      && [entity.name, ...(entity.aliases ?? [])].some(value => normalizeName(value) === normalizeName(item.name)));
    if (matches.length > 1) throw new ActionError(`Несколько записей «${cleanName(item.name)}». Выберите существующий пункт в списке.`, 400);
    let entity = matches[0];
    if (!entity) {
      const identity = createHash('sha256').update(canonicalJson([entityType, assignment.leaderId, normalizeName(item.name)])).digest('hex').slice(0, 24);
      entity = { id: `scope-${entityType}-${identity}`, type: entityType, name: cleanName(item.name), leaderId: assignment.leaderId };
      if (catalog.entities.some(existing => existing.id === entity!.id)) throw new ActionError('Запись с таким идентификатором уже существует. Обновите справочник.', 409);
      newRecords.push(entity);
    }
    createdEntities.push({ clientId: item.clientId, entity });
  }
  let participantIds = input.participantIds === undefined ? assignment.participantIds : [...new Set(input.participantIds)];
  const teams = uniqueNames(input.teams);
  for (const item of input.newEntities.filter(item => item.selected)) {
    const entity = createdEntities.find(created => created.clientId === item.clientId)!.entity;
    if (entity.type === 'team') participantIds = [...new Set([...(participantIds ?? []), entity.id])];
    else if (!teams.some(value => normalizeName(value) === normalizeName(entity.name))) teams.push(entity.name);
  }
  for (const id of participantIds ?? []) {
    if (assignment.participantIds?.includes(id)) continue;
    const entity = [...catalog.entities, ...newRecords].find(item => item.id === id);
    if (!entity || entity.type !== 'team' || entity.leaderId !== assignment.leaderId)
      throw new ActionError('Выберите расчётные команды этого ИТ-лидера. Неизвестную команду сначала добавьте в справочник.', 400);
  }
  const patch = { active: input.active, teams, target: input.target, summary: input.summary,
    ...(participantIds === undefined ? {} : { participantIds }) };
  const accepted = { ...assignment, ...patch };
  const candidate = structuredClone(catalog); candidate.assignments[candidate.assignments.findIndex(item => item.id === assignment.id)] = accepted;
  candidate.entities.push(...newRecords); validateCatalog(candidate);
  const drafts = newRecords.map(entity => prepareDraft(context, session, base, 'entity', entity.id, { ...entity }));
  drafts.push(prepareDraft(context, session, base, 'assignment', assignment.id, patch));
  const operation = await context.operations.start('import', 'Сохранение состава цели');
  let saved = false;
  try {
    await context.operations.stage(operation.id, { key: 'scope', label: 'Сохраняем команды, объекты и назначение' });
    context.db.transaction(() => {
      if (signature(context, session) !== initialSignature) throw new ActionError('Настройки изменились во время сохранения. Обновите карточку и повторите действие.', 409);
      for (const draft of drafts) context.db.set('drafts', draft.id, draft);
      for (const entity of newRecords) context.catalogs.recordChange(session, 'entity_added', entity.id, entity.name, {}, { ...entity }, operation.id);
      context.catalogs.recordChange(session, 'assignment_updated', assignment.id,
        `${catalog.goals.find(goal => goal.id === assignment.goalId)?.title ?? 'Состав цели'} · ${catalog.leaders.find(leader => leader.id === assignment.leaderId)?.name ?? ''}`,
        { ...assignment }, patch, operation.id);
    });
    saved = true;
    await context.operations.stage(operation.id, { key: 'recalculate', label: 'Пересчитываем охват и подтверждения' });
    await context.state(session);
    await context.operations.finish(operation.id, { status: 'completed', message: 'Состав и справочные записи сохранены на этом компьютере. Их можно отправить в общую версию.' });
    return { assignmentId: assignment.id, assignment: accepted, createdEntities, operationId: operation.id };
  } catch (error) {
    if (saved) {
      await context.operations.finish(operation.id, { status: 'partial', message: 'Состав сохранён. Не удалось завершить пересчёт; обновите данные.', details: [(error as Error).message] });
      return { assignmentId: assignment.id, assignment: accepted, createdEntities, operationId: operation.id };
    }
    await context.operations.finish(operation.id, { status: 'failed', message: (error as Error).message, details: ['Прежний состав и база знаний сохранены без изменений'] });
    throw error;
  }
}
