import { createHash, randomUUID } from 'node:crypto';
import type { CatalogSnapshot, Draft, KnowledgeEntity, Session } from '../../domain/contracts';
import type { ApplicationContext } from '../../server/workspace/context';
import { ActionError } from '../identity/role-service';
import { canonicalJson } from '../publishing/merge-object';
import { validateCatalog } from '../publishing/validate-version';
import { applyDraft } from '../catalog/catalog-store';
import { archiveKnowledgeSchema, knowledgeInputSchema } from './knowledge-schema';
import { isKnowledgeType, type KnowledgeInput, type KnowledgeRecord, type KnowledgeResult } from './knowledge-contracts';

const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const revision = (entity: KnowledgeEntity) => typeof (entity as Partial<KnowledgeRecord>).revision === 'string' ? (entity as KnowledgeRecord).revision : `legacy-${hash(entity)}`;
function record(entity: KnowledgeEntity): KnowledgeRecord {
  const extra = entity as Partial<KnowledgeRecord>;
  return { id: entity.id, type: entity.type as KnowledgeRecord['type'], name: entity.name, leaderId: entity.leaderId ?? null, productId: entity.productId ?? null,
    aliases: entity.aliases ?? [], description: extra.description ?? '', body: extra.body ?? '', links: extra.links ?? [], goalIds: extra.goalIds ?? [], revision: revision(entity), archivedAt: extra.archivedAt ?? null };
}
const signature = (context: ApplicationContext, session: Session) => hash({ catalog: context.db.get('catalog', 'active'),
  drafts: context.db.list<Draft>('drafts').filter(item => item.curatorId === session.curatorId) });
function requireCurator(session: Session) { if (session.role !== 'curator' || !session.curatorId) throw new ActionError('Изменение базы знаний доступно только куратору УОР', 403); }
const activeEntity = (entity: KnowledgeEntity) => !(entity as Partial<KnowledgeRecord>).archivedAt;
const normalizeName = (value: string) => value.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase('ru');
export async function listKnowledge(context: ApplicationContext, session: Session) {
  const catalog = await context.catalogs.readForSession(session);
  return { records: catalog.entities.filter(entity => isKnowledgeType(entity.type)).map(record) };
}
function requireLinks(catalog: CatalogSnapshot, input: KnowledgeInput) {
  if (input.leaderId && !catalog.leaders.some(leader => leader.id === input.leaderId)) throw new ActionError('ИТ-лидер не найден');
  if (input.goalIds.some(id => !catalog.goals.some(goal => goal.id === id))) throw new ActionError('Связанная цель не найдена');
  if (input.type === 'team' && !input.leaderId) throw new ActionError('Выберите ИТ-лидера команды');
  if (input.type === 'product_leader') {
    if (!input.productId || !input.leaderId) throw new ActionError('Для лидера продукта выберите продукт и ИТ-лидера');
    if (!catalog.entities.some(entity => entity.id === input.productId && entity.type === 'product' && activeEntity(entity))) throw new ActionError('Выберите действующий продукт из базы знаний');
  } else if (input.productId) throw new ActionError('Ссылка на продукт задаётся только для лидера продукта');
}
function usages(catalog: CatalogSnapshot, entity: KnowledgeEntity) {
  const names = new Set([entity.name, ...(entity.aliases ?? [])].map(normalizeName));
  return catalog.assignments.filter(item => item.active !== false && (item.participantIds?.includes(entity.id)
    || item.teams.some(name => names.has(normalizeName(name)))));
}
/** Legacy assignments carry names rather than IDs. Retain those names until
 * their active references are explicitly removed, including during alias edits. */
function retainedAliases(catalog: CatalogSnapshot, input: KnowledgeInput, before?: KnowledgeEntity): string[] {
  const candidates = [...input.aliases];
  if (before) {
    if (before.name !== input.name) candidates.push(before.name);
    const referencedNames = new Set(catalog.assignments.filter(item => item.active !== false).flatMap(item => item.teams.map(normalizeName)));
    candidates.push(...[before.name, ...(before.aliases ?? [])].filter(name => referencedNames.has(normalizeName(name))));
  }
  const unique = new Map<string, string>();
  for (const name of candidates) if (normalizeName(name) !== normalizeName(input.name)) unique.set(normalizeName(name), name);
  return [...unique.values()];
}
function validateArchive(catalog: CatalogSnapshot, entity: KnowledgeEntity) {
  const used = usages(catalog, entity);
  if (used.length) throw new ActionError(`Объект используется в активных назначениях: ${used.slice(0, 4).map(item => catalog.goals.find(goal => goal.id === item.goalId)?.title ?? item.goalId).join('; ')}. Сначала измените состав цели.`, 409);
  const links = catalog.entities.filter(item => item.productId === entity.id && activeEntity(item));
  if (links.length) throw new ActionError(`У продукта есть действующие связи: ${links.map(item => item.name).join('; ')}. Сначала архивируйте или измените эти связи.`, 409);
}
function persist(context: ApplicationContext, session: Session, catalog: CatalogSnapshot, initialSignature: string, accepted: KnowledgeRecord, before?: KnowledgeEntity): KnowledgeResult {
  return context.db.transaction(() => {
    if (signature(context, session) !== initialSignature) throw new ActionError('База знаний уже изменилась. Обновите запись; введённый текст остаётся в форме.', 409);
    const candidate = structuredClone(catalog); const index = candidate.entities.findIndex(entity => entity.id === accepted.id);
    if (index < 0) candidate.entities.push(accepted); else candidate.entities[index] = { ...candidate.entities[index], ...accepted };
    validateCatalog(candidate);
    const base = structuredClone(context.db.get<CatalogSnapshot>('catalog', 'active')!);
    for (const draft of context.db.list<Draft>('drafts').filter(item => item.curatorId === session.curatorId && item.status === 'published').sort((a, b) => a.createdAt.localeCompare(b.createdAt))) applyDraft(base, draft);
    const previous = context.db.list<Draft>('drafts').find(item => item.curatorId === session.curatorId && item.status === 'local' && item.change.kind === 'entity' && item.change.id === accepted.id);
    const original = base.entities.find(item => item.id === accepted.id);
    const draft: Draft = { id: previous?.id ?? randomUUID(), curatorId: session.curatorId!,
      change: { kind: 'entity', id: accepted.id, baseRevision: original ? revision(original) : null, patch: { ...previous?.change.patch, ...accepted } },
      base: previous ? previous.base : original ? { ...original } : null, createdAt: new Date().toISOString(), status: 'local', error: null };
    context.db.set('drafts', draft.id, draft);
    context.catalogs.recordChange(session, !before ? 'knowledge_created' : accepted.archivedAt && !record(before).archivedAt ? 'knowledge_archived'
      : !accepted.archivedAt && record(before).archivedAt ? 'knowledge_restored' : 'knowledge_updated', accepted.id, accepted.name, before ? { ...record(before) } : {}, { ...accepted });
    return { record: accepted, draftId: draft.id };
  });
}
export async function saveKnowledge(context: ApplicationContext, session: Session, raw: KnowledgeInput, id?: string): Promise<KnowledgeResult> {
  requireCurator(session); const input = knowledgeInputSchema.parse(raw), initialSignature = signature(context, session);
  const catalog = await context.catalogs.readForSession(session), before = id ? catalog.entities.find(entity => entity.id === id) : undefined;
  if (id && !before) throw new ActionError('Запись не найдена', 404);
  if (before && !isKnowledgeType(before.type)) throw new ActionError('Для этого объекта используйте специализированный раздел', 403);
  if (before && input.baseRevision !== revision(before)) throw new ActionError('Запись уже изменилась. Обновите версию перед сохранением; введённый текст остаётся в форме.', 409);
  if (before && input.type !== before.type) throw new ActionError('Тип существующей записи сохраняется, чтобы не изменять расчётный состав');
  requireLinks(catalog, input);
  if (before?.leaderId !== input.leaderId && before && usages(catalog, before).some(item => input.leaderId && item.leaderId !== input.leaderId))
    throw new ActionError('Команда используется в назначении другого ИТ-лидера. Сначала измените состав цели.', 409);
  const { baseRevision: _baseRevision, ...content } = knowledgeInputSchema.parse({ ...input, aliases: retainedAliases(catalog, input, before) });
  return persist(context, session, catalog, initialSignature, { id: id ?? randomUUID(), ...content, revision: randomUUID(), archivedAt: before ? record(before).archivedAt : null }, before);
}
export async function archiveKnowledge(context: ApplicationContext, session: Session, id: string, raw: { baseRevision: string; archived: boolean }): Promise<KnowledgeResult> {
  requireCurator(session); const input = archiveKnowledgeSchema.parse(raw), initialSignature = signature(context, session);
  const catalog = await context.catalogs.readForSession(session), before = catalog.entities.find(entity => entity.id === id);
  if (!before || !isKnowledgeType(before.type)) throw new ActionError('Запись не найдена', 404);
  if (revision(before) !== input.baseRevision) throw new ActionError('Запись уже изменилась. Обновите версию перед действием.', 409);
  if (input.archived) validateArchive(catalog, before); else requireLinks(catalog, { ...record(before), leaderId: before.leaderId ?? null, productId: before.productId ?? null, aliases: before.aliases ?? [] });
  return persist(context, session, catalog, initialSignature, { ...record(before), archivedAt: input.archived ? new Date().toISOString() : null, revision: randomUUID() }, before);
}
