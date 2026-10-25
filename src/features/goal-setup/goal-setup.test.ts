import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scryptSync } from 'node:crypto';
import type { CatalogSnapshot, CuratorSession } from '../../domain/contracts';
import { createContext, type ApplicationContext } from '../../server/workspace/context';
import type { GoalSetupInput } from './goal-setup-contracts';
import { previewGoalSetup, commitGoalSetup } from './goal-setup-service';
import { validateCatalog, validateEvaluationBasis } from '../publishing/validate-version';
import demo from '../../../catalog/demo.json';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { registerGoalSetupRoutes } from './goal-setup-routes';

const contexts: ApplicationContext[] = [], roots: string[] = [];
const session: CuratorSession = { id: 'session', role: 'curator', curatorId: 'curator', name: 'Куратор', createdAt: new Date().toISOString() };
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'goal-setup-')); roots.push(root);
  const catalog = structuredClone(demo) as CatalogSnapshot;
  const context = await createContext({ projectRoot: root, allowedRoots: [root], initialCatalog: catalog, registry: [{id:session.curatorId,name:session.name,salt:'fixture',hash:scryptSync('fixture-only','fixture',64).toString('hex')}] }); contexts.push(context);
  const leaderId = catalog.leaders[0].id;
  const input: GoalSetupInput = { requestId: 'request-one', goal: { title: 'Новая цель', category: 'process', officialTarget: 5, internalTarget: null, unit: 'шт', direction: 'increase' },
    measurement: { kind: 'scalar', aggregation: 'single', metrics: [{ id: 'value', name: 'Значение', unit: 'шт', target: 5, direction: 'increase' }] },
    assignments: [{ leaderId, participantIds: [leaderId] }], source: { kind: 'manual', name: 'Ручные данные', freshnessHours: 168 },
    sample: { period: '2026-10-25', rows: [{ leaderId, participantId: leaderId, metricId: 'value', value: 5, state: 'numeric', reason: null }] } };
  return { context, input };
}
afterEach(async () => { vi.restoreAllMocks(); for (const context of contexts.splice(0)) context.db.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
describe('goal setup connected drafts', () => {
  it('creates a global DIT goal with no assignments while keeping preview sample private and rejecting mixed scopes', async () => {
    const { context, input } = await setup();
    const globalInput: GoalSetupInput = { ...input, goal: { ...input.goal, scopeType: 'global' }, assignments: [],
      sample: { ...input.sample, rows: [{ ...input.sample.rows[0], leaderId: null, participantId: 'global-dit' }] } };
    const preview = await previewGoalSetup(context, session, globalInput);
    expect(preview.assignments).toEqual([]); expect(preview.evaluations).toHaveLength(1);
    expect(preview.evaluations[0]).toMatchObject({ actual: 5, leaderId: null, official: 'met' });
    const result = await commitGoalSetup(context, session, preview.previewId);
    expect(result.draftIds).toHaveLength(2); expect(context.db.list('snapshots')).toEqual([]);
    expect((await context.state(session)).evaluations.find(item => item.goalId === result.goalId)).toMatchObject({ official: 'unknown', missing: 1 });
    await expect(previewGoalSetup(context, session, { ...globalInput, requestId: 'mixed-global', assignments: input.assignments })).rejects.toThrow();
    await expect(previewGoalSetup(context, session, { ...globalInput, requestId: 'empty-nonglobal', goal: { ...input.goal, scopeType: 'participant' } })).rejects.toThrow();
    await expect(previewGoalSetup(context, session, { ...globalInput, requestId: 'global-share', measurement: { ...input.measurement, kind: 'participant_share', aggregation: 'average' } })).rejects.toThrow();
  });
  it('enforces curator role and CSRF at both HTTP commands', async () => {
    const { context, input } = await setup();
    const app = Fastify(); await app.register(cookie); registerGoalSetupRoutes(app, context);
    app.setErrorHandler((error, _request, reply) => reply.code((error as { statusCode?: number }).statusCode ?? 400).send({ message: (error as Error).message }));
    context.db.set('sessions', session.id, session);
    try {
      expect((await app.inject({ method: 'POST', url: '/api/goal-setup/preview', payload: input })).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url: '/api/goal-setup/preview', headers: { 'x-uor-token': context.csrfToken }, payload: input })).statusCode).toBe(403);
      const headers = { cookie: `uor_session=${session.id}`, 'x-uor-token': context.csrfToken };
      const preview = await app.inject({ method: 'POST', url: '/api/goal-setup/preview', headers, payload: input });
      expect(preview.statusCode).toBe(200);
      const payload = { previewId: preview.json().previewId };
      expect((await app.inject({ method: 'POST', url: '/api/goal-setup/commit', headers: { cookie: headers.cookie }, payload })).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url: '/api/goal-setup/commit', headers: { 'x-uor-token': context.csrfToken }, payload })).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url: '/api/goal-setup/commit', headers, payload })).statusCode).toBe(200);
    } finally { await app.close(); }
  });
  it('previews without changing catalog, facts, attestations or drafts', async () => {
    const { context, input } = await setup();
    const before = ['catalog', 'snapshots', 'attestations', 'drafts', 'changes', 'operations'].map(namespace => context.db.list(namespace));
    const preview = await previewGoalSetup(context, session, input);
    expect(preview.evaluations[0]).toMatchObject({ actual: 5, official: 'met', validation: 'pending' });
    expect(['catalog', 'snapshots', 'attestations', 'drafts', 'changes', 'operations'].map(namespace => context.db.list(namespace))).toEqual(before);
  });
  it('atomically creates complete objects and makes repeated request commits idempotent without accepting sample facts', async () => {
    const { context, input } = await setup();
    const preview = await previewGoalSetup(context, session, input);
    const committed = await commitGoalSetup(context, session, preview.previewId);
    expect(committed.draftIds).toHaveLength(3);
    expect(await commitGoalSetup(context, session, preview.previewId)).toEqual(committed);
    const repeated = await previewGoalSetup(context, session, input);
    expect(await commitGoalSetup(context, session, repeated.previewId)).toEqual(committed);
    const catalog = validateCatalog(await context.catalogs.readForSession(session));
    expect(catalog.goals.find(goal => goal.id === committed.goalId)?.title).toBe('Новая цель');
    expect(catalog.sources.find(source => source.id === preview.source.id)?.goalIds).toContain(committed.goalId);
    expect(context.db.list('snapshots')).toEqual([]);
    expect(validateEvaluationBasis({ methodVersion: 'explicit-measurement-v1', goal: preview.goal, assignments: preview.assignments }).goal.measurement).toEqual(input.measurement);
  });
  it('rejects stale, expired, cross-curator previews and requestId reuse with different content', async () => {
    const { context, input } = await setup();
    const preview = await previewGoalSetup(context, session, input);
    await expect(commitGoalSetup(context, { ...session, curatorId: 'other' }, preview.previewId)).rejects.toThrow();
    await expect(previewGoalSetup(context, session, { ...input, goal: { ...input.goal, title: 'Другая цель' } })).rejects.toThrow();
    context.db.set('catalog', 'active', { ...await context.catalogs.read(), name: 'Изменено' });
    await expect(commitGoalSetup(context, session, preview.previewId)).rejects.toThrow(/измен|устар/i);
    const fresh = await previewGoalSetup(context, session, { ...input, requestId: 'next' });
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31 * 60_000);
    await expect(commitGoalSetup(context, session, fresh.previewId)).rejects.toThrow(/срок|ист[её]к/i);
  });
  it('rolls back every connected draft and audit on a storage failure', async () => {
    const { context, input } = await setup();
    const preview = await previewGoalSetup(context, session, input);
    const write = context.db.set.bind(context.db); let drafts = 0;
    vi.spyOn(context.db, 'set').mockImplementation((namespace, id, value) => {
      if (namespace === 'drafts' && ++drafts === 2) throw new Error('disk failure');
      write(namespace, id, value);
    });
    await expect(commitGoalSetup(context, session, preview.previewId)).rejects.toThrow('disk failure');
    expect(context.db.list('drafts')).toEqual([]); expect(context.db.list('changes')).toEqual([]);
  });
  it('returns one committed result for concurrent repeated submissions', async () => {
    const { context, input } = await setup(); const preview = await previewGoalSetup(context, session, input);
    const [one, two] = await Promise.all([commitGoalSetup(context, session, preview.previewId), commitGoalSetup(context, session, preview.previewId)]);
    expect(two).toEqual(one); expect(context.db.list('drafts')).toHaveLength(3); expect(context.db.list('operations')).toHaveLength(1);
  });
  it('rejects unknown selected participants and permits saving an honest empty sample', async () => {
    const { context, input } = await setup();
    await expect(previewGoalSetup(context, session, { ...input, assignments: [{ leaderId: input.assignments[0].leaderId, participantIds: ['unknown'] }] })).rejects.toThrow();
    const preview = await previewGoalSetup(context, session, { ...input, sample: { ...input.sample, rows: [] } });
    expect(preview.evaluations[0].official).toBe('unknown'); expect(preview.warnings.length).toBeGreaterThan(0);
    expect((await commitGoalSetup(context, session, preview.previewId)).goalId).toBe(preview.goal.id);
  });
  it('edits a complete goal without losing its identity or duplicating its assignments', async () => {
    const { context, input } = await setup();
    const preview = await previewGoalSetup(context, session, input); const created = await commitGoalSetup(context, session, preview.previewId);
    const current = (await context.catalogs.readForSession(session)).goals.find(goal => goal.id === created.goalId)!;
    await expect(previewGoalSetup(context, session, { ...input, requestId: 'wrong-revision', goalId: current.id, baseRevision: 'stale' })).rejects.toThrow();
    const changed = await previewGoalSetup(context, session, { ...input, requestId: 'change-request', goalId: current.id, baseRevision: current.revision,
      source: { existingSourceId: preview.source.id }, goal: { ...input.goal, title: 'Изменённая цель' } });
    const updated = await commitGoalSetup(context, session, changed.previewId);
    expect(updated.goalId).toBe(created.goalId);
    const catalog = await context.catalogs.readForSession(session);
    expect(catalog.goals.find(goal => goal.id === created.goalId)?.title).toBe('Изменённая цель');
    expect(catalog.assignments.filter(item => item.goalId === created.goalId)).toHaveLength(1);
    expect(context.db.list('drafts')).toHaveLength(3);
  });
});
