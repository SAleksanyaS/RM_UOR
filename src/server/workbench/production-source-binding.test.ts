import { afterEach, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createWorkbenchRuntime } from './bootstrap';
import { createWorkbenchApp } from './app';
import { fixtureId, makeNumericFixture, makeEntityGraph } from '../../../tests/fixtures/workbench/factories';
import { seedGraph } from '../../../tests/fixtures/workbench/repository';
import { sourcePayloadHash, type SourceAdapter } from '../../features/connectors/workbench-source-contracts';
import type { SourceFieldMapping } from '../../domain/workbench/entities';
import { defaultSourceParsingProfile } from '../../domain/workbench/schemas/sources';
import { createLocalRuntime } from '../../../tests/workbench/helpers/runtime';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse())
    await close(); });
it('first capture derives current published bindings and exact own context before using the real pipeline', async () => {
    const root = await mkdtemp(path.join(realpathSync.native(tmpdir()), 't39-binding-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    await mkdir(path.join(root, 'config'));
    await writeFile(path.join(root, 'config/site.local.json'), JSON.stringify({ allowedWorkspaceRoots: [root] }));
    const scope = { kind: 'dit' as const, id: fixtureId(100) }, input = makeNumericFixture({ scope, expectedPopulation: [scope] }), graph = makeEntityGraph(input);
    graph.entries = graph.entries.filter(e => !['capture', 'observed_fact'].includes(e.entityType));
    const mapping = graph.entries.find(e => e.entityType === 'source_field_mapping')!.value as SourceFieldMapping;
    mapping.fixedScope = scope;
    mapping.productKeyField = null;
    mapping.dimensionFields = {};
    mapping.parsingProfile = { ...defaultSourceParsingProfile, dateFormat: 'iso', decimalSeparator: '.', groupSeparator: 'none' };
    const adapter: SourceAdapter = { async check() { return { status: 'ready', issues: [] }; }, async collect(request) { const rawRows = [{ rowKey: JSON.stringify(['synthetic']), cells: { demo_row_key: { kind: 'text' as const, original: 'synthetic' }, demo_value: { kind: 'number' as const, original: '12' }, demo_date: { kind: 'text' as const, original: '2026-10-27' } } }]; return { operationId: request.operationId, sourceRef: request.sourceRef, mappingRef: request.mappingRef, capturedAt: '2026-11-01T10:00:00Z', sourceUpdatedAt: null, rawRows, artifact: null, payloadHash: sourcePayloadHash(rawRows), coverage: { complete: true, expectedRows: 1, receivedRows: 1, evidence: ['synthetic external source'] }, issues: [] }; } };
    const runtime = await createWorkbenchRuntime({ projectRoot: root, providers: { sourceAdapters: new Map([['qlik', adapter]]) } });
    cleanups.push(runtime.close);
    seedGraph(runtime.deps.repository, graph);
    const app = await createWorkbenchApp(runtime.deps, { configure: runtime.configure, deferActivation: true });
    cleanups.push(() => app.close());
    await runtime.activate();
    const ownAccess = await runtime.deps.accessPolicy.resolveOwnAccess(), installationId = runtime.deps.installationId, context = () => ({ requestId: randomUUID(), commandId: randomUUID(), sessionId: 'fixture', repository: runtime.deps.repository, clock: runtime.deps.clock, installationId, ownAccess, actor: { hostname: 'synthetic', installationId, profilePersonId: ownAccess.personId } });
    const preference = context();
    await runtime.deps.commands.execute({ commandId: preference.commandId, name: 'preferences.set', baseRevision: runtime.services.preferences.editToken(installationId, ownAccess.personId), payload: { values: { ...runtime.services.preferences.get(installationId, ownAccess.personId), context: { scopePath: { ditId: scope.id, clusterId: null, productId: null, teamId: null }, goalId: input.goal.id, time: { kind: 'as_of', date: '2026-10-27' }, resultMode: 'current', snapshotId: null } } } }, preference);
    const capture = context(), accepted = await runtime.deps.commands.execute({ commandId: capture.commandId, name: 'source.capture', baseRevision: null, payload: { goalId: input.goal.id } }, capture);
    expect('jobId' in accepted).toBe(true);
    await runtime.deps.commands.idle();
    const job = runtime.deps.jobs.findByCommand(capture.commandId, installationId)!;
    expect(job.status, JSON.stringify(job)).toBe('succeeded');
    expect(job.result).toMatchObject({ acceptedRows: 1, rejectedRows: 0 });
});

it('non-browser adapter original artifacts retain exact download bytes through actual runtime HTTP capture and lineage', async () => {
    const scope = { kind: 'dit' as const, id: fixtureId(100) }, input = makeNumericFixture({ scope, expectedPopulation: [scope] }), graph = makeEntityGraph(input);
    graph.entries = graph.entries.filter(entry => !['capture', 'observed_fact'].includes(entry.entityType));
    const mapping = graph.entries.find(entry => entry.entityType === 'source_field_mapping')!.value as SourceFieldMapping;
    Object.assign(mapping, { fixedScope: scope, productKeyField: null, dimensionFields: {}, parsingProfile: { ...defaultSourceParsingProfile } });
    const original = Buffer.from('demo_row_key,demo_value,demo_date\r\nsynthetic,12,2026-10-27\r\n', 'utf8');
    const originalHash = createHash('sha256').update(original).digest('hex'), artifactId = randomUUID();
    const rawRows = [{ rowKey: '["synthetic"]', cells: { demo_row_key: { kind: 'text' as const, original: 'synthetic' }, demo_value: { kind: 'number' as const, original: '12' }, demo_date: { kind: 'text' as const, original: '2026-10-27' } } }];
    const adapter: SourceAdapter = {
        async check() { return { status: 'ready', issues: [] }; },
        async collect(request) {
            const artifact = local.runtime.services.sources.saveArtifact({ installationId: local.runtime.deps.installationId, personId: (await local.runtime.deps.accessPolicy.resolveOwnAccess()).personId, artifactId, mimeType: 'text/csv', bytesValue: original });
            return { operationId: request.operationId, sourceRef: request.sourceRef, mappingRef: request.mappingRef, capturedAt: '2026-11-01T10:00:00Z', sourceUpdatedAt: null, rawRows, artifact, payloadHash: artifact.hash, coverage: { complete: true, expectedRows: 1, receivedRows: 1, evidence: ['Synthetic non-browser provider original export'] }, issues: [] };
        },
    };
    const local = await createLocalRuntime({ sourceAdapters: new Map([['qlik', adapter]]), clock: { now: () => '2026-11-01T10:00:00Z' } });
    cleanups.push(local.close); seedGraph(local.runtime.deps.repository, graph);
    const context = { scopePath: { ditId: scope.id, clusterId: null, productId: null, teamId: null }, goalId: input.goal.id, time: { kind: 'as_of', date: '2026-10-27' }, resultMode: 'current', snapshotId: null };
    await local.request.command('preferences.set', { values: { context, sorts: {}, visual: { theme: 'system', density: 'comfortable' }, notificationPersonId: null } });
    const accepted = await local.request.command('source.capture', { goalId: input.goal.id }), completed = await local.request.settle(accepted);
    expect(completed.result).toMatchObject({ acceptedRows: 1, rejectedRows: 0, duplicate: false });
    const captureRef = completed.result.captureRef, captures = await local.request.query<any>('data.captures', {}, context);
    const captured = captures.items.find((item: any) => item.capture.id === captureRef.id).capture;
    expect(captured).toMatchObject({ rawArtifactId: artifactId, payloadHash: 'sha256:' + originalHash, result: 'accepted', rawRows, canonicalRows: [{ rowKey: '["synthetic"]', numbers: { demo_value: '12' }, dimensions: {}, businessTime: context.time }] });
    const enriched = await local.request.query<any>('data.rows', { captureRef, layer: 'enriched' }, context);
    expect(enriched.items[0].factRefs).toHaveLength(1);
    const lineage = await local.request.query<any>('data.lineage', { factRef: enriched.items[0].factRefs[0] }, context);
    expect(lineage.facts[0]).toMatchObject({ captureId: captureRef.id, sourceId: input.goal.sourceId, scope, value: '12', lineage: { captureId: captureRef.id, mappingRef: captured.mappingRef, sourceRowKeys: ['["synthetic"]'] } });
    expect(lineage.captures[0]).toEqual(captured);
    const download = await local.request.response('/api/v1/browser/results/' + captureRef.id + '/original');
    expect(download.status).toBe(200); expect(download.headers.get('x-content-sha256')).toBe(originalHash); expect(Buffer.from(await download.arrayBuffer())).toEqual(original);
    await local.restart(); await local.request.session();
    const reopened = await local.request.response('/api/v1/browser/results/' + captureRef.id + '/original');
    expect(reopened.status).toBe(200); expect(reopened.headers.get('x-content-sha256')).toBe(originalHash); expect(Buffer.from(await reopened.arrayBuffer())).toEqual(original);
});
