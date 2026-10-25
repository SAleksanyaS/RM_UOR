import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { CatalogSnapshot, CuratorSession } from '../../domain/contracts';
import { createContext, type ApplicationContext } from '../../server/workspace/context';
import { listKnowledge, saveKnowledge, archiveKnowledge } from './knowledge-service';
import type { KnowledgeInput } from './knowledge-contracts';
import demo from '../../../catalog/demo.json';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { registerKnowledgeRoutes } from './knowledge-routes';
const roots: string[] = [], contexts: ApplicationContext[] = [];
const curator: CuratorSession = { id: 'curator', role: 'curator', curatorId: 'curator', name: 'Куратор', createdAt: new Date().toISOString() };
async function setup() { const root = await mkdtemp(join(tmpdir(), 'knowledge-')); roots.push(root); const context = await createContext({ projectRoot: root, initialCatalog: structuredClone(demo) as CatalogSnapshot }); contexts.push(context); return context; }
const input = (extra: Partial<KnowledgeInput> = {}): KnowledgeInput => ({ type: 'article', name: 'Методика расчёта', description: 'Правила', body: 'Первый шаг\n<script>alert(1)</script>',
  leaderId: null, productId: null, aliases: [], links: [{ label: 'Источник', url: 'https://example.com/method' }], goalIds: [], ...extra });
afterEach(async () => { for (const context of contexts.splice(0)) context.db.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
it('lists without writes and omits protected director records', async () => {
  const context = await setup(); const catalog = await context.catalogs.read(); catalog.entities.push({ id: 'private-decision', type: 'decision', name: 'Решение' }); context.db.set('catalog', 'active', catalog);
  const before = context.db.list('changes'); const result = await listKnowledge(context, await context.roles.enterReader());
  expect(result.records.some(item => item.id === 'private-decision')).toBe(false); expect(context.db.list('changes')).toEqual(before); expect(context.db.list('drafts')).toEqual([]);
});
it('saves complete article text in shared entity drafts and enforces safe links and curator role', async () => {
  const context = await setup();
  await expect(saveKnowledge(context, await context.roles.enterReader(), input())).rejects.toThrow();
  await expect(saveKnowledge(context, curator, input({ links: [{ label: 'Недопустимо', url: 'javascript:alert(1)' }] }))).rejects.toThrow();
  const saved = await saveKnowledge(context, curator, input());
  expect(saved.record.body).toBe('Первый шаг\n<script>alert(1)</script>'); expect(saved.draftId).toBeTruthy();
  expect((await context.catalogs.read()).entities.some(item => item.id === saved.record.id)).toBe(false);
  expect((await listKnowledge(context, curator)).records.find(item => item.id === saved.record.id)?.links[0].url).toBe('https://example.com/method');
  expect(context.db.list('changes')).toHaveLength(1);
});
it('uses CAS for sequential and concurrent changes and preserves entered drafts', async () => {
  const context = await setup(); const saved = await saveKnowledge(context, curator, input());
  const update = input({ name: 'Обновлено', baseRevision: saved.record.revision });
  const outcomes = await Promise.allSettled([saveKnowledge(context, curator, update, saved.record.id), saveKnowledge(context, curator, { ...update, name: 'Другой редактор' }, saved.record.id)]);
  expect(outcomes.filter(item => item.status === 'fulfilled')).toHaveLength(1); expect(outcomes.filter(item => item.status === 'rejected')).toHaveLength(1);
  await expect(saveKnowledge(context, curator, update, saved.record.id)).rejects.toThrow(/измен|верси/i);
  expect(context.db.list('drafts')).toHaveLength(1);
});
it('prevents archiving active participants and permits archive after explicit removal and restore', async () => {
  const context = await setup(); const catalog = await context.catalogs.read(); const leader = catalog.leaders[0];
  catalog.entities.push({ id: 'used-team', type: 'team', name: 'Действующая команда', leaderId: leader.id });
  catalog.assignments[0].participantIds = ['used-team']; context.db.set('catalog', 'active', catalog);
  const record = (await listKnowledge(context, curator)).records.find(item => item.id === 'used-team')!;
  await expect(archiveKnowledge(context, curator, record.id, { baseRevision: record.revision, archived: true })).rejects.toThrow(/назначен|использ/i);
  catalog.assignments[0].active = false; context.db.set('catalog', 'active', catalog);
  const archived = await archiveKnowledge(context, curator, record.id, { baseRevision: record.revision, archived: true });
  expect(archived.record.archivedAt).toBeTruthy();
  const restored = await archiveKnowledge(context, curator, record.id, { baseRevision: archived.record.revision, archived: false });
  expect(restored.record.archivedAt).toBeNull(); expect(restored.record.id).toBe('used-team');
});
it('preserves legacy assignment names through renames and alias edits so archive protection cannot be bypassed', async () => {
  const context = await setup(); const catalog = await context.catalogs.read(); const assignment = catalog.assignments[0];
  catalog.entities.push({ id: 'legacy-team', type: 'team', name: 'Команда А', leaderId: assignment.leaderId });
  assignment.teams = ['Команда А']; delete assignment.participantIds; context.db.set('catalog', 'active', catalog);
  const original = (await listKnowledge(context, curator)).records.find(item => item.id === 'legacy-team')!;
  const renamed = await saveKnowledge(context, curator, input({ type: 'team', name: 'Команда Б', leaderId: assignment.leaderId, body: '',
    aliases: [], baseRevision: original.revision }), original.id);
  expect(renamed.record.aliases).toContain('Команда А');
  await expect(archiveKnowledge(context, curator, original.id, { baseRevision: renamed.record.revision, archived: true })).rejects.toThrow(/назначен|использ/i);
  const aliasEdited = await saveKnowledge(context, curator, input({ type: 'team', name: 'Команда Б', leaderId: assignment.leaderId, body: '',
    aliases: [], baseRevision: renamed.record.revision }), original.id);
  expect(aliasEdited.record.aliases).toContain('Команда А');
  await expect(archiveKnowledge(context, curator, original.id, { baseRevision: aliasEdited.record.revision, archived: true })).rejects.toThrow(/назначен|использ/i);
  expect((await context.catalogs.readForSession(curator)).assignments[0].teams).toEqual(['Команда А']);
});
it('requires an active product and leader for product leadership and blocks archiving a linked product', async () => {
  const context = await setup(); const leaderId = (await context.catalogs.read()).leaders[0].id;
  await expect(saveKnowledge(context, curator, input({ type: 'product_leader', productId: 'missing', leaderId }))).rejects.toThrow();
  const product = await saveKnowledge(context, curator, input({ type: 'product', name: 'Продукт', body: '' }));
  await saveKnowledge(context, curator, input({ type: 'product_leader', name: 'Лидер продукта', productId: product.record.id, leaderId }));
  await expect(archiveKnowledge(context, curator, product.record.id, { baseRevision: product.record.revision, archived: true })).rejects.toThrow(/связ|использ/i);
  await expect(saveKnowledge(context, curator, { ...input(), type: 'decision' } as unknown as KnowledgeInput)).rejects.toThrow();
});
it('keeps HTTP reading public while both curator role and CSRF protect changes', async () => {
  const context = await setup(); const app = Fastify(); await app.register(cookie); registerKnowledgeRoutes(app, context);
  context.db.set('sessions', curator.id, curator);
  app.setErrorHandler((error, _request, reply) => reply.code((error as { statusCode?: number }).statusCode ?? 400).send({ message: (error as Error).message }));
  try {
    expect((await app.inject({ method: 'GET', url: '/api/knowledge' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/knowledge', payload: input() })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/knowledge', headers: { 'x-uor-token': context.csrfToken }, payload: input() })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/knowledge', headers: { cookie: `uor_session=${curator.id}`, 'x-uor-token': context.csrfToken }, payload: input() })).statusCode).toBe(200);
  } finally { await app.close(); }
});
