import { afterEach, expect, it } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createWorkbenchRuntime } from './bootstrap';
import { createWorkbenchApp } from './app';
import { createLocalPreviewPolicy } from './oko-local-role';
import type { CommandContext } from './command-registry';
import { createOkoWorkflowStore } from '../../features/connectors/workbench-workflow-store';
import { snapshotWorkspace } from '../../features/workspace-maintenance/workbench/workspace-archive';
import { makeNumericFixture, makePublicationAnchor } from '../../../tests/fixtures/workbench/factories';
import { createWorkspaceOwnership } from '../storage/workbench-ownership';
import { createPackageArtifactStore } from '../../features/publishing/workbench/package-artifacts';
import { buildPackageManifest, canonicalBytes } from '../../features/publishing/workbench/package-manifest';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse())
    await close(); });
async function fixture(personId: string) {
    const root = await mkdtemp(path.join(realpathSync.native(tmpdir()), 't39-roundtrip-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    await mkdir(path.join(root, 'config'));
    await writeFile(path.join(root, 'config/site.local.json'), JSON.stringify({ allowedWorkspaceRoots: [root] }));
    const runtime = await createWorkbenchRuntime({ projectRoot: root, providers: { accessPolicy: ({ clock, capabilityFor }) => createLocalPreviewPolicy({ directory: path.join(root, '.runtime/workbench'), personId, clock, capabilityFor }) } });
    cleanups.push(runtime.close);
    const app = await createWorkbenchApp(runtime.deps, { configure: runtime.configure, deferActivation: true });
    cleanups.push(() => app.close());
    await runtime.activate();
    const context = async (): Promise<CommandContext> => ({ commandId: randomUUID(), requestId: randomUUID(), sessionId: 'synthetic-current-session', repository: runtime.deps.repository, clock: runtime.deps.clock, installationId: runtime.deps.installationId, ownAccess: await runtime.deps.accessPolicy.resolveOwnAccess(), actor: { hostname: 'synthetic', installationId: runtime.deps.installationId, profilePersonId: personId } });
    const execute = async (name: string, payload: Record<string, unknown>, baseRevision: string | null = null) => { const ctx = await context(), response = await runtime.deps.commands.execute({ commandId: ctx.commandId, name, payload, baseRevision }, ctx); await runtime.deps.commands.idle(); if ('jobId' in response) {
        const job = runtime.deps.jobs.get(response.jobId, ctx.installationId)!;
        expect(job.status, JSON.stringify(job)).toBe('succeeded');
        return { result: job.result!, editToken: null };
    } return response; };
    const backupBytes = async (includeOriginals: boolean) => { const saved = await execute('backup.create', { label: 'Synthetic cross-installation', includeOriginals }), file = await runtime.services.maintenance.getBackupFile(await context(), String(saved.result.backupId)), chunks: Uint8Array[] = []; for await (const chunk of file.stream)
        chunks.push(chunk); return Buffer.concat(chunks); };
    const restore = async (bytes: Uint8Array) => { const ctx = await context(), upload = await runtime.services.files.stage({ installationId: ctx.installationId, profilePersonId: personId, purpose: 'workspace-restore', name: 'synthetic.zip', mediaType: 'application/zip', stream: (async function* () { yield bytes; })() }); const preview = await execute('backup.restore.preview', { fileHandle: upload.fileHandle }); return execute('backup.restore.apply', { restoreToken: preview.result.restoreToken, confirmReplacement: true }); };
    return { root, runtime, app, context, execute, backupBytes, restore };
}
it('restores a prepared publication capsule into an independent clean installation and retains exact files after restart', async () => {
    const personId = randomUUID(), a = await fixture(personId), b = await fixture(personId), ctx = await a.context();
    const packageId = randomUUID(), cycleId = randomUUID(), original = Buffer.from('original synthetic source bytes\r\n'), resultId = randomUUID();
    const download = async (app: typeof b.app) => {
        const headers = { host: '127.0.0.1:4174' }, session = await app.inject({ url: '/api/v1/session', headers });
        expect(session.statusCode).toBe(200);
        const cookie = String(session.headers['set-cookie']).split(';')[0];
        const response = await app.inject({ url: `/api/v1/browser/results/${resultId}/original`, headers: { ...headers, cookie } });
        expect(response.statusCode, response.body).toBe(200);
        expect(response.rawPayload).toEqual(original);
    };
    const metric = { ...makeNumericFixture().metrics[0], actor: ctx.actor, publicationAnchorId: packageId };
    const capsuleFiles = new Map([[`records/metric_definition/${metric.id}/1.json`, canonicalBytes(metric)], ['originals/source.csv', original]]);
    const manifest = buildPackageManifest({ package: { schemaVersion: 1, packageId, cycleId, curatorPersonId: personId, revision: 1, baseCommit: 'a'.repeat(40), targetBranch: 'main', createdAt: ctx.clock.now() }, files: capsuleFiles });
    await createPackageArtifactStore({ artifactRoot: path.join(await a.runtime.services.archive.workspace!.activeRoot(), 'publishing') }).writeRevision(manifest.packageRevision, capsuleFiles);
    const sql = a.runtime.deps.repository.sqlForModule('publishing');
    const value = { schemaVersion: 1, id: packageId, revision: 1, recordedAt: ctx.clock.now(), actor: ctx.actor, publicationAnchorId: null, cycleId, curatorPersonId: personId, state: 'publishing', current: manifest.packageRevision, sent: null, draftRefs: [], proposal: null };
    sql.run('INSERT INTO wb_publishing_packages VALUES(?,?,?,?,?)', [packageId, ctx.installationId, personId, 1, JSON.stringify(value)]);
    sql.run('INSERT INTO wb_publishing_prepared VALUES(?,?,?,?,?)', [packageId, 1, ctx.installationId, personId, JSON.stringify({ packageRevision: manifest.packageRevision, checkout: 'C:\\synthetic-private-checkout', branch: `uor/${personId}/${packageId}`, commit: 'b'.repeat(40), expectedRemoteHead: null })]);
    const artifact = { name: 'source.csv', mimeType: 'text/csv', base64: original.toString('base64'), hash: createHash('sha256').update(original).digest('hex') };
    createOkoWorkflowStore(a.runtime.deps.repository).putResult(ctx.installationId + '/' + personId, resultId, { original: artifact, enriched: artifact });
    const before = await snapshotWorkspace(a.runtime.services.archive), targetRoot = await b.runtime.services.archive.workspace!.activeRoot();
    await expect(readFile(path.join(targetRoot, 'publishing', packageId, '1/manifest.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await b.restore(await a.backupBytes(true));
    const after = await snapshotWorkspace(b.runtime.services.archive);
    expect(after.records).toEqual(before.records); expect(after.revision).toBe(before.revision);
    const activeRoot = await b.runtime.services.archive.workspace!.activeRoot();
    expect(await createPackageArtifactStore({ artifactRoot: path.join(activeRoot, 'publishing') }).readRevision(manifest.packageRevision)).toEqual(capsuleFiles);
    expect((await b.runtime.deps.browserResults!.read(await b.context(), resultId, 'original')).bytes).toEqual(original);
    await download(b.app);
    await b.app.close(); await b.runtime.close();
    const reopened = await createWorkbenchRuntime({ projectRoot: b.root, providers: { accessPolicy: ({ clock, capabilityFor }) => createLocalPreviewPolicy({ directory: path.join(b.root, '.runtime/workbench'), personId, clock, capabilityFor }) } });
    cleanups.push(reopened.close);
    const restartedApp = await createWorkbenchApp(reopened.deps, { configure: reopened.configure, deferActivation: true });
    cleanups.push(() => restartedApp.close());
    await reopened.activate();
    expect((await snapshotWorkspace(reopened.services.archive)).records).toEqual(before.records);
    expect(await createPackageArtifactStore({ artifactRoot: path.join(await reopened.services.archive.workspace!.activeRoot(), 'publishing') }).readRevision(manifest.packageRevision)).toEqual(capsuleFiles);
    const context = { ...await a.context(), repository: reopened.deps.repository, installationId: reopened.deps.installationId, actor: { ...ctx.actor, installationId: reopened.deps.installationId }, ownAccess: await reopened.deps.accessPolicy.resolveOwnAccess() };
    expect((await reopened.deps.browserResults!.read(context, resultId, 'original')).bytes).toEqual(original);
    await download(restartedApp);
    expect(reopened.deps.repository.sqlForModule('publishing').all('SELECT payload FROM wb_publishing_prepared')).toEqual([]);
});
it('validates an explicitly created organization against the real empty published directory inventory', async () => {
    const f = await fixture(randomUUID());
    const opened = await f.execute('draft.open', { entityType: 'directory_entity', ref: null, packageId: null });
    const saved = await f.execute('organization.draft.save', { draftId: opened.result.draftId, definition: { kind: 'dit', name: 'Explicit synthetic organization', externalKeys: [] } }, opened.editToken);
    const row = f.runtime.deps.repository.sqlForModule('drafts').get<{ package_id: string }>('SELECT package_id FROM wb_drafts_entries WHERE draft_id=?', [String(opened.result.draftId)])!;
    expect(saved.result.complete).toBe(true);
    expect(f.runtime.services.drafts.validateDraftPackage(row.package_id)).toMatchObject({ complete: true, problems: [] });
});
it('roundtrips attached publication metadata canonically without changing the original actor or version', async () => {
    const personId = randomUUID(), a = await fixture(personId), b = await fixture(personId), context = await a.context();
    const value = { ...makeNumericFixture().metrics[0], publicationAnchorId: null, actor: context.actor }, anchor = makePublicationAnchor();
    const repository = a.runtime.deps.repository, ref = { entityType: 'metric_definition', id: value.id, revision: value.revision };
    repository.append(ref.entityType, value, null);
    createWorkspaceOwnership(repository).bind({ moduleId: 'core', key: `${ref.entityType}/${ref.id}/${ref.revision}`, installationId: context.installationId, personId, provenance: 'created' });
    repository.transaction(() => {
        repository.appendPublicationAnchor(anchor, null);
        repository.attachVerifiedPublicationAnchor(ref.entityType, { ...value, publicationAnchorId: anchor.id }, { installationId: context.installationId, personId });
    });
    const before = await snapshotWorkspace(a.runtime.services.archive);
    await b.restore(await a.backupBytes(true));
    const after = await snapshotWorkspace(b.runtime.services.archive);
    expect(after.records).toEqual(before.records);
    expect(after.revision).toBe(before.revision);
    expect(b.runtime.deps.repository.readVersion(ref)).toEqual({ ...value, publicationAnchorId: anchor.id });
    expect(b.runtime.deps.repository.readPublishedHead({ entityType: ref.entityType, id: ref.id })).toEqual({ ...value, publicationAnchorId: anchor.id });
});
it('same person on a different installation restores complete canonical records and exact subject bytes, including explicit partial originals', async () => {
    const personId = randomUUID(), a = await fixture(personId), b = await fixture(personId), c = await fixture(personId);
    const opened = await a.execute('draft.open', { entityType: 'evidence', ref: null, packageId: null }), ctx = await a.context(), evidence = Buffer.from('Synthetic immutable evidence'), upload = await a.runtime.services.files.stage({ installationId: ctx.installationId, profilePersonId: personId, purpose: 'evidence', name: 'synthetic.txt', mediaType: 'text/plain', stream: (async function* () { yield evidence; })() });
    await a.execute('evidence.draft.save', { draftId: opened.result.draftId, kind: 'file', fileHandle: upload.fileHandle }, opened.editToken);
    const artifactId = a.runtime.deps.repository.sqlForModule('evidence').get<{
        artifact_id: string;
    }>('SELECT artifact_id FROM wb_evidence_artifacts')!.artifact_id;
    const resultId = randomUUID(), original = Buffer.from('raw without leaders'), enriched = Buffer.from('Product,Leader\r\nSynthetic product,Synthetic leader\r\n'), artifact = (bytes: Buffer) => ({ name: 'data.csv', mimeType: 'text/csv', base64: bytes.toString('base64'), hash: createHash('sha256').update(bytes).digest('hex') });
    createOkoWorkflowStore(a.runtime.deps.repository).putResult(ctx.installationId + '/' + personId, resultId, { original: artifact(original), enriched: artifact(enriched) });
    const before = await snapshotWorkspace(a.runtime.services.archive), full = await a.backupBytes(true);
    await b.restore(full);
    expect(b.runtime.deps.installationId).not.toBe(ctx.installationId);
    const after = await snapshotWorkspace(b.runtime.services.archive);
    expect(after.records).toEqual(before.records);
    expect(after.revision).toBe(before.revision);
    const read = await b.runtime.deps.evidence!.readArtifactForContext(await b.context(), artifactId), chunks: Uint8Array[] = [];
    for await (const chunk of read.stream)
        chunks.push(chunk);
    expect(Buffer.concat(chunks)).toEqual(evidence);
    expect((await b.runtime.deps.browserResults!.read(await b.context(), resultId, 'original')).bytes).toEqual(original);
    expect(await readFile(path.join(await b.runtime.services.archive.workspace!.activeRoot(), 'evidence', artifactId))).toEqual(evidence);
    const partial = await a.backupBytes(false);
    await c.restore(partial);
    const partialSnapshot = await snapshotWorkspace(c.runtime.services.archive);
    expect(partialSnapshot.records).toEqual(before.records);
    expect(c.runtime.services.archive.workspace!.omittedOriginals?.()).toBe(true);
    await expect(c.runtime.deps.browserResults!.read(await c.context(), resultId, 'original')).rejects.toMatchObject({ statusCode: 404 });
    expect((await c.runtime.deps.browserResults!.read(await c.context(), resultId, 'enriched')).bytes).toEqual(enriched);
    expect((await c.backupBytes(true)).byteLength).toBeGreaterThan(0);
});
it('an unrelated person cannot preview the whole archive and unknown legacy storage creates no replacement identity or database', async () => {
    const a = await fixture(randomUUID()), b = await fixture(randomUUID()), ctx = await a.context(), artifact = { name: 'data.csv', mimeType: 'text/csv', base64: Buffer.from('synthetic').toString('base64'), hash: createHash('sha256').update('synthetic').digest('hex') };
    createOkoWorkflowStore(a.runtime.deps.repository).putResult(ctx.installationId + '/' + ctx.ownAccess.personId, randomUUID(), { original: artifact, enriched: artifact });
    const bytes = await a.backupBytes(true), bctx = await b.context(), upload = await b.runtime.services.files.stage({ installationId: bctx.installationId, profilePersonId: bctx.ownAccess.personId, purpose: 'workspace-restore', name: 'archive.zip', mediaType: 'application/zip', stream: (async function* () { yield bytes; })() });
    const beforeRefusal = await snapshotWorkspace(b.runtime.services.archive);
    await expect(b.runtime.services.maintenance.previewRestore(bctx, { fileHandle: upload.fileHandle })).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    expect(await snapshotWorkspace(b.runtime.services.archive)).toEqual(beforeRefusal);
    const root = await mkdtemp(path.join(realpathSync.native(tmpdir()), 't39-unknown-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    await mkdir(path.join(root, 'config'));
    await mkdir(path.join(root, '.runtime/workbench'), { recursive: true });
    await writeFile(path.join(root, 'config/site.local.json'), JSON.stringify({ allowedWorkspaceRoots: [root] }));
    const old = Buffer.from('unrecognized old database');
    await writeFile(path.join(root, '.runtime/workbench/workbench.sqlite'), old);
    await expect(createWorkbenchRuntime({ projectRoot: root })).rejects.toMatchObject({ code: 'WORKSPACE_LAYOUT_MIGRATION_REQUIRED' });
    for (const file of ['identity.json', 'active.json', 'subject/initial/workbench.sqlite'])
        await expect(readFile(path.join(root, '.runtime/workbench', file))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(path.join(root, '.runtime/workbench/workbench.sqlite'))).toEqual(old);
});
it('full raw archive includes hidden browser receipt and manual source across restore, restart and exact HTTP download', async()=>{
 const personId=randomUUID(),a=await fixture(personId),b=await fixture(personId),ctx=await a.context(),rawId=randomUUID(),bytes=Buffer.from('Команда\tЗначение\r\nA\t0\r\n'),store=createOkoWorkflowStore(a.runtime.deps.repository),owner=ctx.installationId+'/'+personId;
 store.beginCapture(owner,{schemaVersion:1,captureId:rawId,operationId:randomUUID(),workflowId:randomUUID(),sourceId:randomUUID(),title:'Synthetic raw',origin:'record',createdAt:ctx.clock.now()});store.commitCapture(owner,rawId,{name:'raw.tsv',contentType:'text/tab-separated-values',bytes});store.markExportDeleted(owner,rawId,ctx.clock.now());
 const manual=await a.execute('raw.capture.manual',{title:'Manual',columns:['Team','Value'],rows:[['A','0']]});const before=await snapshotWorkspace(a.runtime.services.archive);await b.restore(await a.backupBytes(true));expect((await snapshotWorkspace(b.runtime.services.archive)).records).toEqual(before.records);
 await b.app.close();await b.runtime.close();const restarted=await createWorkbenchRuntime({projectRoot:b.root,providers:{accessPolicy:({clock,capabilityFor})=>createLocalPreviewPolicy({directory:path.join(b.root,'.runtime/workbench'),personId,clock,capabilityFor})}});cleanups.push(restarted.close);const app=await createWorkbenchApp(restarted.deps,{configure:restarted.configure,deferActivation:true});cleanups.push(()=>app.close());await restarted.activate();
 const session=await app.inject({url:'/api/v1/session',headers:{host:'127.0.0.1:4174'}}),cookie=String(session.headers['set-cookie']).split(';')[0],headers={host:'127.0.0.1:4174',cookie,origin:'http://127.0.0.1:5173'};
 const downloaded=await app.inject({url:'/api/v1/raw-files/'+rawId+'/download',headers});expect(downloaded.statusCode,downloaded.body).toBe(200);expect(downloaded.rawPayload).toEqual(bytes);expect(downloaded.headers['content-type']).toContain('text/tab-separated-values');expect(downloaded.headers['content-disposition']).toContain('raw-file.tsv');expect(downloaded.headers['x-content-type-options']).toBe('nosniff');
 const listed=await app.inject({method:'POST',url:'/api/v1/queries/raw.files.list',headers,payload:{context:null,filter:{includeHidden:true},sort:[]}});expect(listed.statusCode,listed.body).toBe(200);expect(listed.json().data.items).toHaveLength(2);expect(listed.json().data.hiddenCount).toBe(1);expect(listed.json().data.items.find((f:any)=>f.id===manual.result.id).parseState).toBe('parsed');expect((await snapshotWorkspace(restarted.services.archive)).records).toEqual(before.records);
});
it('first real knowledge package is reviewable over own-scope HTTP before a published catalog exists',async()=>{
 const f=await fixture(randomUUID()),prepared=await f.execute('knowledge.materials.prepare',{packageId:null,curatorPersonId:null});const session=await f.app.inject({url:'/api/v1/session',headers:{host:'127.0.0.1:4174'}});expect(session.json().data.defaultContext).toBeNull();const headers={host:'127.0.0.1:4174',origin:'http://127.0.0.1:5173',cookie:String(session.headers['set-cookie']).split(';')[0]};
 const result=await f.app.inject({method:'POST',url:'/api/v1/queries/uor.package',headers,payload:{context:null,filter:{packageRef:{entityType:'publication_package',id:prepared.result.packageId}},sort:[]}});expect(result.statusCode,result.body).toBe(200);expect(result.json().data.entries.length).toBeGreaterThan(150);expect(f.runtime.deps.repository.readPublishedCatalog()).toHaveLength(0);
});
