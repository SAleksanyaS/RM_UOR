import { createHash, randomUUID } from 'node:crypto';
import type { CatalogSnapshot, Draft, Session } from '../../domain/contracts';
import type { ApplicationContext } from '../../server/workspace/context';
import { ActionError } from '../identity/role-service';
import { canonicalJson } from '../publishing/merge-object';
import { applyDraft } from '../catalog/catalog-store';
import { currentWeekStart, getWeeklyBriefs, readWeeklyBrief, validateWeeklyBriefEntities, weeklyBriefBodySchema, weeklyBriefSaveSchema, weeklyBriefWeekSchema,
  type WeeklyBriefEntity, type WeeklyBriefSaveResult, type WeeklyReportView } from './contracts';

const signature = (context: ApplicationContext, session: Session) => canonicalJson({ catalog: context.db.get('catalog', 'active'),
  drafts: context.db.list<Draft>('drafts').filter(draft => draft.curatorId === session.curatorId).sort((a, b) => a.id.localeCompare(b.id)) });

async function ownWeeklyCatalog(context: ApplicationContext, session: Session, shared: CatalogSnapshot) {
  const catalog = structuredClone(shared), drafts = await context.catalogs.listDrafts(session, true), weeklyDrafts: Draft[] = [];
  // A successful in-flight publication can rebase a newer edit to a partial
  // patch. Its sent base may not exist in main yet, so restore it before reading.
  for (const draft of [...drafts.filter(item => item.status === 'published'), ...drafts.filter(item => item.status === 'local')]) {
    if (draft.change.kind !== 'entity') continue;
    const base = catalog.entities.find(entity => entity.id === draft.change.id) ?? draft.base;
    const entity = { ...base, ...draft.change.patch, id: draft.change.id } as unknown as WeeklyBriefEntity;
    if (entity.type !== 'weekly_brief' || readWeeklyBrief(entity).ownerId !== session.curatorId) continue;
    const materialized = { ...draft, change: { ...draft.change, patch: { ...entity } } };
    weeklyDrafts.push(materialized); applyDraft(catalog, materialized);
  }
  validateWeeklyBriefEntities(catalog);
  return { catalog, weeklyDrafts };
}

/** The shared catalog is the only source for a reader; private weeks are not listed. */
export async function listWeeklyReports(context: ApplicationContext, session: Session, rawWeek?: string): Promise<WeeklyReportView> {
  const weekStart = weeklyBriefWeekSchema.parse(rawWeek ?? currentWeekStart()), shared = await context.catalogs.read();
  const published = getWeeklyBriefs(shared), weeks = new Set(published.map(record => record.weekStart));
  let own: WeeklyReportView['own'] = null;
  if (session.role === 'curator' && session.curatorId) {
    const { catalog: effective, weeklyDrafts: ownDrafts } = await ownWeeklyCatalog(context, session, shared);
    const ownRecords = getWeeklyBriefs(effective).filter(record => record.ownerId === session.curatorId);
    ownRecords.forEach(record => weeks.add(record.weekStart));
    const record = ownRecords.find(item => item.weekStart === weekStart);
    if (record) {
      const isShared = published.some(item => item.id === record.id && item.revision === record.revision);
      const local = ownDrafts.some(item => item.status === 'local' && item.change.id === record.id && item.change.patch.revision === record.revision);
      own = { record, visibility: isShared ? 'published' : local ? 'local' : 'release' };
    }
  }
  weeks.add(weekStart);
  return { weekStart, weeks: [...weeks].sort().reverse(), published: published.filter(record => record.weekStart === weekStart), own };
}

export async function saveWeeklyBrief(context: ApplicationContext, session: Session, raw: unknown): Promise<WeeklyBriefSaveResult> {
  if (session.role !== 'curator' || !session.curatorId) throw new ActionError('Недельную сводку может изменять только её куратор УОР', 403);
  const input = weeklyBriefSaveSchema.parse(raw), beforeSignature = signature(context, session);
  const { catalog } = await ownWeeklyCatalog(context, session, await context.catalogs.read());
  const previous = getWeeklyBriefs(catalog, input.weekStart).find(record => record.ownerId === session.curatorId);
  if ((previous?.revision ?? null) !== input.baseRevision) throw new ActionError('Сводка уже изменилась. Обновите данные перед сохранением. Введённый текст остаётся в форме.', 409);
  const id = previous?.id ?? `weekly-brief-${createHash('sha256').update(session.curatorId).digest('hex').slice(0, 32)}-${input.weekStart}`;
  if (!previous && catalog.entities.some(entity => entity.id === id)) throw new ActionError('Идентификатор сводки занят другой записью', 409);
  const { baseRevision: _baseRevision, ...content } = input;
  const body = weeklyBriefBodySchema.parse({ ...content, schemaVersion: 1, ownerId: session.curatorId, ownerName: session.name, updatedAt: new Date().toISOString() });
  const entity: WeeklyBriefEntity = { id, type: 'weekly_brief', name: `Недельная сводка ${input.weekStart} · ${session.name}`, body: JSON.stringify(body), revision: randomUUID() };
  const record = readWeeklyBrief(entity);
  const candidate = structuredClone(catalog); const index = candidate.entities.findIndex(item => item.id === id);
  if (index < 0) candidate.entities.push(entity); else candidate.entities[index] = entity;
  validateWeeklyBriefEntities(candidate);
  const draft = await context.catalogs.saveDraft(session, { kind: 'entity', id, baseRevision: previous?.revision ?? null, patch: { ...entity } }, {
    beforeSave: () => { if (signature(context, session) !== beforeSignature) throw new ActionError('Каталог изменился во время сохранения. Обновите данные и повторите действие; текст остаётся в форме.', 409); },
    afterSave: () => context.catalogs.recordChange(session, previous ? 'weekly_brief_updated' : 'weekly_brief_added', id, entity.name, previous ? { ...previous } : {}, { ...record }),
  });
  return { record, draftId: draft.id };
}
