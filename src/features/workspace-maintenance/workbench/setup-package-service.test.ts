import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createWorkbenchRepository, type WorkbenchRepository } from '../../../server/storage/workbench-repository';
import { buildCommonSetupPackage, validateSetupPackage } from './setup-package-builder';
import { SetupPackageService } from './setup-package-service';
const owners = [{ installationId: '00000000-0000-4000-8000-000000000001', personId: '00000000-0000-4000-8000-000000000011' }, { installationId: '00000000-0000-4000-8000-000000000002', personId: '00000000-0000-4000-8000-000000000022' }];
const roots: string[] = [], repos: WorkbenchRepository[] = [];
afterEach(() => { repos.forEach(r => r.close()); repos.length = 0; roots.splice(0).forEach(r => rmSync(r, { recursive: true, force: true })); });
function service() { const root = mkdtempSync(path.join(os.tmpdir(), 'uor-setup-')); roots.push(root); const r = createWorkbenchRepository({ filename: path.join(root, 'workbench.sqlite'), artifactRoot: path.join(root, 'files') }); repos.push(r); return new SetupPackageService(r); }
it('installs identical common package into two new owner databases without inventing accepted facts or copying identity', async () => {
    const pkg = await buildCommonSetupPackage({ projectRoot: process.cwd(), selection: { materials: true, references: true, dashboards: true, reports: true, weeklyPrompts: true } });
    expect(pkg.files.map(f => f.path)).toContain('materials/maturity/2026-10-30/source.xlsx');
    expect(pkg.records.map(r => r.kind)).toEqual(expect.arrayContaining(['maturity-definition', 'maturity-reference', 'dashboard-template', 'report-recipe', 'weekly-prompt']));
    const a = service(), b = service();
    for (const [i, s] of [a, b].entries()) {
        const p = s.preview(owners[i], pkg);
        s.apply(owners[i], { package: pkg, previewDigest: p.digest });
        expect(s.catalog(owners[i]).records.length).toBeGreaterThan(3);
        expect(repos[i].exportWorkspaceCore()).toEqual([]);
    }
    expect(a.catalog(owners[0]).records).toEqual(b.catalog(owners[1]).records);
    expect(a.catalog(owners[1]).records).toEqual([]);
    const p = a.preview(owners[0], pkg);
    expect(p.changes.every(v => v.action === 'unchanged')).toBe(true);
    a.apply(owners[0], { package: pkg, previewDigest: p.digest });
    expect(a.catalog(owners[0]).rescues).toHaveLength(1);
});
it('rejects private paths, tampered hashes, unsupported schema and missing closure before any mutation', async () => {
    const pkg = await buildCommonSetupPackage({ projectRoot: process.cwd(), selection: { materials: true, references: true, dashboards: false, reports: false, weeklyPrompts: false } });
    for (const mutate of [(p: any) => p.files[0].path = '.runtime/cookies.json', (p: any) => p.files[0].bytesBase64 = 'YQ==', (p: any) => p.schemaVersion = 2, (p: any) => p.records.splice(0, 1)]) {
        const bad = structuredClone(pkg);
        mutate(bad);
        expect(() => validateSetupPackage(bad)).toThrow();
    }
});
it('uses CAS and preserves locally edited records on package update with a durable rescue', async () => {
    const s = service();
    const pkg = await buildCommonSetupPackage({ projectRoot: process.cwd(), selection: { materials: false, references: false, dashboards: false, reports: false, weeklyPrompts: true } });
    s.apply(owners[0], { package: pkg, previewDigest: s.preview(owners[0], pkg).digest });
    const stale = s.preview(owners[0], pkg);
    const record = s.catalog(owners[0]).records[0];
    s.edit(owners[0], record.key, { ...record.value, editor: 'Local editorial instruction' }, s.catalog(owners[0]).revision);
    expect(() => s.apply(owners[0], { package: pkg, previewDigest: stale.digest })).toThrow(/PREVIEW_STALE/);
    const next = await buildCommonSetupPackage({ projectRoot: process.cwd(), version: 2, selection: { materials: false, references: false, dashboards: false, reports: false, weeklyPrompts: true } });
    const preview = s.preview(owners[0], next);
    expect(preview.changes[0].action).toBe('conflict');
    s.apply(owners[0], { package: next, previewDigest: preview.digest });
    expect(s.catalog(owners[0]).records[0].value).toMatchObject({ editor: 'Local editorial instruction' });
    expect(s.catalog(owners[0]).rescues).toHaveLength(2);
});
it('imports selected published goal/source/method closure into the canonical catalog and preserves unrelated own drafts', async () => {
    const { makeEntityGraph } = await import('../../../../tests/fixtures/workbench/factories');
    const { seedGraph } = await import('../../../../tests/fixtures/workbench/repository');
    const source = service(), a = service(), b = service();
    const graph = makeEntityGraph();
    seedGraph(source.repository, graph);
    const roots = graph.entries.filter(e => ['goal_assignment', 'observed_fact'].includes(e.entityType)).map(e => ({ entityType: e.entityType, id: e.value.id, revision: e.value.revision }));
    const pkg = await buildCommonSetupPackage({ projectRoot: process.cwd(), repository: source.repository, selection: { materials: false, references: false, dashboards: false, reports: false, weeklyPrompts: false, publishedRoots: roots } });
    expect(pkg.core.some(c => c.entityType === 'source_field_mapping')).toBe(true);
    expect(pkg.core.some(c => c.entityType === 'method_version')).toBe(true);
    for (const [i, s] of [a, b].entries()) {
        s.apply(owners[i], { package: pkg, previewDigest: s.preview(owners[i], pkg).digest });
        expect(s.repository.readPublishedHead({ entityType: 'core_goal_definition', id: graph.input.goal.id })).toEqual(graph.input.goal);
        expect(s.repository.readPublishedCatalog().some(v => v.entityType === 'source_definition')).toBe(true);
    }
    const goal = graph.input.goal;
    a.repository.append('core_goal_definition', { ...goal, revision: 2, publicationAnchorId: null, title: 'Private local edit' }, 1);
    a.apply(owners[0], { package: pkg, previewDigest: a.preview(owners[0], pkg).digest });
    expect(a.repository.getHead({ entityType: 'core_goal_definition', id: goal.id })).toMatchObject({ title: 'Private local edit' });
});
it('rejects a recomputed package that redirects material reads to arbitrary filesystem paths', async () => {
    const { setupHash } = await import('./setup-package-builder');
    const original = await buildCommonSetupPackage({ projectRoot: process.cwd(), selection: { materials: false, references: true, dashboards: false, reports: false, weeklyPrompts: false } });
    for (const badPath of ['/etc/passwd', '../private.xlsx', 'materials/alien/source.xlsx']) {
        const p = structuredClone(original);
        const record = p.records.find(r => r.kind === 'maturity-reference')!;
        (record.value.sources as any[])[0].path = badPath;
        record.sha256 = setupHash(record.value);
        const { sha256, ...body } = p;
        p.sha256 = setupHash(body);
        expect(() => validateSetupPackage(p)).toThrow();
    }
});

it('re-exports same-owner archive records identically on a new installation and keeps its local owner binding',async()=>{
 const {createSetupArchiveOwner}=await import('./setup-package-service');const a=service(),b=service(),person=owners[0].personId;
 const pkg=await buildCommonSetupPackage({projectRoot:process.cwd(),selection:{materials:false,references:false,dashboards:false,reports:false,weeklyPrompts:true}});a.apply(owners[0],{package:pkg,previewDigest:a.preview(owners[0],pkg).digest});
 const env=(installationId:string)=>({installationId,personId:()=>person,localPreview:true,subjectRoot:()=>roots[0]});const from=createSetupArchiveOwner(a.repository,env(owners[0].installationId)),to=createSetupArchiveOwner(b.repository,env(owners[1].installationId)),records=from.exportRecords(a.repository);
 to.restoreRecords(b.repository,records,{installationId:owners[1].installationId,personId:person,files:new Map(),stagedRoot:roots[1],subjectPath:()=>{throw Error('No files');}});
 expect(to.exportRecords(b.repository)).toEqual(records);expect(b.catalog({...owners[1],personId:person}).records).toHaveLength(1);
});

it('exports a selected edited common preset as a new version and applies its diff without overwriting another local choice',async()=>{
 const a=service(),b=service();const selection={materials:false,references:false,dashboards:true,reports:false,weeklyPrompts:false};const v1=await buildCommonSetupPackage({projectRoot:process.cwd(),selection});for(const [i,s]of[a,b].entries())s.apply(owners[i],{package:v1,previewDigest:s.preview(owners[i],v1).digest});
 a.edit(owners[0],'goal-overview',{title:'New shared overview',blocks:['quality'],requiresGoalSelection:true},a.catalog(owners[0]).revision);
 const v2=await buildCommonSetupPackage({projectRoot:process.cwd(),selection,version:2,presets:a.catalog(owners[0]).records});const diff=b.preview(owners[1],v2);expect(diff.changes).toEqual([{key:'goal-overview',action:'update'}]);b.apply(owners[1],{package:v2,previewDigest:diff.digest});expect(b.catalog(owners[1]).records[0].value.title).toBe('New shared overview');
});
