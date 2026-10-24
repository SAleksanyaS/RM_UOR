import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { CatalogSnapshot, CatalogChange, Session, Draft, DomainChangeEvent, Goal } from '../../domain/contracts';
import { LocalDatabase } from '../../server/storage/database';
import { ActionError } from '../identity/role-service';
import { getDirections, normalizeDirections } from './directions';

export const goalPatchSchema = z.object({
  title: z.string().trim().min(1).max(500).optional(), summary: z.string().max(10000).optional(),
  target: z.string().max(10000).optional(), metric: z.string().max(1000).optional(),
  officialTarget: z.number().finite().nullable().optional(), internalTarget: z.number().finite().nullable().optional(),
  ownerId: z.string().max(200).nullable().optional(), curatorId: z.string().max(200).nullable().optional(),
  weight: z.number().min(0).max(1000).nullable().optional(), priority: z.enum(['high', 'normal', 'low']).nullable().optional(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  direction: z.enum(['increase', 'decrease']).optional(), baseline: z.number().finite().nullable().optional(),
  unit: z.string().max(50).optional(), status: z.string().max(100).optional(), category: z.enum(['process', 'data', 'architecture', 'security']).optional(),
  actions: z.array(z.string().max(2000)).max(50).optional(), links: z.array(z.object({ label: z.string().max(200), url: z.string().url().refine(s => /^https?:\/\//.test(s)), kind: z.string().max(50) })).max(50).optional(),
  requiredMetricIds: z.array(z.string().min(1).max(200)).max(100).optional(),
  workDirectionId: z.string().min(1).max(500).nullable().optional()
});
export const directionPatchSchema = z.object({ name: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(5000).optional(), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  order: z.number().finite().min(0).max(100000).optional() });
function applyDraft(catalog: CatalogSnapshot, draft: Draft) {
  const collection = draft.change.kind === 'direction' ? (catalog.directions ??= []) : draft.change.kind === 'goal' ? catalog.goals : draft.change.kind === 'assignment' ? catalog.assignments : draft.change.kind === 'comment' ? catalog.comments : draft.change.kind === 'source' ? catalog.sources : catalog.entities;
  const item = collection.find(value => value.id === draft.change.id);
  if (item) Object.assign(item, draft.change.patch); else collection.push(draft.change.patch as never);
}
export class CatalogStore {
  constructor(private db: LocalDatabase) {}
  async read(): Promise<CatalogSnapshot> { const result = this.db.get<CatalogSnapshot>('catalog', 'active'); if (!result) throw new Error('Каталог не загружен'); return normalizeDirections(result); }
  async readForSession(session: Session): Promise<CatalogSnapshot> {
    const catalog = structuredClone(await this.read());
    if (session.role !== 'curator') return catalog;
    const drafts = await this.listDrafts(session, true);
    // Sent release changes form the effective shared base; a current local draft
    // must stay above that base even when saves have the same millisecond stamp.
    for (const draft of drafts.filter(item => item.status === 'published')) applyDraft(catalog, draft);
    for (const draft of drafts.filter(item => item.status === 'local')) applyDraft(catalog, draft);
    return catalog;
  }
  async saveDraft(session: Session, change: CatalogChange): Promise<Draft> {
    if (session.role !== 'curator' || !session.curatorId) throw new ActionError('Изменение доступно куратору УОР', 403);
    const baseCatalog = structuredClone(await this.read());
    // Main may still await the release chief's merge. A new edit is based on
    // already-sent content visible to this curator, never on its own local edit.
    for (const sent of (await this.listDrafts(session, true)).filter(item => item.status === 'published')) applyDraft(baseCatalog, sent);
    const collection = change.kind === 'direction' ? (baseCatalog.directions ??= []) : change.kind === 'goal' ? baseCatalog.goals : change.kind === 'assignment' ? baseCatalog.assignments : change.kind === 'comment' ? baseCatalog.comments : change.kind === 'source' ? baseCatalog.sources : baseCatalog.entities;
    const original = collection.find(item => item.id === change.id) as unknown as Record<string, unknown> | undefined;
    const existing = this.db.list<Draft>('drafts').find(d => d.curatorId === session.curatorId && d.change.kind === change.kind && d.change.id === change.id && d.status === 'local');
    if (change.kind === 'goal') {
      const patch = goalPatchSchema.parse(change.patch);
      if (patch.workDirectionId && !getDirections(await this.readForSession(session)).some(direction => direction.id === patch.workDirectionId))
        throw new ActionError('Направление не найдено', 400);
      change.patch = { ...patch, revision: randomUUID() };
    }
    if (change.kind === 'direction') change.patch = { id: change.id, ...directionPatchSchema.parse(change.patch) };
    const draft: Draft = { id: existing?.id ?? randomUUID(), curatorId: session.curatorId, change: { ...change, patch: { ...(existing?.change.patch ?? {}), ...change.patch } }, base: existing ? existing.base : (original ? structuredClone(original) : null), createdAt: new Date().toISOString(), status: 'local', error: null };
    this.db.set('drafts', draft.id, draft); return draft;
  }
  async listDrafts(session: Session, includePublished = false): Promise<Draft[]> {
    return this.db.list<Draft>('drafts').filter(d => session.role === 'curator' && d.curatorId === session.curatorId && (includePublished || d.status === 'local')).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  recordChange(session: Session, kind: string, objectId: string, objectLabel: string, before: Record<string, unknown>, after: Record<string, unknown>, operationId?: string) {
    const fields = Object.keys(after).filter(k => JSON.stringify(before[k]) !== JSON.stringify(after[k])).map(field => ({ field, before: before[field] ?? null, after: after[field] }));
    const event: DomainChangeEvent = { id: randomUUID(), kind, objectId, objectLabel, actor: session.name, at: new Date().toISOString(), fields, operationId };
    this.db.set('changes', event.id, event); return event;
  }
}
