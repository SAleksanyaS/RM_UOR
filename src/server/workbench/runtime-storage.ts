import { inspectLegacyRuntimeLayout, adoptLegacyRuntimeLayout } from './runtime-layout-adoption';
import { acquireRuntimeLease } from './runtime-lease';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFile, mkdir, access, lstat } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { z } from 'zod';
import type { Clock } from '../../domain/workbench/primitives';
import { uuidSchema } from '../../domain/workbench/primitives';
import { createWorkbenchRepository, type WorkbenchRepository } from '../storage/workbench-repository';
import { openReadonlyWorkbenchDatabase } from '../storage/workbench-readonly-database';
import { createStableWorkbenchRepository } from '../storage/workbench-runtime-repository';
import { captureLocalOperations, restoreLocalOperations } from './local-operation-handoff';
import type { JobStore } from './jobs';
import { WorkbenchHttpError } from './protocol';
import { assertPhysicalPath } from './files';
import { durableWrite } from '../../features/workspace-maintenance/workbench/private-storage';
import { createSubjectArchiveOwners } from '../../features/workspace-maintenance/workbench/subject-archive-owners';
import { createSourceArchiveOwners } from '../../features/workspace-maintenance/workbench/source-archive-owners';
import { prepareLegacySubjectRecords } from '../../features/workspace-maintenance/workbench/subject-legacy-archive';
import type { ProductionArchiveEnvironment, ProductionArchiveOwner } from '../../features/workspace-maintenance/workbench/production-archive-contracts';
import type { ArchiveDependencies, WorkspaceArchiveWorkspacePort, WorkspaceArchiveStageBindings, WorkspaceLifecycle, MaintenanceContext } from '../../features/workspace-maintenance/workbench/contracts';
import { archiveHash, snapshotWorkspace } from '../../features/workspace-maintenance/workbench/workspace-archive';
const pointerSchema = z.strictObject({ version: z.literal(1), active: z.string().regex(/^(?:initial|restore-[a-f0-9-]{36})$/) });
const identitySchema = z.strictObject({ installationId: uuidSchema, personId: uuidSchema });
export async function requireManagedDatabase(activeRoot: string, options: { immutable?: boolean } = {}) {
    let check: DatabaseSync | undefined;
    try {
        const filename = path.join(activeRoot, 'workbench.sqlite');
        await assertPhysicalPath(filename, false);
        if (!(await lstat(filename)).isFile()) throw Error('Not a database file');
        check = options.immutable ? openReadonlyWorkbenchDatabase(filename) : new DatabaseSync(filename, { readOnly: true });
        if (check.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok') throw Error('Invalid database');
        const revision = check.prepare("SELECT value FROM wb_meta WHERE key='state_revision'").get()?.value;
        if (typeof revision !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(revision)) throw Error('Invalid revision');
        for (const table of ['wb_schema_migrations', 'wb_entity_versions', 'wb_entity_heads', 'wb_publication_anchors'])
            if (!check.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) throw Error('Missing core schema');
    } catch {
        throw new WorkbenchHttpError(409, 'RECOVERY_REQUIRED', 'The managed active database is missing or invalid; retained history requires recovery');
    } finally { check?.close(); }
}
export async function prepareRuntimeStorage(root: string, options: {
    localPreview: boolean;
    repositoryId: string;
    applicationVersion: string;
    clock: Clock;
}) {
    const runtimeRoot = path.join(root, '.runtime', 'workbench');
    const optional = async (relative: string) => { const file = path.join(runtimeRoot, relative); try {
        await assertPhysicalPath(file, false);
        return await readFile(file, 'utf8');
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
            return null;
        throw error;
    } };
    // Identify an old database before creating identity or managed subject state.
    const firstPointer = await optional('active.json');
    if (firstPointer === null)
        await inspectLegacyRuntimeLayout(runtimeRoot);
    const releaseLease = await acquireRuntimeLease(root);
    try {
        const pointerBytes = await optional('active.json'), identityBytes = await optional('identity.json');
        let identity: z.infer<typeof identitySchema>, pointer: z.infer<typeof pointerSchema>;
        if (pointerBytes !== null) {
            pointer = pointerSchema.parse(JSON.parse(pointerBytes));
            if (identityBytes === null)
                throw new WorkbenchHttpError(409, 'RECOVERY_REQUIRED', 'Managed workspace identity is missing');
            identity = identitySchema.parse(JSON.parse(identityBytes));
        }
        else {
            const legacy = await inspectLegacyRuntimeLayout(runtimeRoot);
            if (legacy.kind === 'personal') {
                if (!options.localPreview)
                    throw new WorkbenchHttpError(409, 'WORKSPACE_LAYOUT_MIGRATION_REQUIRED', 'Legacy layout requires an explicit trusted current-person migration');
                identity = { installationId: legacy.installationId, personId: legacy.installationId };
                if (identityBytes !== null && JSON.stringify(identitySchema.parse(JSON.parse(identityBytes))) !== JSON.stringify(identity))
                    throw new WorkbenchHttpError(409, 'RECOVERY_REQUIRED', 'Existing workspace identities disagree');
                const adopted = await adoptLegacyRuntimeLayout({ runtimeRoot, ...identity, ...options });
                pointer = { version: 1, active: path.basename(adopted.newRoot) };
                pointerSchema.parse(pointer);
            }
            else {
                if (identityBytes !== null) throw new WorkbenchHttpError(409, 'RECOVERY_REQUIRED', 'Managed identity has no active pointer');
                identity = { installationId: randomUUID(), personId: randomUUID() };
                if (await optional('subject/initial/workbench.sqlite') !== null)
                    throw new WorkbenchHttpError(409, 'RECOVERY_REQUIRED', 'Managed subject database has no active pointer');
                for (const directory of [path.join(runtimeRoot, 'subject'), path.join(runtimeRoot, 'maintenance'), path.join(runtimeRoot, 'subject/initial')]) {
                    await mkdir(directory, { recursive: true });
                    await assertPhysicalPath(directory, true);
                }
                // A durable pointer must never name a database that has not been created.
                // Interruption after this close but before pointer publication remains recovery-required.
                const initialRoot = path.join(runtimeRoot, 'subject/initial');
                const initial = createWorkbenchRepository({ filename: path.join(initialRoot, 'workbench.sqlite'), artifactRoot: path.join(initialRoot, 'files') });
                initial.close();
                pointer = { version: 1, active: 'initial' };
            }
            if (identityBytes === null)
                await durableWrite(runtimeRoot, 'identity.json', JSON.stringify(identity));
            await durableWrite(runtimeRoot, 'active.json', JSON.stringify(pointer));
        }
        const activeRoot = path.join(runtimeRoot, 'subject', pointer.active);
        await assertPhysicalPath(activeRoot, true);
        await requireManagedDatabase(activeRoot);
        return { runtimeRoot, activeRoot, ...identity, releaseLease };
    }
    catch (error) {
        await releaseLease();
        throw error;
    }
}
/** One gate for every request and accepted job; coordinator identity is server-only. */
export function createRuntimeStorage(input: {
    prepared: Awaited<ReturnType<typeof prepareRuntimeStorage>>;
    clock: Clock;
    personId: string | null;
    localPreview: boolean;
    repositoryId: string;
    applicationVersion: string;
    candidate: boolean;
}) {
    const { prepared, clock } = input;
    let active = prepared.activeRoot;
    const open = (root: string) => createWorkbenchRepository({ filename: path.join(root, 'workbench.sqlite'), artifactRoot: path.join(root, 'files') });
    let native = open(active);
    const stable = createStableWorkbenchRepository(native), repository = stable.repository;
    const environment: ProductionArchiveEnvironment = { installationId: prepared.installationId, personId: () => input.personId, localPreview: input.localPreview, subjectRoot: () => active };
    let owners: ProductionArchiveOwner[] = [];
    let archive: ArchiveDependencies;
    let jobs: JobStore;
    let rebuild = () => { };
    let pause = async () => { };
    let resume = () => { };
    let invalidate = () => { };
    let closed = input.candidate, frozen = false, maintenanceOwner: string | null = null, requests = 0;
    const scope = new AsyncLocalStorage<{
        commandId: string | null;
    }>();
    const stageBindings = (root: string, target: WorkbenchRepository): WorkspaceArchiveStageBindings => {
        const env = { ...environment, localPreview: false, subjectRoot: () => root };
        const bound = [...createSubjectArchiveOwners(target, env), ...createSourceArchiveOwners(target, env)];
        return {
            modules: new Map(bound.map(owner => [owner.moduleId, owner])),
            omittedOriginals: () => bound.some(owner => owner.omittedOriginals?.(target) === true),
            validateArchive: value => validateOwnerArchive(bound, value),
            async files(records) {
                const files = new Map<string, Awaited<ReturnType<ProductionArchiveOwner['files']>>[number]>();
                for (const owner of bound) for (const file of await owner.files(target, records.filter(record => record.moduleId === owner.moduleId))) {
                    const previous = files.get(file.path);
                    if (previous && archiveHash(previous.bytesValue) !== archiveHash(file.bytesValue)) throw fail();
                    if (!previous || previous.kind === 'original' && file.kind !== 'original') files.set(file.path, file);
                }
                return [...files.values()];
            },
        };
    };
    const fail = () => new WorkbenchHttpError(409, 'RECOVERY_REQUIRED', 'Workspace admission is closed for maintenance');
    const validateOwnerArchive = (bound: ProductionArchiveOwner[], value: Parameters<WorkspaceArchiveWorkspacePort['validateArchive']>[0]) => {
        const referenced = new Map<string, { bytes: number; kind: string }>();
        for (const owner of bound) {
            const records = value.records.filter(record => record.moduleId === owner.moduleId);
            for (const file of owner.fileReferences(records)) {
                const key = 'files/' + file.sha256, previous = referenced.get(key);
                if (previous && previous.bytes !== file.bytes) throw fail();
                referenced.set(key, file);
                if (!value.files.has(key) && !(file.kind === 'original' && value.manifest.exclusions.includes('originals'))) throw fail();
                const bytes = value.files.get(key);
                if (bytes && (bytes.length !== file.bytes || archiveHash(bytes) !== file.sha256)) throw fail();
            }
            owner.validateArchive?.(value);
        }
        for (const file of value.manifest.files) if (!referenced.has(file.path)) throw fail();
    };
    const inRoot = (root: string, relative: string) => { if (!relative || relative.includes('\\') || relative.split('/').some(segment => !segment || segment === '.' || segment === '..') || path.isAbsolute(relative) || /[\x00-\x1f:]/.test(relative))
        throw fail(); const target = path.resolve(root, relative); if (!target.startsWith(path.resolve(root) + path.sep))
        throw fail(); return target; };
    const lifecycle: WorkspaceLifecycle = {
        async quiesce(operationId) {
            if (maintenanceOwner && maintenanceOwner !== operationId)
                throw fail();
            maintenanceOwner = operationId;
            closed = true;
            await pause();
            const coordinator = scope.getStore()?.commandId ?? null;
            for (let attempt = 0; attempt < 200; attempt++) {
                const pending = jobs?.recoveryCandidates(prepared.installationId).filter(row => row.snapshot.commandId !== coordinator && ['queued', 'running', 'retry_wait'].includes(row.snapshot.status)) ?? [];
                if (!pending.length && requests === 0)
                    return;
                await new Promise(resolve => setTimeout(resolve, 25));
            }
            throw new WorkbenchHttpError(409, 'WORKSPACE_BUSY', 'Other accepted work has not drained');
        },
        async resume() { maintenanceOwner = null; if (!frozen && !input.candidate) {
            closed = false;
            resume();
        } },
        async recover() { },
        async activate(staged) { await switchRoot(staged, true); },
    };
    const switchRoot = async (nextRoot: string, transfer: boolean) => {
        if (!closed)
            throw fail();
        const parent = path.join(prepared.runtimeRoot, 'subject');
        if (path.dirname(nextRoot) !== parent || !pointerSchema.shape.active.safeParse(path.basename(nextRoot)).success)
            throw fail();
        await assertPhysicalPath(nextRoot, true);
        if (nextRoot === active)
            return;
        const handoff = transfer ? captureLocalOperations(repository) : null;
        const next = open(nextRoot), previous = native, previousRoot = active;
        let rebound = false;
        try {
            if (handoff)
                restoreLocalOperations(next, handoff, clock);
            stable.rebind(next);
            rebound = true;
            native = next;
            active = nextRoot;
            rebuild();
            await durableWrite(prepared.runtimeRoot, 'active.json', JSON.stringify({ version: 1, active: path.basename(nextRoot) }));
            previous.close();
        }
        catch (error) {
            if (rebound) {
                stable.rebind(previous);
                native = previous;
                active = previousRoot;
                try {
                    // A durable write can fail after rename (for example directory sync).
                    // Repair disk admission before allowing the previous facade to resume.
                    await durableWrite(prepared.runtimeRoot, 'active.json', JSON.stringify({ version: 1, active: path.basename(previousRoot) }));
                    rebuild();
                } catch {
                    frozen = true;
                    closed = true;
                    throw fail();
                } finally { next.close(); }
            } else {
                next.close();
            }
            throw error;
        }
    };
    const workspace: WorkspaceArchiveWorkspacePort = {
        managedRoot: path.join(prepared.runtimeRoot, 'subject'), applicationVersion: input.applicationVersion, storageSchemaVersion: 1, requiredModuleIds: [], repositoryId: () => input.repositoryId, activeRoot: async () => active,
        omittedOriginals: () => owners.some(owner => owner.omittedOriginals?.(repository) === true),
        prepareLegacyRecords: (context, value) => prepareLegacySubjectRecords(value, { installationId: context.installationId, personId: context.ownAccess.personId }),
        async files(records) { const files = new Map<string, Awaited<ReturnType<ProductionArchiveOwner['files']>>[number]>(); for (const owner of owners)
            for (const file of await owner.files(repository, records.filter(r => r.moduleId === owner.moduleId))) {
                const prior = files.get(file.path);
                if (prior && archiveHash(prior.bytesValue) !== archiveHash(file.bytesValue))
                    throw fail();
                if (!prior || prior.kind === 'original' && file.kind !== 'original')
                    files.set(file.path, file);
            } return [...files.values()]; },
        validateArchive(value) { validateOwnerArchive(owners, value); },
        authorizeCompleteWorkspace(context, request) { for (const owner of owners) {
            owner.authorize(request.records.filter(r => r.moduleId === owner.moduleId), context.ownAccess.personId, context.installationId);
            if (request.incomingRecords)
                owner.authorize(request.incomingRecords.filter(r => r.moduleId === owner.moduleId), context.ownAccess.personId, context.installationId);
        } },
        restoreContext(stagedRoot, value, context) { return Object.freeze({ installationId: context.installationId, personId: context.ownAccess.personId, stagedRoot, originalsOmitted: value.manifest.exclusions.includes('originals'), files: new Map([...value.files].map(([key, bytes]) => [key, new Uint8Array(bytes)])), subjectPath: (namespace: 'evidence' | 'uploads' | 'publishing' | 'legacy', relative: string) => { if (!['evidence', 'uploads', 'publishing', 'legacy'].includes(namespace))
                throw fail(); return inRoot(path.join(stagedRoot, namespace), relative); } }); },
        async openStagedRepository(staged) { return open(staged); },
        stageBindings,
        async healthcheck() {
            const file = path.join(prepared.runtimeRoot, 'active.json');
            await assertPhysicalPath(file, false);
            const pointer = pointerSchema.parse(JSON.parse(await readFile(file, 'utf8')));
            if (path.join(prepared.runtimeRoot, 'subject', pointer.active) !== active) throw fail();
            repository.exportWorkspaceCore(); await snapshotWorkspace(archive);
        },
        async rollback(previous, expected) { const check = open(previous); try {
            const bindings = stageBindings(previous, check);
            const candidateWorkspace = { ...workspace, omittedOriginals: bindings.omittedOriginals, files: bindings.files, validateArchive: bindings.validateArchive };
            if ((await snapshotWorkspace({ ...archive, repository: check, modules: bindings.modules, workspace: candidateWorkspace })).revision !== expected)
                throw fail();
        }
        finally {
            check.close();
        } await switchRoot(previous, false); },
        async invalidateAdmission() { invalidate(); }, async freezeWrites() { frozen = true; closed = true; },
    };
    return { repository, environment, workspace, lifecycle, subjectRoot: () => active,
        admissionInvalidator(callback: () => void) { invalidate = callback; },
        background(callbacks: {
            pause: () => Promise<void>;
            resume: () => void;
        }) { pause = callbacks.pause; resume = callbacks.resume; },
        initialize(deps: ArchiveDependencies, jobStore: JobStore, indexRebuild: () => void) { archive = deps; jobs = jobStore; rebuild = indexRebuild; owners = [...createSubjectArchiveOwners(repository, environment), ...createSourceArchiveOwners(repository, environment)]; if (new Set(owners.map(o => o.moduleId)).size !== owners.length)
            throw Error('Duplicate archive owner'); (workspace.requiredModuleIds as string[]).push(...owners.map(o => o.moduleId)); return new Map(owners.map(o => [o.moduleId, o])); },
        withCoordinator<T>(context: Pick<MaintenanceContext, 'installationId'> & {
            commandId?: string;
        }, action: () => Promise<T>) { if (context.installationId !== prepared.installationId)
            throw fail(); return scope.run({ commandId: context.commandId ?? null }, action); },
        admit() { if (closed || frozen)
            throw new WorkbenchHttpError(503, 'WORKSPACE_MAINTENANCE', 'Workspace is not accepting requests'); requests++; let done = false; return () => { if (!done) {
            done = true;
            requests--;
        } }; },
        activate() { if (frozen)
            throw fail(); input.candidate = false; closed = false; },
        freeze() { closed = true; },
        async close() { closed = true; repository.close(); await prepared.releaseLease(); },
    };
}
