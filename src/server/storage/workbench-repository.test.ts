import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createWorkbenchRepository } from './workbench-repository';
import type { WorkbenchRepository } from './workbench-repository';
import type { MetricDefinition } from '../../domain/workbench/entities';
import { headerShape } from '../../domain/workbench/primitives';
import { fixtureId, makeEntityGraph, makeHeader, makeNumericFixture, makePublicationAnchor, versionRef } from '../../../tests/fixtures/workbench/factories';
import { seedGraph } from '../../../tests/fixtures/workbench/repository';

const cleanups: Array<() => void> = [];
function setup() {
  const root = mkdtempSync(path.join(tmpdir(), 'uor-wb-'));
  const options = { filename: path.join(root, 'test.sqlite'), artifactRoot: path.join(root, 'artifacts') };
  const instances: WorkbenchRepository[] = [];
  const open = () => { const repository = createWorkbenchRepository(options); instances.push(repository); return repository; };
  cleanups.push(() => { instances.forEach(r => r.close()); if (!path.basename(root).startsWith('uor-wb-')) throw new Error('Unexpected test path'); rmSync(root, { recursive: true, force: true }); });
  return { repository: open(), open };
}
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

describe('append-only workbench repository', () => {
  it('keeps_versions_and_rejects_stale_heads', () => {
    const { repository: r, open } = setup(); const graph = makeEntityGraph(); seedGraph(r, graph);
    const metric = graph.input.metrics[0]; const ref = { entityType: 'metric_definition', id: metric.id };
    r.append('metric_definition', { ...metric, revision: 2, name: 'demo_v2' }, 1);
    expect(r.readVersion<MetricDefinition>({ ...ref, revision: 1 })?.name).toBe(metric.name);
    expect(r.getHead<MetricDefinition>(ref)?.name).toBe('demo_v2');
    expect(() => r.append('metric_definition', { ...metric, revision: 3 }, 1)).toThrowError(expect.objectContaining({ code: 'REVISION_CONFLICT' }));
    expect(() => r.append('metric_definition', { ...metric, revision: 2 }, 2)).toThrowError(expect.objectContaining({ code: 'REVISION_CONFLICT' }));
    expect(() => r.append('capture', { ...graph.input.captures[0], revision: 2 }, 1)).toThrowError(expect.objectContaining({ code: 'CAPTURE_IMMUTABLE' }));
    expect(r.readPublicationAnchor({ entityType: 'publication_package', id: graph.anchors[0].id })).toBeNull();
    const state = r.getStateRevision(); r.close();
    const reopened = open(); expect(reopened.getStateRevision()).toBe(state);
    expect(reopened.readVersion<MetricDefinition>({ ...ref, revision: 1 })?.name).toBe(metric.name);
    expect(reopened.getHead<MetricDefinition>(ref)?.name).toBe('demo_v2');
  });

  it('rolls_back_async_or_failed_transactions', async () => {
    const { repository: r } = setup(); const graph = makeEntityGraph(); seedGraph(r, graph); const metric = graph.input.metrics[0];
    const moduleSql = r.sqlForModule('test');
    moduleSql.execMigration('projection-v1', 'CREATE TABLE wb_test_projection(id TEXT PRIMARY KEY, name TEXT NOT NULL)');
    r.registerProjection('metric-test', (type, value) => { if (type === 'metric_definition') moduleSql.run('INSERT INTO wb_test_projection(id,name) VALUES(?,?)', [value.id, (value as MetricDefinition).name]); });
    const state = r.getStateRevision();
    const append = () => r.append('metric_definition', { ...metric, revision: 2, name: 'candidate' }, 1);
    expect(() => r.transaction(() => { append(); throw new Error('second write failed'); })).toThrow('second write failed');
    expect(r.getStateRevision()).toBe(state);
    expect(r.getHead({ entityType: 'metric_definition', id: metric.id })?.revision).toBe(1);
    expect(moduleSql.all('SELECT * FROM wb_test_projection')).toEqual([]);
    expect(() => r.transaction(() => { append(); return Promise.resolve('x'); })).toThrowError(expect.objectContaining({ code: 'ASYNC_TRANSACTION_FORBIDDEN' }));
    expect(() => r.transaction(() => ({ then() { /* never called */ } }))).toThrowError(expect.objectContaining({ code: 'ASYNC_TRANSACTION_FORBIDDEN' }));
    let asyncCalled = false;
    expect(() => r.transaction(async () => { asyncCalled = true; append(); })).toThrowError(expect.objectContaining({ code: 'ASYNC_TRANSACTION_FORBIDDEN' }));
    expect(asyncCalled).toBe(false);
    const lateErrors: string[] = [];
    expect(() => r.transaction(() => Promise.resolve().then(() => { try { append(); } catch (error) { lateErrors.push((error as { code: string }).code); } }))).toThrowError(expect.objectContaining({ code: 'ASYNC_TRANSACTION_FORBIDDEN' }));
    await Promise.resolve(); await Promise.resolve();
    expect(lateErrors).toEqual(['TRANSACTION_CONTEXT_CLOSED']);
    expect(r.getStateRevision()).toBe(state);
    r.transaction(() => {
      append();
      expect(() => r.transaction(() => { r.append('metric_definition', { ...metric, revision: 3, name: 'bad nested' }, 2); moduleSql.run('INSERT INTO wb_test_projection(id,name) VALUES(?,?)', ['nested', 'bad']); throw new Error('nested'); })).toThrow('nested');
      expect(r.getHead({ entityType: 'metric_definition', id: metric.id })?.revision).toBe(2);
    });
    expect(moduleSql.all('SELECT * FROM wb_test_projection')).toEqual([{ id: metric.id, name: 'candidate' }]);
    expect(BigInt(r.getStateRevision())).toBe(BigInt(state) + 1n);
  });

  it('rolls back dangling references and failed projections atomically', () => {
    const { repository: r } = setup(); const graph = makeEntityGraph(); seedGraph(r, graph); const metric = graph.input.metrics[0];
    const state = r.getStateRevision();
    expect(() => r.transaction(() => { r.append('metric_definition', { ...metric, revision: 2 }, 1); r.append('commentary', { ...makeHeader(900), targetRef: { entityType: 'work', id: fixtureId(999) }, text: 'demo' }, null); })).toThrowError(expect.objectContaining({ code: 'REFERENCE_NOT_FOUND' }));
    expect(r.getStateRevision()).toBe(state); expect(r.getHead({ entityType: 'metric_definition', id: metric.id })?.revision).toBe(1);
    r.registerProjection('fail', () => { throw new Error('index failure'); });
    expect(() => r.registerProjection('fail', () => {})).toThrow();
    expect(() => r.append('metric_definition', { ...metric, revision: 2 }, 1)).toThrow('index failure');
    expect(r.getStateRevision()).toBe(state);
    expect(r.readVersion({ entityType: 'metric_definition', id: metric.id, revision: 2 })).toBeNull();
  });

  it('activates_confirmed_main_without_guessing_merge_time', () => {
    const { repository: r } = setup(); const graph = makeEntityGraph();
    const unknown = makePublicationAnchor({ timeVerification: 'unknown', mergedAt: null });
    graph.anchors = [unknown]; seedGraph(r, graph);
    const assignment = graph.input.assignment; const ref = { entityType: 'goal_assignment', id: assignment.id };
    expect(r.readPublishedHead(ref)?.revision).toBe(1);
    const metaRef = r.appendPublicationAnchor({ ...unknown, timeVerification: 'verified', mergedAt: '2026-10-23T08:00:00Z' }, 1);
    expect(metaRef.revision).toBe(2);
    expect(r.readPublicationAnchor({ entityType: 'publication_anchor', id: unknown.id })?.revision).toBe(1);
    expect(() => r.appendPublicationAnchor(unknown, 1)).toThrowError(expect.objectContaining({ code: 'REVISION_CONFLICT' }));
    const pending = makePublicationAnchor({ id: fixtureId(50), packageId: fixtureId(51), publicationState: 'unconfirmed', timeVerification: 'unknown', mainCommit: null, mergedAt: null, verifiedAt: null });
    r.appendPublicationAnchor(pending, null);
    r.append('goal_assignment', { ...assignment, revision: 2, publicationAnchorId: pending.id }, 1);
    expect(r.getHead(ref)?.revision).toBe(2); expect(r.readPublishedHead(ref)?.revision).toBe(1);
    const jobs = r.sqlForModule('jobs'); jobs.execMigration('jobs-test-v1', 'CREATE TABLE wb_jobs_test(id TEXT PRIMARY KEY)');
    jobs.run('INSERT INTO wb_jobs_test(id) VALUES(?)', ['kept']);
    jobs.execMigration('jobs-test-v1', 'CREATE TABLE wb_jobs_test(id TEXT PRIMARY KEY)');
    expect(jobs.all('SELECT * FROM wb_jobs_test')).toEqual([{ id: 'kept' }]);
    const state = r.getStateRevision();
    expect(() => r.transaction(() => { jobs.run('INSERT INTO wb_jobs_test(id) VALUES(?)', ['rollback']); throw new Error('abort'); })).toThrow('abort');
    expect(jobs.all('SELECT * FROM wb_jobs_test')).toEqual([{ id: 'kept' }]); expect(r.getStateRevision()).toBe(state);
    expect(() => jobs.run('DELETE FROM wb_entity_versions')).toThrow();
    expect(() => jobs.execMigration('bad', 'DROP TABLE wb_entity_heads')).toThrow();
    expect(() => r.sqlForModule('entity')).toThrowError(expect.objectContaining({ code: 'INVALID_MODULE_ID' }));
    expect(() => jobs.run('DELETE FROM records AS wb_jobs_alias')).toThrowError(expect.objectContaining({ code: 'MODULE_SQL_NAMESPACE_FORBIDDEN' }));
    expect(() => jobs.run("UPDATE 'wb_entity_versions' SET payload_json=json_set(payload_json,'$.title','CORRUPTED') WHERE entity_type='core_goal_definition' AND EXISTS(SELECT 1 FROM wb_jobs_test)"))
      .toThrowError(expect.objectContaining({ code: 'MODULE_SQL_NAMESPACE_FORBIDDEN' }));
    expect(r.getHead<{ title: string } & import('../../domain/workbench/primitives').Header>({ entityType: 'core_goal_definition', id: graph.input.goal.id })?.title).toBe(graph.input.goal.title);
  });

  it('indexes only scoped candidates and supports explicitly registered module entities', () => {
    const { repository: r } = setup(); const graph = makeEntityGraph(); seedGraph(r, graph);
    const input = graph.input;
    const candidates = r.readEvaluationCandidates({ sourceId: input.goal.sourceId, assignmentId: input.assignment.id, metricIds: input.metrics.map(m => m.id), scopes: input.assignment.expectedPopulation!, businessTime: input.context.businessTime, evaluatedAt: input.context.evaluatedAt });
    expect(candidates.facts.map(f => f.id)).toEqual(input.facts.map(f => f.id));
    expect(candidates.captures.map(c => c.id)).toEqual(input.captures.map(c => c.id));
    expect(r.readEvaluationCandidates({ sourceId: input.goal.sourceId, assignmentId: input.assignment.id, metricIds: [fixtureId(900)], scopes: input.assignment.expectedPopulation!, businessTime: input.context.businessTime, evaluatedAt: input.context.evaluatedAt }).facts).toEqual([]);
    const registration = { schema: z.strictObject({ ...headerShape, title: z.string() }), references: () => [] };
    r.registerEntityType('demo_marker', registration);
    expect(() => r.registerEntityType('demo_marker', registration)).toThrow();
    r.append('demo_marker', { ...makeHeader(950), title: 'demo' }, null);
    expect(r.readVersion({ ...versionRef('demo_marker', 950) })).toMatchObject({ title: 'demo' });
    const moduleSql = r.sqlForModule('test');
    expect(() => moduleSql.all('SELECT * FROM wb_fact_index')).toThrow();
  });

  it('imports immutable published history without replacing a newer local fact or anchoring a coincident local version', () => {
    const {repository:r}=setup(),graph=makeEntityGraph();seedGraph(r,graph);const fact=graph.input.facts[0];
    r.append('observed_fact',{...fact,revision:2,publicationAnchorId:null,value:'71'},1);
    r.append('observed_fact',{...fact,revision:3,publicationAnchorId:null,value:'72'},2);
    const incomingAnchor=makePublicationAnchor({id:fixtureId(269001),packageId:fixtureId(269001),timeVerification:'unknown',mergedAt:null});r.appendPublicationAnchor(incomingAnchor,null);
    const incoming={...fact,id:fixtureId(269002),revision:2,publicationAnchorId:incomingAnchor.id,value:'69'};
    expect(r.importPublishedVersion('observed_fact',incoming)).toEqual({entityType:'observed_fact',id:incoming.id,revision:2});
    expect(r.importPublishedVersion('observed_fact',{...incoming,revision:1,value:'68'}).revision).toBe(1);
    expect(r.getHead({entityType:'observed_fact',id:incoming.id})?.revision).toBe(2);
    expect(r.getHead({entityType:'observed_fact',id:fact.id})).toMatchObject({revision:3,value:'72',publicationAnchorId:null});
    expect(()=>r.importPublishedVersion('observed_fact',{...fact,revision:2,publicationAnchorId:incomingAnchor.id,value:'71'})).toThrowError(expect.objectContaining({code:'VERSION_CONTENT_IMMUTABLE'}));
    expect(()=>r.importPublishedVersion('observed_fact',{...incoming,publicationAnchorId:null})).toThrowError(expect.objectContaining({code:'PUBLICATION_UNCONFIRMED'}));
    const revision=r.getStateRevision();r.importPublishedVersion('observed_fact',incoming);expect(r.getStateRevision()).toBe(revision);
    expect(r.publicationAnchorMetadataRevision({entityType:'publication_anchor',id:incomingAnchor.id})).toBe(1);
    expect(r.readVersionsForPublicationAnchor(incomingAnchor.id).map(row=>[row.entityType,row.value.id,row.value.revision])).toEqual([['observed_fact',incoming.id,1],['observed_fact',incoming.id,2]]);
    r.appendPublicationAnchor({...incomingAnchor,timeVerification:'verified',mergedAt:'2026-10-23T08:00:00Z'},1);
    expect(r.publicationAnchorMetadataRevision({entityType:'publication_anchor',id:incomingAnchor.id})).toBe(2);
    expect(r.readPublicationAnchor({entityType:'publication_anchor',id:incomingAnchor.id})?.revision).toBe(1);
  });
  it('queries 2000 expected members without a SQL expression-depth limit or truncation', () => {
    const { repository: r } = setup();
    const scopes = Array.from({ length: 2000 }, (_, index) => ({ kind: 'product' as const, id: fixtureId(500 + index) }));
    const input = makeNumericFixture({ expectedPopulation: scopes }); seedGraph(r, makeEntityGraph(input));
    const candidates = r.readEvaluationCandidates({ sourceId: input.goal.sourceId, assignmentId: input.assignment.id, metricIds: input.metrics.map(m => m.id), scopes, businessTime: input.context.businessTime, evaluatedAt: input.context.evaluatedAt });
    expect(candidates.facts).toHaveLength(2000);
    expect(candidates.captures).toHaveLength(1);
  });
});
