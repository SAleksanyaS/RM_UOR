import { createHash,randomUUID } from 'node:crypto';
import PptxGenJS from 'pptxgenjs';
import { saveReportTemplate,listReportTemplates } from '../../src/features/report-templates/service';
import { listEvidence,readEvidenceBytes } from '../../src/features/evidence/evidence-service';
import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { CatalogSnapshot, CuratorSession, Draft } from '../../src/domain/contracts';
import { createContext, type ApplicationContext } from '../../src/server/workspace/context';
import { checkRemoteUpdates, publishChanges, syncPublished } from '../../src/features/publishing/application-publishing';
import { previewGoalSetup, commitGoalSetup } from '../../src/features/goal-setup/goal-setup-service';

const execute = promisify(execFile), roots: string[] = [], contexts: ApplicationContext[] = [];
const encode = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
async function git(cwd: string, ...args: string[]) {
  return (await execute('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })).stdout.trim();
}
const curator: CuratorSession = { id: 'demo-session', role: 'curator', curatorId: 'demo-curator', name: 'Демонстрационный куратор', createdAt: '2026-10-24T00:00:00Z' };
function catalog(): CatalogSnapshot {
  return { schemaVersion: 1, id: 'bridge-demo', name: 'Синтетический каталог', classification: 'demo', importedAt: '2026-10-24T00:00:00Z',
    goals: [{ id: 'demo-goal', category: 'process', title: 'Исходная цель', target: '80%', metric: 'Доля', status: '', summary: '', actions: [],
      scopeType: 'team', links: [], ownerId: null, curatorId: null, officialTarget: 80, internalTarget: null, unit: '%', direction: 'increase',
      baseline: 0, weight: 1, priority: null, dueDate: null, revision: 'base' }],
    leaders: [{ id: 'demo-leader', name: 'Синтетический лидер', teams: [] }],
    assignments: [{ id: 'demo-leader:demo-goal:3', goalId: 'demo-goal', leaderId: 'demo-leader', teams: [] }],
    sources: [], comments: [], entities: [] };
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'uor-app-publish ')); roots.push(root);
  const remote = join(root, 'remote.git'), seed = join(root, 'seed'), writerRoot = join(root, 'writer'), readerRoot = join(root, 'reader');
  await execute('git', ['init', '--bare', '--initial-branch=main', remote]);
  await execute('git', ['init', '--initial-branch=main', seed]);
  await mkdir(join(seed, 'catalog'), { recursive: true });
  await writeFile(join(seed, 'catalog/demo.json'), encode(catalog())); await writeFile(join(seed, '.gitignore'), '.runtime/\n');
  await git(seed, 'add', 'catalog', '.gitignore');
  await git(seed, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'Synthetic embedded catalog');
  await git(seed, 'remote', 'add', 'origin', remote); await git(seed, 'push', 'origin', 'main');
  await execute('git', ['clone', '--branch', 'main', remote, writerRoot]);
  await execute('git', ['clone', '--branch', 'main', remote, readerRoot]);
  const writer = await createContext({ projectRoot: writerRoot, allowedRoots: [root], repositoryUrl: remote, startupCheck: false });
  const reader = await createContext({ projectRoot: readerRoot, allowedRoots: [root], repositoryUrl: remote, startupCheck: false });
  contexts.push(writer, reader);
  return { root, remote, seed, writer, reader };
}
async function draft(context: ApplicationContext, patch: Record<string, unknown>) {
  const current = await context.catalogs.readForSession(curator);
  return context.catalogs.saveDraft(curator, { kind: 'goal', id: 'demo-goal', baseRevision: current.goals[0].revision, patch });
}
async function commitSeed(seed: string, message: string) {
  await git(seed, 'add', 'catalog');
  await git(seed, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', message);
  await git(seed, 'push', 'origin', 'main');
}
afterEach(async () => {
  for (const context of contexts.splice(0)) context.db.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('application publishing bridge', () => {
  it('requires a new goal dependency and releases all connected setup objects to another client', async () => {
    const f = await fixture();
    const preview = await previewGoalSetup(f.writer, curator, { requestId: 'connected-setup',
      goal: { title: 'Самостоятельная цель', category: 'process', officialTarget: 5, internalTarget: null, unit: 'шт', direction: 'increase' },
      measurement: { kind: 'scalar', aggregation: 'single', metrics: [{ id: 'value', name: 'Количество', unit: 'шт', target: 5, direction: 'increase' }] },
      assignments: [{ leaderId: 'demo-leader', participantIds: ['demo-leader'] }], source: { kind: 'manual', name: 'Новый источник' }, sample: { period: '2026-10-25', rows: [] } });
    const saved = await commitGoalSetup(f.writer, curator, preview.previewId);
    const drafts = await f.writer.catalogs.listDrafts(curator);
    const assignment = drafts.find(item => item.change.kind === 'assignment')!;
    const partial = await f.writer.operations.start('publish');
    await publishChanges(f.writer, curator, partial.id, [assignment.id]);
    expect((await f.writer.operations.get(partial.id)).status).toBe('failed');
    expect((await f.writer.catalogs.listDrafts(curator))).toHaveLength(3);
    const operation = await f.writer.operations.start('publish'); await publishChanges(f.writer, curator, operation.id, saved.draftIds);
    expect((await f.writer.operations.get(operation.id)).status).toBe('completed');
    await git(f.seed, 'fetch', 'origin');
    await git(f.seed, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'merge', '--no-ff', 'origin/release/current', '-m', 'Release connected goal');
    await git(f.seed, 'push', 'origin', 'main'); await syncPublished(f.reader);
    const received = await f.reader.catalogs.read();
    expect(received.goals.find(goal => goal.id === saved.goalId)?.measurement?.kind).toBe('scalar');
    expect(received.assignments.find(item => item.goalId === saved.goalId)?.participantIds).toEqual(['demo-leader']);
    expect(received.sources.some(source => source.goalIds.includes(saved.goalId))).toBe(true);
    expect(f.reader.db.list('snapshots')).toEqual([]);
  }, 90000);
  it('releases a new work direction, a default direction edit and its goal link to another client and a fresh local checkout', async () => {
    const f = await fixture();
    // A previous release may already contain standalone goals without the new
    // optional work-direction field. Compatibility must cover that shape too.
    await mkdir(join(f.seed, 'catalog/goals'), { recursive: true });
    await writeFile(join(f.seed, 'catalog/goals/demo-goal.json'), encode(catalog().goals[0]));
    await commitSeed(f.seed, 'Legacy standalone goal');
    await f.writer.catalogs.saveDraft(curator, { kind: 'direction', id: 'architecture', baseRevision: null, patch: { name: 'Архитектура — уточнено куратором' } });
    await f.writer.catalogs.saveDraft(curator, { kind: 'direction', id: 'custom-direction', baseRevision: null,
      patch: { name: 'Своё направление', description: 'Синтетический пример', color: '#123456', order: 7 } });
    const goalDraft = await draft(f.writer, { workDirectionId: 'custom-direction' });
    const incomplete = await f.writer.operations.start('publish'); await publishChanges(f.writer, curator, incomplete.id, [goalDraft.id]);
    const incompleteResult = await f.writer.operations.get(incomplete.id);
    expect(incompleteResult.status).toBe('failed');
    expect(incompleteResult.result?.message).toMatch(/направлен/i);
    const operation = await f.writer.operations.start('publish'); await publishChanges(f.writer, curator, operation.id);
    const result = await f.writer.operations.get(operation.id);
    expect(result.status, result.result?.message).toBe('completed');
    await git(f.seed, 'fetch', 'origin');
    await git(f.seed, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'merge', '--no-ff', 'origin/release/current', '-m', 'Release work directions');
    await git(f.seed, 'push', 'origin', 'main');
    await syncPublished(f.reader);
    const remote = await f.reader.catalogs.read();
    expect(remote.directions?.find(direction => direction.id === 'architecture')?.name).toBe('Архитектура — уточнено куратором');
    expect(remote.directions?.find(direction => direction.id === 'custom-direction')?.name).toBe('Своё направление');
    expect(remote.goals[0].workDirectionId).toBe('custom-direction');
    const fresh = await createContext({ projectRoot: f.seed, allowedRoots: [f.root], repositoryUrl: f.remote, startupCheck: false }); contexts.push(fresh);
    expect((await fresh.catalogs.read()).directions).toEqual(remote.directions);
    expect((await fresh.catalogs.read()).goals[0].workDirectionId).toBe('custom-direction');
  }, 90000);

  it('publishes an assignment with a colon in its identity using a safe stable filename', async () => {
    const f = await fixture();
    await f.writer.catalogs.saveDraft(curator, { kind: 'assignment', id: 'demo-leader:demo-goal:3', baseRevision: null, patch: { summary: 'Изменено назначение' } });
    const operation = await f.writer.operations.start('publish'); await publishChanges(f.writer, curator, operation.id);
    const result = await f.writer.operations.get(operation.id);
    expect(result.status, result.result?.message).toBe('completed');
    await git(f.seed, 'fetch', 'origin');
    const files = (await git(f.seed, 'ls-tree', '-r', '--name-only', 'origin/release/current', '--', 'catalog/assignments')).split('\n');
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^catalog\/assignments\/object-[a-f0-9]+\.json$/);
    expect(JSON.parse(await git(f.seed, 'show', `origin/release/current:${files[0]}`)).id).toBe('demo-leader:demo-goal:3');
  }, 90000);

  it('does not overwrite a newer local edit while an older version is being pushed', async () => {
    const f = await fixture();
    const first = await draft(f.writer, { weight: 5 });
    await writeFile(join(f.remote, 'hooks/pre-receive'), '#!/bin/sh\ntouch publish-started\nsleep 1\nexit 0\n', { mode: 0o755 });
    const operation = await f.writer.operations.start('publish');
    const publishing = publishChanges(f.writer, curator, operation.id);
    let reached = false;
    for (let attempt = 0; attempt < 200; attempt++) {
      try { await access(join(f.remote, 'publish-started')); reached = true; break; } catch { await new Promise(resolve => setTimeout(resolve, 50)); }
    }
    expect(reached).toBe(true);
    const newer = await draft(f.writer, { weight: 9 });
    expect(newer.id).toBe(first.id);
    await publishing;
    const retained = f.writer.db.get<Draft>('drafts', first.id);
    expect(retained?.status).toBe('local');
    expect(retained?.change.patch.weight).toBe(9);
    expect(retained?.base?.weight).toBe(5);
    const retry = await f.writer.operations.start('publish'); await publishChanges(f.writer, curator, retry.id);
    const retried = await f.writer.operations.get(retry.id);
    expect(retried.status, retried.result?.message).toBe('completed');
    await git(f.seed, 'fetch', 'origin');
    expect(JSON.parse(await git(f.seed, 'show', 'origin/release/current:catalog/goals/demo-goal.json')).weight).toBe(9);
  }, 90000);

  it('rejects a corrupt remote catalog atomically and preserves the previous local version', async () => {
    const f = await fixture(); const original = await f.writer.catalogs.read();
    await mkdir(join(f.seed, 'catalog/goals'), { recursive: true });
    await writeFile(join(f.seed, 'catalog/goals/demo-goal.json'), encode({ ...original.goals[0], weight: 'broken-number' }));
    await commitSeed(f.seed, 'Invalid synthetic catalog');
    await expect(syncPublished(f.writer)).rejects.toThrow();
    expect(await f.writer.catalogs.read()).toEqual(original);
    expect(f.writer.db.get('settings', 'publishedCommit')).toBeNull();
  }, 90000);

  it('publishes an embedded-catalog draft and delivers the released result without shadowing a later remote edit', async () => {
    const f = await fixture();
    const publishedDraft = await draft(f.writer, { weight: 5 });
    const operation = await f.writer.operations.start('publish');
    await publishChanges(f.writer, curator, operation.id);
    const published = await f.writer.operations.get(operation.id);
    expect(published.status, published.result?.message).toBe('completed');
    expect((await f.reader.catalogs.read()).goals[0].weight).toBe(1);
    await git(f.seed, 'fetch', 'origin');
    await git(f.seed, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'merge', '--no-ff', 'origin/release/current', '-m', 'Release curator work');
    await git(f.seed, 'push', 'origin', 'main');
    await syncPublished(f.reader);
    expect((await f.reader.catalogs.read()).goals[0].weight).toBe(5);
    const unsent = await draft(f.writer, { title: 'Новый неотправленный черновик' });
    await syncPublished(f.writer);
    expect(f.writer.db.get<Draft>('drafts', publishedDraft.id)).toBeNull();
    expect(f.writer.db.get<Draft>('drafts', unsent.id)?.status).toBe('local');
    const goalPath = join(f.seed, 'catalog/goals/demo-goal.json');
    const goal = JSON.parse(await readFile(goalPath, 'utf8'));
    await writeFile(goalPath, encode({ ...goal, weight: 7 }));
    const attestation = { id: 'demo-confirmation', goalId: 'demo-goal', leaderId: null, fingerprint: 'demo-fingerprint', period: '2026-10',
      curatorId: curator.curatorId, curatorName: curator.name, confirmedAt: '2026-10-24T00:00:00Z', comment: 'Синтетическое основание', evidenceIds: [] };
    const invalidatedAt = '2026-10-24T01:00:00Z';
    f.writer.db.set('attestations', attestation.id, { ...attestation, invalidatedAt, invalidationReason: 'Локально зафиксирован регресс' });
    await mkdir(join(f.seed, 'published/attestations/demo-goal'), { recursive: true });
    await writeFile(join(f.seed, 'published/attestations/demo-goal/demo-confirmation.json'), encode(attestation));
    await git(f.seed, 'add', 'published');
    await commitSeed(f.seed, 'A newer main change after release');
    await syncPublished(f.writer);
    const display = await f.writer.catalogs.readForSession(curator);
    expect(display.goals[0].weight).toBe(7);
    expect(display.goals[0].title).toBe('Новый неотправленный черновик');
    expect(f.writer.db.get<{ invalidatedAt: string }>('attestations', attestation.id)?.invalidatedAt).toBe(invalidatedAt);
  }, 90000);

  it('uses the cloned main baseline on first check and detects a subsequent remote commit', async () => {
    const f = await fixture();
    const baseline = await git(f.seed, 'rev-parse', 'main');
    expect(f.writer.db.get('settings', 'publishedCommit')).toBeNull();
    await checkRemoteUpdates(f.writer);
    expect(f.writer.updates.status).toBe('current');
    expect(f.writer.updates.changes).toEqual([]);
    expect(f.writer.db.get('settings', 'publishedCommit')).toBe(baseline);
    const changed = catalog(); changed.goals[0].weight = 9;
    await writeFile(join(f.seed, 'catalog/demo.json'), encode(changed)); await commitSeed(f.seed, 'Colleague updates data');
    await checkRemoteUpdates(f.writer);
    expect(f.writer.updates.status).toBe('available');
    expect(f.writer.updates.changes.length).toBeGreaterThan(0);
    expect((await f.writer.catalogs.read()).goals[0].weight).toBe(1);
    expect(await git(f.writer.paths.projectRoot, 'rev-parse', 'main')).toBe(baseline);
  }, 90000);

  it('keeps a curator draft local when the Git server rejects publication', async () => {
    const f = await fixture(); const pending = await draft(f.writer, { weight: 4 });
    await writeFile(join(f.remote, 'hooks/pre-receive'), '#!/bin/sh\necho "permission denied" >&2\nexit 1\n', { mode: 0o755 });
    const operation = await f.writer.operations.start('publish'); await publishChanges(f.writer, curator, operation.id);
    expect((await f.writer.operations.get(operation.id)).status).toBe('failed');
    expect((await f.writer.operations.get(operation.id)).result?.message).toMatch(/отклонил запись|права Git/);
    expect(f.writer.db.get<Draft>('drafts', pending.id)?.status).toBe('local');
    expect((await f.writer.catalogs.readForSession(curator)).goals[0].weight).toBe(4);
  }, 90000);
});

it('publishes only selected evidence/template bytes and loads them in an offline fresh clone',async()=>{
 const f=await fixture(),bytes=Buffer.from('Синтетическое доказательство'),id=randomUUID();
 await writeFile(join(f.writer.paths.runtimeRoot,'evidence',id),bytes);
 f.writer.db.set('evidence',id,{id,name:'Подтверждение.txt',relativePath:'evidence/'+id,sha256:createHash('sha256').update(bytes).digest('hex'),size:bytes.length,curatorId:curator.curatorId,classification:'demo',ownerInstallationId:f.writer.installationId,uploadedBy:curator.name,uploadedAt:new Date().toISOString()});
 const deck=new PptxGenJS();deck.addSlide().addText('{{report.period}}',{x:1,y:1,w:6,h:1});
 const template=await saveReportTemplate(f.writer,curator,{baseRevision:null,base64:Buffer.from(await deck.write({outputType:'nodebuffer'}) as Buffer).toString('base64'),profile:{name:'Общий шаблон',bindings:[],repeats:[]}});
 await draft(f.writer,{weight:9});
 const operation=await f.writer.operations.start('publish');
 await publishChanges(f.writer,curator,operation.id,[],{snapshotIds:[],attestationIds:[],evidenceIds:[id],templateIds:[template.id]});
 const result=await f.writer.operations.get(operation.id);expect(result.status,result.result?.message).toBe('completed');
 expect((await f.writer.catalogs.listDrafts(curator))[0].status).toBe('local');
 await git(f.seed,'fetch','origin');await git(f.seed,'-c','user.name=Fixture','-c','user.email=fixture@localhost','merge','--no-ff','origin/release/current','-m','Release verified assets');await git(f.seed,'push','origin','main');
 await syncPublished(f.reader);const reader={...curator,role:'reader' as const,curatorId:null};
 expect((await listEvidence(f.reader,reader)).map(e=>e.id)).toContain(id);expect((await readEvidenceBytes(f.reader,reader,id)).bytes.equals(bytes)).toBe(true);expect(listReportTemplates(f.reader,reader)[0].id).toBe(template.id);
 const clone=join(f.root,'fresh-assets');await execute('git',['clone','--branch','main',f.remote,clone]);const fresh=await createContext({projectRoot:clone,allowedRoots:[f.root],startupCheck:false});contexts.push(fresh);
 expect((await listEvidence(fresh,reader)).map(e=>e.id)).toContain(id);expect((await readEvidenceBytes(fresh,reader,id)).bytes.equals(bytes)).toBe(true);expect(listReportTemplates(fresh,reader)[0].profile.name).toBe('Общий шаблон');expect((await fresh.catalogs.read()).goals[0].weight).toBe(1);
 // Untrusted replacement is validated before any catalog mutation.
 await mkdir(join(f.seed,'published/evidence'),{recursive:true});const bundleFile=join(f.seed,'published/evidence',id+'.json');const bundle=JSON.parse(await readFile(bundleFile,'utf8'));bundle.base64=Buffer.from('tampered').toString('base64');await writeFile(bundleFile,JSON.stringify(bundle));await git(f.seed,'add','published');await git(f.seed,'-c','user.name=Fixture','-c','user.email=fixture@localhost','commit','-m','Invalid fixture hash');await git(f.seed,'push','origin','main');
 await expect(syncPublished(f.reader)).rejects.toThrow(/Размер|Хеш/);expect((await readEvidenceBytes(f.reader,reader,id)).bytes.equals(bytes)).toBe(true);
},90000);
