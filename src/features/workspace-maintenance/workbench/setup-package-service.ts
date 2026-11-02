import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { Header } from '../../../domain/workbench/primitives';
import type { PublicationAnchor } from '../../../domain/workbench/publication';
import type { WorkbenchRepository } from '../../../server/storage/workbench-repository';
import { WorkbenchHttpError, ownQueryRequestSchema } from '../../../server/workbench/protocol';
import type { BackupCreateResult } from './contracts';
import { backupCreateResultSchema } from './contracts';
import type { CommandContext, CommandRegistry } from '../../../server/workbench/command-registry';
import type { QueryRegistry } from '../../../server/workbench/query-registry';
import { commitCommandEffect } from '../../../server/workbench/command-store';
import { subjectTableOwner } from './subject-archive-owners';
import type { ProductionArchiveEnvironment, ProductionArchiveOwner } from './production-archive-contracts';
import { setupOwnerSchema, setupRecordSchema, setupPackageSchema, setupSelectionSchema, setupPreviewSchema, setupValueSchemas, type SetupOwner, type SetupPackage, type SetupRecord, type SetupPreview } from './setup-package-contracts';
import { validateSetupPackage, setupHash, coreKey, buildCommonSetupPackage } from './setup-package-builder';
const portableOwnerSchema=z.strictObject({personId:z.string().uuid().nullable(),installationId:z.string().uuid().optional()}).refine(v=>v.personId!==null?v.installationId===undefined:!!v.installationId);
const portableOwner=(owner:SetupOwner)=>owner.personId?{personId:owner.personId}:{personId:null,installationId:owner.installationId};
const stateSchema = z.strictObject({ schemaVersion: z.literal(1), revision: z.number().int().nonnegative(), owner: setupOwnerSchema, records: z.array(setupRecordSchema), packages: z.array(setupPackageSchema), rescues: z.array(z.strictObject({ id: z.string().uuid(), createdAt: z.string(), previousRecords: z.array(setupRecordSchema), previousPackageHashes: z.array(z.string()), previousCoreKeys: z.array(z.string()), backup: backupCreateResultSchema.nullable() })) });
export type SetupCatalog = z.infer<typeof stateSchema>;
function validateStateContent(value:{records:SetupRecord[];packages:SetupPackage[];rescues:Array<{previousRecords:SetupRecord[]}>}):void{
 for(const p of value.packages)validateSetupPackage(p);
 const records=[...value.records,...value.rescues.flatMap(v=>v.previousRecords)];
 for(const record of records){setupValueSchemas[record.kind].parse(record.value);if(setupHash(record.value)!==record.sha256)fail('SETUP_HASH_MISMATCH');}
 for(const record of value.records.filter(v=>v.kind==='maturity-reference'||v.kind==='maturity-definition'))if(!value.packages.some(p=>p.records.some(r=>r.key===record.key&&r.kind===record.kind&&r.sha256===record.sha256)))fail('SETUP_IMMUTABLE_MATERIAL');
}

const key = (owner: SetupOwner) => JSON.stringify([owner.installationId, owner.personId]);
const fail = (code: string): never => { throw new WorkbenchHttpError(409, code, code); };
export class SetupPackageService {
    constructor(readonly repository: WorkbenchRepository) { repository.sqlForModule('setup').execMigration('v1', 'CREATE TABLE wb_setup_catalog(owner_key TEXT PRIMARY KEY,payload TEXT NOT NULL)'); }
    catalog(owner: SetupOwner): SetupCatalog { setupOwnerSchema.parse(owner); const row = this.repository.sqlForModule('setup').get<{
        payload: string;
    }>('SELECT payload FROM wb_setup_catalog WHERE owner_key=?', [key(owner)]); return row ? stateSchema.parse(JSON.parse(row.payload)) : { schemaVersion: 1, revision: 0, owner, records: [], packages: [], rescues: [] }; }
    commonValue<T>(owner: SetupOwner, kind: SetupRecord['kind'], recordKey: string, fallback: T): T { const record = this.catalog(owner).records.find(v => v.kind === kind && v.key === recordKey); return record ? structuredClone(record.value) as T : fallback; }
    preview(owner: SetupOwner, input: unknown): SetupPreview {
        const p = validateSetupPackage(input), state = this.catalog(owner), prior = state.packages.find(v => v.packageId === p.packageId);
        if (prior && prior.version > p.version)
            fail('SETUP_DOWNGRADE');
        if (prior && prior.version === p.version && prior.sha256 !== p.sha256)
            fail('SETUP_VERSION_REUSED');
        const changes = p.records.map(r => { const current = state.records.find(v => v.key === r.key), baseline = prior?.records.find(v => v.key === r.key); return { key: r.key, action: !current ? 'add' : current.sha256 === r.sha256 ? 'unchanged' : baseline && current.sha256 === baseline.sha256 ? 'update' : 'conflict' } as SetupPreview['changes'][number]; });
        const coreChanges = p.core.map(c => { const current = c.entityType === 'publication_anchor' ? this.repository.readPublicationAnchor({ entityType: c.entityType, id: String(c.value.id) }) : this.repository.readVersion({ entityType: c.entityType, id: String(c.value.id), revision: c.version }); const head = c.entityType === 'publication_anchor' ? null : this.repository.getHead({ entityType: c.entityType, id: String(c.value.id) }); return { key: coreKey(c), action: current ? setupHash(current) === setupHash(c.value) ? 'unchanged' : 'conflict' : head && !head.publicationAnchorId ? 'conflict' : 'add' } as SetupPreview['coreChanges'][number]; });
        const base = { packageHash: p.sha256, currentRevision: state.revision, changes, coreChanges, warnings: ['Личные настройки подключения, доступ, профили и незавершённые операции не переносятся.', ...(changes.some(c => c.action === 'conflict') ? ['Локальные правки пресетов будут сохранены; входящая версия останется в пакете для сравнения.'] : []), ...(coreChanges.some(c => c.action === 'conflict') ? ['Конфликт канонических данных блокирует применение целиком.'] : [])] };
        return { ...base, digest: setupHash({ owner, base, core: this.repository.exportWorkspaceCore().map(c => [c.entityType, c.value.id, c.version, setupHash(c.value)]) }) };
    }
    apply(owner: SetupOwner, input: {
        package: unknown;
        previewDigest: string;
        backup?: BackupCreateResult;
    }): {
        revision: number;
        packageHash: string;
        rescueId: string | null;
        conflicts: string[];
    } {
        const p = validateSetupPackage(input.package);
        return this.repository.transaction(() => {
            const preview = this.preview(owner, p);
            if (preview.digest !== input.previewDigest)
                fail('PREVIEW_STALE');
            if (preview.coreChanges.some(c => c.action === 'conflict'))
                fail('SETUP_CORE_CONFLICT');
            const state = this.catalog(owner), same = state.packages.find(v => v.packageId === p.packageId)?.sha256 === p.sha256;
            if (same && preview.coreChanges.every(c => c.action === 'unchanged'))
                return { revision: state.revision, packageHash: p.sha256, rescueId: null, conflicts: preview.changes.filter(c => c.action === 'conflict').map(c => c.key) };
            const rescueId = input.backup?.backupId ?? randomUUID();
            state.rescues.push({ id: rescueId, createdAt: new Date().toISOString(), backup: input.backup ?? null, previousRecords: structuredClone(state.records), previousPackageHashes: state.packages.map(v => v.sha256), previousCoreKeys: this.repository.exportWorkspaceCore().map(c => `${c.entityType}/${c.value.id}/${c.version}`) });
            for (const r of p.records) {
                const change = preview.changes.find(v => v.key === r.key)!;
                if (change.action === 'conflict' || change.action === 'unchanged')
                    continue;
                state.records = state.records.filter(v => v.key !== r.key);
                state.records.push(structuredClone(r));
            }
            for (const c of p.core.filter(v => v.entityType === 'publication_anchor'))
                if (!this.repository.readPublicationAnchor({ entityType: 'publication_anchor', id: String(c.value.id) }))
                    this.repository.appendPublicationAnchor(c.value as PublicationAnchor, null);
            for (const c of p.core.filter(v => v.entityType !== 'publication_anchor'))
                this.repository.importPublishedVersion(c.entityType, c.value as Header);
            state.packages = state.packages.filter(v => v.packageId !== p.packageId);
            state.packages.push(p);
            state.revision++;
            this.write(state);
            return { revision: state.revision, packageHash: p.sha256, rescueId, conflicts: preview.changes.filter(c => c.action === 'conflict').map(c => c.key) };
        });
    }
    edit(owner: SetupOwner, recordKey: string, value: unknown, expectedRevision: number): void { this.repository.transaction(() => { const state = this.catalog(owner); if (state.revision !== expectedRevision)
        fail('PREVIEW_STALE'); const r = state.records.find(v => v.key === recordKey); if (!r)
        fail('SETUP_RECORD_MISSING'); r!.value = setupValueSchemas[r!.kind].parse(value) as Record<string, unknown>; r!.sha256 = setupHash(r!.value); state.revision++; this.write(state); }); }
    private write(state: SetupCatalog) { stateSchema.parse(state);validateStateContent(state); this.repository.sqlForModule('setup').run('INSERT OR REPLACE INTO wb_setup_catalog(owner_key,payload) VALUES(?,?)', [key(state.owner), JSON.stringify(state)]); }
}
export function createSetupArchiveOwner(repository: WorkbenchRepository, env: ProductionArchiveEnvironment): ProductionArchiveOwner {
    new SetupPackageService(repository);
    const archiveState=stateSchema.omit({owner:true}).extend({owner:portableOwnerSchema}).superRefine((v,c)=>{try{validateStateContent(v);}catch{c.addIssue({code:'custom',message:'Invalid setup content'});}});
    return subjectTableOwner('setup', { 'setup.catalog': { schema: archiveState, key: v => JSON.stringify(v.owner), read: r => r.sqlForModule('setup').all<{
                payload: string;
            }>('SELECT payload FROM wb_setup_catalog ORDER BY owner_key').map(v => {const state=stateSchema.parse(JSON.parse(v.payload));return{...state,owner:portableOwner(state.owner)};}), write: (r, v, c) => { for (const p of v.packages)
                validateSetupPackage(p); const owner = { installationId: c?.installationId ?? env.installationId, personId: v.owner.personId }; r.sqlForModule('setup').run('INSERT INTO wb_setup_catalog(owner_key,payload) VALUES(?,?)', [key(owner), JSON.stringify({ ...v, owner })]); } } }, env, (records, p, i) => { for (const r of records) {
        const owner = archiveState.parse(r.value).owner;
        if (owner.personId !== p || !p && owner.installationId !== i)
            throw new WorkbenchHttpError(403, 'ACCESS_DENIED', 'Personal setup history belongs to another owner');
    } });
}
export function registerSetupPackageFeature(options: {
    service: SetupPackageService;
    commands: CommandRegistry;
    queries: QueryRegistry;
    projectRoot: string;
    createRescue: (context: CommandContext) => Promise<BackupCreateResult>;
}) {
    const { service, commands, queries } = options, own = (c: {
        installationId: string;
        ownAccess: {
            personId: string | null;
        };
    }) => ({ installationId: c.installationId, personId: c.ownAccess.personId });
    queries.register({ name: 'setup.catalog', inputSchema: ownQueryRequestSchema, outputSchema: stateSchema, async handler(c) { return service.catalog(own(c)); } });
    queries.register({ name: 'setup.dashboardPresets', inputSchema: ownQueryRequestSchema, outputSchema: z.array(setupRecordSchema), async handler(c) { return service.catalog(own(c)).records.filter(v => v.kind === 'dashboard-template'); } });
    queries.register({ name: 'setup.available', inputSchema: ownQueryRequestSchema, outputSchema: z.array(z.strictObject({ entityType: z.string(), id: z.string(), revision: z.number(), title: z.string() })), async handler() { return service.repository.readPublishedCatalog().map(v => ({ entityType: v.entityType, id: v.value.id, revision: v.value.revision, title: String((v.value as any).title ?? (v.value as any).name ?? v.value.id) })); } });
    commands.register({name:'setup.preset.save',capability:'personal.write',ownership:'person-if-present',effect:'local',execution:'sync',inputSchema:z.strictObject({key:z.string(),value:z.record(z.string(),z.unknown()),expectedRevision:z.number().int().nonnegative()}),outputSchema:z.strictObject({revision:z.number()}),async handler(c,input){return commitCommandEffect(c,()=>{service.edit(own(c),input.key,input.value,input.expectedRevision);return{result:{revision:service.catalog(own(c)).revision},changedRefs:[],editToken:null};});}});
    commands.register({ name: 'setup.export', capability: 'personal.write', ownership: 'person-if-present', effect: 'local', execution: 'sync', inputSchema: z.strictObject({ selection: setupSelectionSchema, version: z.number().int().positive() }), outputSchema: setupPackageSchema, async handler(c, input) { const result = await buildCommonSetupPackage({ projectRoot: options.projectRoot, repository: service.repository, selection: input.selection, version: input.version,presets:service.catalog(own(c)).records }); return commitCommandEffect(c, () => ({ result, changedRefs: [], editToken: null })); } });
    commands.register({ name: 'setup.preview', capability: 'personal.write', ownership: 'person-if-present', effect: 'local', execution: 'sync', inputSchema: z.strictObject({ package: setupPackageSchema }), outputSchema: setupPreviewSchema, async handler(c, input) { return commitCommandEffect(c, () => ({ result: service.preview(own(c), input.package), changedRefs: [], editToken: null })); } });
    commands.register({ name: 'setup.apply', capability: 'personal.write', ownership: 'person-if-present', effect: 'local', execution: 'sync', inputSchema: z.strictObject({ package: setupPackageSchema, previewDigest: z.string() }), outputSchema: z.strictObject({ revision: z.number(), packageHash: z.string(), rescueId: z.string().nullable(), conflicts: z.array(z.string()) }), async handler(c, input) { const preview = service.preview(own(c), input.package); if (preview.digest !== input.previewDigest)
            fail('PREVIEW_STALE'); if (preview.coreChanges.some(v => v.action === 'conflict'))
            fail('SETUP_CORE_CONFLICT'); const changing = service.catalog(own(c)).packages.find(v => v.packageId === input.package.packageId)?.sha256 !== input.package.sha256 || preview.coreChanges.some(v => v.action === 'add'); const backup = changing ? backupCreateResultSchema.parse(await options.createRescue(c)) : undefined; return commitCommandEffect(c, () => ({ result: service.apply(own(c), { ...input, backup }), changedRefs: input.package.core.map(v => ({ entityType: v.entityType, id: String(v.value.id) })), editToken: null })); } });
}
