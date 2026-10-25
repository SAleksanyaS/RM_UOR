import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Assignment, CatalogSnapshot, CuratorSession, Draft, Leader } from '../../domain/contracts';
import type { ApplicationContext } from '../../server/workspace/context';
import { ActionError } from '../identity/role-service';
import { applyDraft, catalogCollection } from '../catalog/catalog-store';
import { canonicalJson } from '../publishing/merge-object';
import { validateCatalog } from '../publishing/validate-version';
import type { LeaderInput, LeaderResult } from './leader-contracts';

const id = z.string().min(1).max(500);
const inputSchema = z.object({ name: z.string().trim().min(1).max(500), clusterName: z.string().trim().max(500).nullable(),
  goalIds: z.array(id).max(10000), baseLeader: z.object({ id, name: id, teams: z.array(z.string()) }).passthrough().optional(), baseGoalIds: z.array(id).max(10000).optional() });
const clean = (value: string) => value.replace(/\s+/gu, ' ').trim();
const normalized = (value: string | null | undefined) => clean(value ?? '').normalize('NFKC').toLocaleLowerCase('ru');
const membership = (catalog: CatalogSnapshot, leaderId: string) => [...new Set(catalog.assignments.filter(a => a.leaderId === leaderId && a.active !== false).map(a => a.goalId))].sort();
const identity = (parts: string[]) => createHash('sha256').update(canonicalJson(parts)).digest('hex').slice(0, 24);
function signature(context: ApplicationContext, session: CuratorSession) {
  return canonicalJson({ catalog: context.db.get('catalog', 'active'), drafts: context.db.list<Draft>('drafts').filter(d => d.curatorId === session.curatorId).sort((a, b) => a.id.localeCompare(b.id)) });
}
function sharedBase(context: ApplicationContext, session: CuratorSession): CatalogSnapshot {
  const catalog = structuredClone(context.db.get<CatalogSnapshot>('catalog', 'active')!);
  for (const draft of context.db.list<Draft>('drafts').filter(d => d.curatorId === session.curatorId && d.status === 'published').sort((a, b) => a.createdAt.localeCompare(b.createdAt))) applyDraft(catalog, draft);
  return catalog;
}
function prepareDraft(context: ApplicationContext, session: CuratorSession, base: CatalogSnapshot, kind: 'leader' | 'assignment', itemId: string, patch: Record<string, unknown>): Draft {
  const previous = context.db.list<Draft>('drafts').find(d => d.curatorId === session.curatorId && d.status === 'local' && d.change.kind === kind && d.change.id === itemId);
  const original = catalogCollection(base, kind).find(item => item.id === itemId);
  return { id: previous?.id ?? randomUUID(), curatorId: session.curatorId, change: { kind, id: itemId, baseRevision: null, patch: { ...(previous?.change.patch ?? {}), ...patch } },
    base: previous ? previous.base : original ? structuredClone(original) as unknown as Record<string, unknown> : null,
    createdAt: new Date().toISOString(), status: 'local', error: null };
}

/** One atomic command changes the directory and current assignments; historical facts are untouched. */
export async function saveLeader(context: ApplicationContext, session: CuratorSession, leaderId: string | null, raw: LeaderInput): Promise<LeaderResult> {
  if (session.role !== 'curator' || !session.curatorId) throw new ActionError('Изменение ИТ-лидеров доступно куратору УОР', 403);
  const input = inputSchema.parse(raw), initialSignature = signature(context, session);
  const catalog = await context.catalogs.readForSession(session);
  const original = leaderId ? catalog.leaders.find(leader => leader.id === leaderId) : undefined;
  if (leaderId && !original) throw new ActionError('ИТ-лидер не найден', 404);
  if (original && (!input.baseLeader || canonicalJson(input.baseLeader) !== canonicalJson(original)
    || !input.baseGoalIds || canonicalJson([...new Set(input.baseGoalIds)].sort()) !== canonicalJson(membership(catalog, original.id))))
    throw new ActionError('Карточка или назначенные цели уже изменились. Обновите список и повторите сохранение; введённые данные остаются в форме.', 409);
  const name = clean(input.name), clusterName = clean(input.clusterName ?? '') || null;
  if (catalog.leaders.some(leader => leader.id !== leaderId && normalized(leader.name) === normalized(name) && normalized(leader.clusterName) === normalized(clusterName)))
    throw new ActionError('Такой ИТ-лидер и кластер уже есть. Откройте существующую карточку.', 409);
  const goalIds = [...new Set(input.goalIds)].sort();
  if (goalIds.some(goalId => !catalog.goals.some(goal => goal.id === goalId))) throw new ActionError('Выбрана неизвестная цель. Обновите список целей.', 400);
  const acceptedId = leaderId ?? `leader-${identity([normalized(name), normalized(clusterName)])}`;
  if (!original && catalog.leaders.some(leader => leader.id === acceptedId)) throw new ActionError('Идентификатор лидера уже существует. Обновите список.', 409);
  const leader: Leader = { ...(original ?? { id: acceptedId, teams: [] }), name, clusterName };
  const candidate = structuredClone(catalog);
  if (original) candidate.leaders[candidate.leaders.findIndex(l => l.id === original.id)] = leader; else candidate.leaders.push(leader);
  const base = sharedBase(context, session), drafts: Draft[] = [prepareDraft(context, session, base, 'leader', leader.id, { ...leader })];
  const assignmentChanges: { before: Assignment | null; after: Assignment }[] = [];
  for (const assignment of candidate.assignments.filter(a => a.leaderId === leader.id)) {
    const active = goalIds.includes(assignment.goalId);
    if ((assignment.active !== false) === active) continue;
    const before = structuredClone(assignment); assignment.active = active;
    drafts.push(prepareDraft(context, session, base, 'assignment', assignment.id, { active })); assignmentChanges.push({ before, after: assignment });
  }
  for (const goalId of goalIds) {
    if (candidate.assignments.some(a => a.leaderId === leader.id && a.goalId === goalId)) continue;
    const assignment: Assignment = { id: `assignment-${identity([leader.id, goalId])}`, leaderId: leader.id, goalId, active: true, teams: [] };
    if (candidate.assignments.some(a => a.id === assignment.id)) throw new ActionError('Назначение уже существует. Обновите список.', 409);
    candidate.assignments.push(assignment); drafts.push(prepareDraft(context, session, base, 'assignment', assignment.id, { ...assignment })); assignmentChanges.push({ before: null, after: assignment });
  }
  validateCatalog(candidate);
  const operation = await context.operations.start('import', original ? 'Изменение ИТ-лидера' : 'Добавление ИТ-лидера');
  let saved = false;
  try {
    await context.operations.stage(operation.id, { key: 'leader', label: 'Сохраняем ИТ-лидера и назначения целей' });
    context.db.transaction(() => {
      if (signature(context, session) !== initialSignature) throw new ActionError('Данные изменились во время сохранения. Обновите карточку и повторите действие.', 409);
      for (const draft of drafts) context.db.set('drafts', draft.id, draft);
      context.catalogs.recordChange(session, original ? 'leader_updated' : 'leader_added', leader.id, leader.name, { ...original }, { ...leader }, operation.id);
      for (const change of assignmentChanges) context.catalogs.recordChange(session, 'assignment_updated', change.after.id,
        `${leader.name} · ${catalog.goals.find(g => g.id === change.after.goalId)!.title}`, { ...change.before }, { ...change.after }, operation.id);
    });
    saved = true;
    await context.operations.stage(operation.id, { key: 'recalculate', label: 'Обновляем состав портфеля' });
    await context.state(session);
    await context.operations.finish(operation.id, { status: 'completed', message: 'ИТ-лидер и назначения сохранены в черновик. Отправьте изменения в общую версию.' });
    return { leader, goalIds, operationId: operation.id };
  } catch (error) {
    await context.operations.finish(operation.id, { status: saved ? 'partial' : 'failed', message: saved ? 'Изменения сохранены. Обновите страницу для пересчёта портфеля.' : (error as Error).message });
    if (saved) return { leader, goalIds, operationId: operation.id };
    throw error;
  }
}
