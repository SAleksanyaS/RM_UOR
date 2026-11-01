import type { EntityRef } from '../../../domain/workbench/primitives';
import type { AnyQueryRequest, CommandResult, ApiSuccess, GlobalContext } from '../../../server/workbench/protocol';
import type { WorkbenchClient } from '../../../app/workbench/api-client';
import type { WorkbenchReadModels } from '../../catalog/workbench-read-models';
import type { DraftOpenResult } from '../../catalog/workbench-drafts';
import { privateManualTipSchema, privateMethodReferenceSchema } from '../../evaluation/workbench/private-preview-contracts';
import { WorkbenchApiError } from '../../../app/workbench/api-client';
import { object, text } from './setup-fields';
export type PackageForm = WorkbenchReadModels['uor.package'];
export type Entry = PackageForm['entries'][number];
export type DraftChoice = {
    packageId: string;
    goalId: string;
    label: string;
};
export class SetupDraftChoiceError extends Error {
    constructor(readonly choices: DraftChoice[]) { super('Выберите свой черновик цели'); }
}
export type SetupSession = {
    pkg: PackageForm;
    goal: Entry;
    source: Entry;
    assignment: Entry;
    method: Entry | null;
    metrics: Entry[];
    standaloneAssociated?: boolean;
    na?: Entry;
    manualRef: EntityRef & {
        revision: number;
    };
    manualState: string | null;
    manualPending?: import('../../catalog/workbench-drafts').PendingManualTransition | null;
    manualTipReady: boolean;
    manualProblems: import('../../../server/workbench/protocol').FieldProblem[];
    context: GlobalContext;
    entities: WorkbenchReadModels['context.options']['entities'];
};
export const request = (filter: Record<string, unknown> = {}, context: GlobalContext | null = null, cursor: string | null = null): AnyQueryRequest => ({ context, filter, sort: [], page: { limit: 200, cursor } });
export async function command<R>(client: WorkbenchClient, name: string, payload: Record<string, unknown>, token: string | null) {
    const response = await client.command<Omit<CommandResult, 'result'> & {
        result: R;
    }>({ commandId: crypto.randomUUID(), name, payload, baseRevision: token });
    if ('jobId' in response.data)
        throw Error('Ожидался синхронный ответ');
    return response.data;
}
export async function readPackage(client: WorkbenchClient, id: string, context: GlobalContext) { return (await client.query<PackageForm>('uor.package', request({ packageRef: { entityType: 'publication_package', id } }, context))).data; }
async function ownPackages(client: WorkbenchClient, context: GlobalContext) {
    const result: PackageForm[] = [];
    let cursor: string | null = null;
    do {
        const page: ApiSuccess<WorkbenchReadModels['uor.queue']> = await client.query<WorkbenchReadModels['uor.queue']>('uor.queue', request({}, context, cursor));
        for (const summary of page.data.items)
            result.push(await readPackage(client, summary.packageRef.id, context));
        cursor = page.data.page.nextCursor;
    } while (cursor);
    return result;
}
const pending = new WeakMap<WorkbenchClient, Map<string, Promise<SetupSession>>>();
const remembered = new WeakMap<WorkbenchClient, Map<string, string>>();
/** Deduplicate an in-flight open, including StrictMode. Settled drafts are always read again. */
export function loadSetup(client: WorkbenchClient, owner: string, goalRef: EntityRef | undefined, context: GlobalContext | null, choice?: DraftChoice, suppliedPackage?: EntityRef): Promise<SetupSession> {
    const memoryKey = owner + ':' + (goalRef?.id ?? 'new') + ':' + (suppliedPackage?.id ?? ''), key = memoryKey + ':' + (choice?.packageId ?? '');
    let cache = pending.get(client);
    if (!cache) {
        cache = new Map();
        pending.set(client, cache);
    }
    const existing = cache.get(key);
    if (existing)
        return existing;
    const work = (async () => {
        if (!context)
            throw Error('Получите опубликованный каталог и выберите область перед настройкой цели');
        const candidates = suppliedPackage ? [await readPackage(client, suppliedPackage.id, context)] : await ownPackages(client, context);
        const packages = candidates.filter(p => !['merged', 'declined', 'publishing', 'validating'].includes(p.summary.publication?.state ?? 'draft'));
        if (suppliedPackage && !packages.length)
            throw Error('Пакет закрыт или занят публикацией. Выберите открытый собственный пакет.');
        let selected = choice?.goalId ?? goalRef?.id ?? (suppliedPackage ? undefined : remembered.get(client)?.get(memoryKey));
        const matches = packages.flatMap(p => p.entries.filter(e => e.entityRef.entityType === 'core_goal_definition' && (selected ? e.entityRef.id === selected : !suppliedPackage && e.baseRef === null)).map(e => ({ pkg: p, goal: e })));
        if (matches.length > 1 && !choice)
            throw new SetupDraftChoiceError(matches.map(m => ({ packageId: m.pkg.summary.packageRef.id, goalId: m.goal.entityRef.id, label: (text(m.goal.definition.title) || 'Незавершённая цель') + ' · пакет, редакция ' + m.pkg.summary.revision })));
        const match = choice ? matches.find(m => m.pkg.summary.packageRef.id === choice.packageId) : matches[0];
        let pkg = match?.pkg ?? (suppliedPackage ? packages[0] : undefined);
        if (match)
            selected = match.goal.entityRef.id;
        if (!match) {
            const opened = await command<DraftOpenResult>(client, 'draft.open', { entityType: 'core_goal_definition', ref: goalRef ?? null, packageId: pkg?.summary.packageRef.id ?? null }, pkg?.summary.editToken ?? null);
            selected = opened.result.objectId;
            pkg = pkg ? await readPackage(client, pkg.summary.packageRef.id, context) : (await ownPackages(client, context)).find(p => p.entries.some(e => e.draftId === opened.result.draftId));
            if (!pkg)
                throw Error('Созданный черновик отсутствует в своём пакете');
        }
        if (!pkg)
            throw Error('Собственный пакет не найден');
        let goal = pkg.entries.find(e => e.entityRef.entityType === 'core_goal_definition' && (!selected || e.entityRef.id === selected))!;
        let memory = remembered.get(client);
        if (!memory) {
            memory = new Map();
            remembered.set(client, memory);
        }
        memory.set(memoryKey, goal.entityRef.id);
        const saveIdentity = async (entry: Entry, definition: Record<string, unknown>, commandName: string) => { await command<import('../../catalog/workbench-drafts').DraftSaveResult>(client, commandName, { draftId: entry.draftId, definition }, pkg!.summary.editToken); pkg = await readPackage(client, pkg!.summary.packageRef.id, context); return pkg.entries.find(e => e.draftId === entry.draftId)!; };
        const ensure = async (type: string, ref: EntityRef | null) => {
            const existing = pkg!.entries.filter(e => e.entityRef.entityType === type && (ref ? e.entityRef.id === ref.id : e.definition.goalId === goal.entityRef.id));
            if (existing.length > 1)
                throw Error('У цели несколько черновиков назначения. Выберите точную область перед настройкой.');
            if (existing[0])
                return existing[0];
            const opened = await command<DraftOpenResult>(client, 'draft.open', { entityType: type, ref, packageId: pkg!.summary.packageRef.id }, pkg!.summary.editToken);
            pkg = await readPackage(client, pkg!.summary.packageRef.id, context);
            const entry = pkg.entries.find(e => e.draftId === opened.result.draftId)!;
            return !ref && ['source_definition', 'goal_assignment'].includes(type) ? saveIdentity(entry, { ...entry.definition, goalId: goal.entityRef.id }, type === 'source_definition' ? 'source.draft.save' : 'assignment.draft.save') : entry;
        };
        const source = await ensure('source_definition', goal.definition.sourceId ? { entityType: 'source_definition', id: text(goal.definition.sourceId) } : null);
        if (goal.definition.sourceId !== source.entityRef.id)
            goal = await saveIdentity(goal, { ...goal.definition, sourceId: source.entityRef.id }, 'goal.draft.save');
        let publishedAssignment: WorkbenchReadModels['goals.detail']['rows'][number] | undefined;
        if (goalRef && context && goal.baseRef !== null) {
            const detail = await client.query<WorkbenchReadModels['goals.detail']>('goals.detail', request({}, { ...context, goalId: goalRef.id, resultMode: 'current', snapshotId: null }));
            const selectedScopeId = context.scopePath.teamId ?? context.scopePath.productId ?? context.scopePath.clusterId ?? context.scopePath.ditId;
            publishedAssignment = detail.data.rows.find(row => row.assignment.scope.id === selectedScopeId) ?? (detail.data.rows.length === 1 ? detail.data.rows[0] : undefined);
        }
        const assignment = await ensure('goal_assignment', publishedAssignment ? { entityType: 'goal_assignment', id: publishedAssignment.assignment.id } : null);
        const binding = object(assignment.definition.methodBinding);
        let methodRef = object(binding.methodRef);
        if (binding.kind === 'template') {
            const response = await client.query('calculation.method', request({ packageId: pkg!.summary.packageRef.id, assignmentRef: assignment.versionRef, editToken: pkg!.summary.editToken, referenceOnly: true }));
            methodRef = object(privateMethodReferenceSchema.parse(response.data).standaloneMethodRef);
        }
        const method = methodRef.id ? await ensure('method_version', { entityType: 'method_version', id: text(methodRef.id) }) : null;
        const metrics: Entry[] = [];
        for (const rule of Array.isArray(method?.definition.rules) ? method!.definition.rules as unknown[] : []) {
            const ref = object(object(rule).metricRef);
            if (ref.id)
                metrics.push(await ensure('metric_definition', { entityType: 'metric_definition', id: text(ref.id) }));
        }
        const entities = (await client.query<WorkbenchReadModels['context.options']>('context.options', request({}, context))).data.entities;
        goal = pkg!.entries.find(e => e.draftId === goal.draftId)!;
        // Reserved IDs link partial definitions within this one explicit package.
        goal.definition = { ...goal.definition, sourceId: source.entityRef.id };
        source.definition = { ...source.definition, goalId: goal.entityRef.id };
        assignment.definition = { ...assignment.definition, goalId: goal.entityRef.id };
        if (!assignment.definition.methodBinding && method)
            assignment.definition.methodBinding = { kind: 'standalone', methodRef: method.versionRef };
        for (const entry of [goal, source, assignment, ...(method ? [method] : []), ...metrics])
            await client.query('forms.describe', request({ formKind: entry.entityRef.entityType, ref: entry.entityRef, packageRef: pkg!.summary.packageRef }, context));
        let manualPending: SetupSession['manualPending'] = null;
        let manual = publishedAssignment?.manualStatus;
        let manualTipReady = true;
        let manualProblems: import('../../../server/workbench/protocol').FieldProblem[] = [];
        let manualRef: EntityRef & {
            revision: number;
        } = manual ? { entityType: 'manual_status_event', id: manual.id, revision: manual.revision } : assignment.versionRef;
        if (goal.definition.mode === 'manual_status' && assignment.complete) {
            try {
                const response = await client.query('manual.tip', request({ packageId: pkg!.summary.packageRef.id, assignmentRef: assignment.versionRef, editToken: pkg!.summary.editToken }));
                const tip = privateManualTipSchema.parse(response.data);
                manualPending = tip.pending;
                manualTipReady = tip.status === 'ready';
                manualProblems = tip.problems;
                manual = tip.event ?? undefined;
                manualRef = tip.tipRef ?? assignment.versionRef;
            }
            catch (error) {
                if (!(error instanceof WorkbenchApiError) || error.status !== 422)
                    throw error;
                manualTipReady = false;
                manualProblems = error.problem.details.length ? error.problem.details : [{ path: '/manualStatus', code: error.problem.code, message: error.problem.message, ref: assignment.entityRef }];
            }
        }
        return { context, pkg: pkg!, goal, source, assignment, method, metrics, standaloneAssociated: !!method, na: pkg!.entries.find(e => e.entityRef.entityType === 'applicability' && e.definition.assignmentId === assignment.entityRef.id), manualRef, manualPending, manualTipReady, manualProblems, manualState: manual?.to ?? null, entities };
    })();
    cache.set(key, work);
    void work.finally(() => {
        if (cache!.get(key) === work)
            cache!.delete(key);
    }).catch(() => undefined);
    return work;
}
