import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { APP_VERSION } from '../../../domain/app-version';
import { entityReferences, schemaForEntity, publicationAnchorSchema, validateReferences } from '../../../domain/workbench/schemas';
import type { WorkbenchEntity, WorkbenchEntityType } from '../../../domain/workbench/entities';
import type { Header } from '../../../domain/workbench/primitives';
import type { WorkbenchRepository, WorkspaceCoreRecord } from '../../../server/storage/workbench-repository';
import { WorkbenchHttpError } from '../../../server/workbench/protocol';
import { loadMaturityMaterials, makeMaturityDefinitions } from '../../maturity/workbench-materials';
import { defaultWeeklyPrompt } from '../../weekly-report/workbench/prompts';
import { defaultReportDefinition } from '../../reporting/workbench/contracts';
import { setupPackageSchema, setupSelectionSchema, setupValueSchemas, type SetupPackage, type SetupSelection, type SetupRecord } from './setup-package-contracts';
export const setupCanonical = (v: unknown): string => JSON.stringify(v, (_k, value) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value);
export const setupHash = (v: unknown) => createHash('sha256').update(setupCanonical(v)).digest('hex');
const byteHash = (v: Uint8Array) => createHash('sha256').update(v).digest('hex');
const fail = (code: string): never => { throw new WorkbenchHttpError(422, code, code); };
const forbidden = /^(?:\.runtime|\.git|node_modules|config|\.env)(?:\/|$)|(?:^|\/)(?:cookies?|credentials?|sessions?|browser-profiles)(?:\/|$)/i;
export const coreKey = (v: {
    entityType: string;
    version: number;
    value: Record<string, unknown>;
}) => `${v.entityType}/${v.value.id}/${v.version}`;
const privateKey = /(?:password|secret|accessToken|refreshToken|cookie|credential|profileDirectory|executablePath|absolutePath)/i;
function publicContent(value: unknown): void { if (Array.isArray(value)) {
    value.forEach(publicContent);
    return;
} if (value && typeof value === 'object')
    for (const [k, v] of Object.entries(value)) {
        if (privateKey.test(k))
            fail('SETUP_PRIVATE_CONTENT');
        publicContent(v);
    }
else if (typeof value === 'string' && (/^(?:[A-Za-z]:[\\/]|file:\/\/|\/|\\\\)/.test(value) || /https?:\/\/[^\s/]+:[^\s/]+@/.test(value)))
    fail('SETUP_PRIVATE_CONTENT'); }
const semver = (v: string) => v.split('.').map(Number);
export function validateSetupPackage(input: unknown, appVersion = APP_VERSION): SetupPackage {
    const p = setupPackageSchema.parse(input);
    if (Buffer.byteLength(JSON.stringify(p)) > 900000)
        fail('SETUP_TOO_LARGE');
    const a = semver(appVersion), b = semver(p.minAppVersion);
    if (a[0] < b[0] || a[0] === b[0] && (a[1] < b[1] || a[1] === b[1] && a[2] < b[2]))
        fail('SETUP_APP_VERSION');
    const { sha256, ...body } = p;
    if (setupHash(body) !== sha256)
        fail('SETUP_HASH_MISMATCH');
    const keys = new Set<string>();
    for (const r of p.records) {
        if (keys.has(r.key))
            fail('SETUP_DUPLICATE');
        keys.add(r.key);
        setupValueSchemas[r.kind].parse(r.value);
        publicContent(r.value);
        if (setupHash(r.value) !== r.sha256)
            fail('SETUP_HASH_MISMATCH');
    }
    for (const r of p.records)
        for (const d of r.dependencies)
            if (!keys.has(d))
                fail('SETUP_CLOSURE_MISSING');
    const reference = p.records.find(r => r.kind === 'maturity-reference');
    if (reference) {
        const expected = loadMaturityMaterials().sources;
        const value = setupValueSchemas['maturity-reference'].parse(reference.value);
        for (const source of value.sources) {
            const known = expected.find(v => v.kind === source.kind);
            if (!known || source.path !== known.path || source.sha256 !== known.sha256 || source.bytes !== known.bytes)
                fail('SETUP_MATERIAL_SOURCE_INVALID');
            const attached = p.files.find(v => v.path === source.path);
            if (attached && (attached.sha256 !== source.sha256 || attached.bytes !== source.bytes))
                fail('SETUP_HASH_MISMATCH');
        }
    }
    for (const definition of p.records.filter(r => r.kind === 'maturity-definition')) {
        if (!reference || setupHash(definition.value) !== setupHash(makeMaturityDefinitions(setupValueSchemas['maturity-reference'].parse(reference.value))))
            fail('SETUP_DEFINITION_MISMATCH');
    }
    const files = new Set<string>();
    for (const f of p.files) {
        if (forbidden.test(f.path) || !/^(?:materials\/maturity\/2026-10-30\/|data\/reference\/)/.test(f.path) || files.has(f.path))
            fail('SETUP_PRIVATE_PATH');
        files.add(f.path);
        const bytes = Buffer.from(f.bytesBase64, 'base64');
        if (bytes.toString('base64') !== f.bytesBase64 || bytes.length !== f.bytes || byteHash(bytes) !== f.sha256)
            fail('SETUP_HASH_MISMATCH');
    }
    if (p.inventory.records !== p.records.length || p.inventory.coreVersions !== p.core.length || p.inventory.files !== p.files.length || p.inventory.bytes !== p.files.reduce((n, f) => n + f.bytes, 0))
        fail('SETUP_INVENTORY');
    const seen = new Set<string>();
    const anchors = new Map<string, unknown>();
    for (const c of p.core) {
        if (seen.has(coreKey(c)))
            fail('SETUP_DUPLICATE');
        seen.add(coreKey(c));
        publicContent(c.value);
        if (c.entityType === 'publication_anchor') {
            const anchor = publicationAnchorSchema.parse(c.value);
            if (anchor.publicationState !== 'confirmed')
                fail('SETUP_UNPUBLISHED');
            anchors.set(anchor.id, anchor);
        }
        else {
            const v = schemaForEntity(c.entityType).parse(c.value);
            if (v.revision !== c.version || !v.publicationAnchorId)
                fail('SETUP_UNPUBLISHED');
            if (c.entityType === 'evidence' && (v as any).kind === 'file' || c.entityType === 'capture' && (v as any).rawArtifactId !== null)
                fail('SETUP_PRIVATE_ARTIFACT');
        }
    }
    const resolver = (ref: {
        entityType: string;
        id: string;
        revision?: number;
    }) => ref.entityType === 'publication_anchor' ? anchors.get(ref.id) ?? null : p.core.filter(c => c.entityType === ref.entityType && c.value.id === ref.id && (ref.revision === undefined || c.version === ref.revision)).sort((a, b) => b.version - a.version)[0]?.value ?? null;
    for (const c of p.core)
        if (c.entityType !== 'publication_anchor')
            validateReferences(entityReferences(c.entityType as WorkbenchEntityType, c.value as WorkbenchEntity), resolver);
    return p;
}
export async function buildCommonSetupPackage(options: {
    projectRoot: string;
    selection: SetupSelection;
    repository?: WorkbenchRepository;
    packageId?: string;
    version?: number;
    presets?: SetupRecord[];
}): Promise<SetupPackage> {
    const selection = setupSelectionSchema.parse(options.selection), records: SetupRecord[] = [], files: SetupPackage['files'] = [], core: SetupPackage['core'] = [];
    const add = (key: string, kind: SetupRecord['kind'], value: unknown, dependencies: string[] = []) => { const parsed = setupValueSchemas[kind].parse(value) as Record<string, unknown>; records.push({ key, kind, value: parsed, dependencies, sha256: setupHash(parsed) }); };
    const material = loadMaturityMaterials();
    if (selection.references || selection.materials) {
        add('maturity-reference', 'maturity-reference', material);
        add('maturity-definition', 'maturity-definition', makeMaturityDefinitions(material), ['maturity-reference']);
    }
    if (selection.materials) {
        const root = await realpath(options.projectRoot);
        for (const relative of ['materials/maturity/2026-10-30/source.xlsx', 'materials/maturity/2026-10-30/source.pptx', 'materials/maturity/2026-10-30/manifest.json', 'data/reference/maturity-2026-10-30.csv']) {
            const filename = path.join(root, relative);
            if (await realpath(filename) !== filename)
                fail('SETUP_PRIVATE_PATH');
            const bytes = await readFile(filename);
            files.push({ path: relative, sha256: byteHash(bytes), bytes: bytes.length, bytesBase64: bytes.toString('base64') });
        }
    }
    if (selection.weeklyPrompts)
        add('weekly-default', 'weekly-prompt', defaultWeeklyPrompt);
    if (selection.dashboards)
        add('goal-overview', 'dashboard-template', { title: 'Обзор целей', blocks: ['summary', 'matrix', 'quality', 'sources'], requiresGoalSelection: true });
    if (selection.reports) {
        const d = defaultReportDefinition(material.period);
        add('maturity-management-v1', 'report-recipe', d);
        add('goal-management-v1', 'report-recipe', { ...d, template: 'goal-management-v1', title: 'Состояние цели', teamIds: [] });
    }
    if (selection.publishedRoots.length) {
        const repo = options.repository;
        if (!repo)
            fail('SETUP_REPOSITORY_REQUIRED');
        const all = repo!.exportWorkspaceCore(), visited = new Set<string>();
        const include = (ref: {
            entityType: string;
            id: string;
            revision?: number;
        }) => { const record = all.filter(v => v.entityType === ref.entityType && v.value.id === ref.id && (ref.revision === undefined || v.version === ref.revision)).sort((a, b) => b.version - a.version)[0]; if (!record)
            fail('SETUP_CLOSURE_MISSING'); const c = record! as unknown as SetupPackage['core'][number], key = coreKey(c); if (visited.has(key))
            return; visited.add(key); core.push(c); if (c.entityType !== 'publication_anchor')
            for (const dep of entityReferences(c.entityType as WorkbenchEntityType, c.value as WorkbenchEntity))
                include(dep.ref); };
        selection.publishedRoots.forEach(include);
    }
    for(const saved of options.presets??[]){if(!['weekly-prompt','report-recipe','dashboard-template'].includes(saved.kind))continue;const index=records.findIndex(r=>r.key===saved.key&&r.kind===saved.kind);if(index>=0)records[index]=structuredClone(saved);}
    const body = { schemaVersion: 1 as const, format: 'uor-common-setup' as const, packageId: options.packageId ?? 'uor-common', version: options.version ?? 1, minAppVersion: APP_VERSION, selection, provenance: { kind: 'selected-common-content' as const, description: 'Selected authorized originals and source-reported references; published core retains original confirmed provenance. No inferred accepted history.', sourceHashes: material.sources.map(s => s.sha256) }, records, core, files, inventory: { records: records.length, coreVersions: core.length, files: files.length, bytes: files.reduce((n, f) => n + f.bytes, 0) } };
    return validateSetupPackage({ ...body, sha256: setupHash(body) });
}
