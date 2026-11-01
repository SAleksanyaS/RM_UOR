import { z } from 'zod';
import { privateCalculationPreviewSchema, privateMethodReadSchema } from './private-preview-contracts';
import { uuidSchema, versionRefSchema, type EntityRef, type Header, type VersionRef } from '../../../domain/workbench/primitives';
import { calculationResultSchema, evaluationBasisSchema, coreGoalDefinitionSchema, goalAssignmentSchema, methodVersionSchema, entityReferences, schemaForEntity, observedFactSchema, metricDefinitionSchema, methodBindingSchema, templateSchema } from '../../../domain/workbench/schemas';
import type { WorkbenchEntity, WorkbenchEntityType } from '../../../domain/workbench/entities';
import { validateReferences } from '../../../domain/workbench/schemas';
import { ownQueryRequestSchema, WorkbenchHttpError } from '../../../server/workbench/protocol';
import type { QueryRegistry } from '../../../server/workbench/query-registry';
import type { DraftService } from '../../catalog/workbench-drafts';
import { canUseCapability } from '../../identity/workbench-access-policy';
const filterSchema = z.strictObject({ packageId: uuidSchema, resultRef: versionRefSchema.refine(ref => ref.entityType === 'calculation_result'), editToken: z.string().min(1) });
const key = (ref: EntityRef | VersionRef) => `${ref.entityType}/${ref.id}/${'revision' in ref ? ref.revision : 'head'}`;
/** Own-package exact stored example. This query performs no calculation or writes. */
export function registerPrivateCalculationPreviewQuery(registry: QueryRegistry, drafts: DraftService): void {
    registerPrivateMethodQuery(registry, drafts);
    registry.register({
        name: 'calculation.preview', inputSchema: ownQueryRequestSchema.extend({ filter: filterSchema, sort: z.array(z.never()).max(0) }), outputSchema: privateCalculationPreviewSchema,
        async handler(context, { filter }) {
            if (!context.ownAccess.personId || !canUseCapability(context.ownAccess, 'uor.prepare'))
                throw new WorkbenchHttpError(403, 'ACCESS_DENIED', 'Пример черновика доступен его куратору');
            const pkg = drafts.readOwnPackage(context, filter.packageId);
            if (filter.editToken !== `draft:${pkg.packageId}:${pkg.revision}`)
                throw new WorkbenchHttpError(409, 'PREVIEW_STALE', 'Черновик изменился; выполните пример заново');
            const result = calculationResultSchema.parse(drafts.readPreparedForPackage(pkg.packageId, filter.resultRef));
            const basis = evaluationBasisSchema.parse(drafts.readPreparedForPackage(pkg.packageId, result.basisRef));
            const frozen = drafts.readDraftVersions(pkg.packageId), checked = new Map<string, Header>();
            const missing = (): never => { throw new WorkbenchHttpError(404, 'REFERENCE_NOT_FOUND', 'Точная редакция примера недоступна'); };
            const read = (ref: EntityRef | VersionRef): Header => {
                const seen = checked.get(key(ref));
                if (seen)
                    return seen;
                const local = pkg.entries.find(e => e.entityRef.entityType === ref.entityType && e.entityRef.id === ref.id);
                const version = 'revision' in ref ? ref.revision : local?.versionRef.revision;
                let value: Header | null = null;
                if (ref.entityType === 'evaluation_basis' && ref.id === basis.id && (!('revision' in ref) || ref.revision === basis.revision))
                    value = basis;
                else if (ref.entityType === 'calculation_result' && ref.id === result.id && (!('revision' in ref) || ref.revision === result.revision))
                    value = result;
                else
                    value = frozen.find(v => v.entityRef.entityType === ref.entityType && v.value.id === ref.id && v.value.revision === version)?.value ?? null;
                if (!value) {
                    value = 'revision' in ref ? context.repository.readVersion(ref) : context.repository.readPublishedHead(ref);
                    if (!value || value.publicationAnchorId === null || context.repository.readPublicationAnchor({ entityType: 'publication_anchor', id: value.publicationAnchorId })?.publicationState !== 'confirmed')
                        return missing();
                }
                schemaForEntity(ref.entityType).parse(value);
                checked.set(key(ref), value);
                validateReferences(entityReferences(ref.entityType as WorkbenchEntityType, value as WorkbenchEntity).filter(r => r.ref.entityType !== 'publication_anchor'), read);
                return value;
            };
            // A saved example may not be presented as the current draft after its bound
            // goal, assignment, method or template has moved to another local edition.
            for (const ref of [basis.assignmentRef, basis.goalRef, basis.methodRef, ...(basis.templateRef ? [basis.templateRef] : [])]) {
                const current = pkg.entries.find(e => e.entityRef.entityType === ref.entityType && e.entityRef.id === ref.id);
                if (current && current.versionRef.revision !== ref.revision)
                    throw new WorkbenchHttpError(409, 'PREVIEW_STALE', 'Основание примера изменилось');
            }
            read(filter.resultRef);
            const method = methodVersionSchema.parse(read(basis.methodRef));
            return { basis, result, facts: basis.factRefs.map(ref => observedFactSchema.parse(read(ref))), metrics: method.mode === 'numeric' ? method.rules.map(rule => metricDefinitionSchema.parse(read(rule.metricRef))) : [], goal: coreGoalDefinitionSchema.parse(read(basis.goalRef)), assignment: goalAssignmentSchema.parse(read(basis.assignmentRef)), method };
        }
    });
}
function registerPrivateMethodQuery(registry: QueryRegistry, drafts: DraftService): void {
    registry.register({ name: 'calculation.method', inputSchema: ownQueryRequestSchema.extend({ filter: z.strictObject({ packageId: uuidSchema, assignmentRef: versionRefSchema.refine(ref => ref.entityType === 'goal_assignment'), editToken: z.string().min(1), referenceOnly: z.boolean().optional() }), sort: z.array(z.never()).max(0) }), outputSchema: privateMethodReadSchema, async handler(context, { filter }) {
            if (!context.ownAccess.personId || !canUseCapability(context.ownAccess, 'uor.prepare'))
                throw new WorkbenchHttpError(403, 'ACCESS_DENIED', 'Методика черновика доступна его куратору');
            const pkg = drafts.readOwnPackage(context, filter.packageId);
            if (filter.editToken !== `draft:${pkg.packageId}:${pkg.revision}`)
                throw new WorkbenchHttpError(409, 'PREVIEW_STALE', 'Пакет изменился');
            const assignment = pkg.entries.find(entry => entry.entityRef.entityType === 'goal_assignment' && entry.entityRef.id === filter.assignmentRef.id);
            if (!assignment)
                throw new WorkbenchHttpError(404, 'REFERENCE_NOT_FOUND', 'Назначение отсутствует в своём пакете');
            if (assignment.versionRef.revision !== filter.assignmentRef.revision)
                throw new WorkbenchHttpError(409, 'PREVIEW_STALE', 'Редакция назначения изменилась');
            const standaloneMethodRef = drafts.readOwnStandaloneMethodRef(context, filter);
            if (filter.referenceOnly)
                return { kind: 'reference' as const, packageId: pkg.packageId, assignmentRef: assignment!.versionRef, standaloneMethodRef };
            const parsed = z.strictObject({ goalId: uuidSchema, methodBinding: methodBindingSchema }).safeParse({ goalId: assignment.definition.goalId, methodBinding: assignment.definition.methodBinding });
            if (!parsed.success)
                throw new WorkbenchHttpError(422, 'METHOD_BINDING_INCOMPLETE', 'Выберите действующий шаблон или самостоятельную методику');
            const frozen = drafts.readDraftVersions(pkg.packageId);
            const read = (ref: EntityRef | VersionRef): Header => {
                const local = pkg.entries.find(e => e.entityRef.entityType === ref.entityType && e.entityRef.id === ref.id);
                const revision = 'revision' in ref ? ref.revision : local?.versionRef.revision;
                let value = frozen.find(e => e.entityRef.entityType === ref.entityType && e.value.id === ref.id && e.value.revision === revision)?.value ?? null;
                if (!value && local && (!('revision' in ref) || local.versionRef.revision === ref.revision)) {
                    const full = schemaForEntity(ref.entityType).safeParse({ ...local.header, ...local.definition });
                    if (!full.success)
                        throw new WorkbenchHttpError(422, 'METHOD_CONFIGURATION_INCOMPLETE', 'Завершите поля методики');
                    value = full.data as Header;
                }
                if (!value) {
                    value = 'revision' in ref ? context.repository.readVersion(ref) : context.repository.readPublishedHead(ref);
                    if (!value || !value.publicationAnchorId || context.repository.readPublicationAnchor({ entityType: 'publication_anchor', id: value.publicationAnchorId })?.publicationState !== 'confirmed')
                        throw new WorkbenchHttpError(404, 'REFERENCE_NOT_FOUND', 'Точная редакция методики недоступна');
                }
                return value;
            };
            const ownGoal = pkg.entries.find(e => e.entityRef.entityType === 'core_goal_definition' && e.entityRef.id === parsed.data.goalId);
            const goalRef = ownGoal?.versionRef ?? (() => { const goal = coreGoalDefinitionSchema.parse(read({ entityType: 'core_goal_definition', id: parsed.data.goalId })); return { entityType: 'core_goal_definition', id: goal.id, revision: goal.revision }; })();
            const binding = parsed.data.methodBinding;
            const methodRef = binding.kind === 'standalone' ? binding.methodRef : templateSchema.parse(read({ entityType: 'template', id: binding.templateId })).methodRef;
            const method = methodVersionSchema.parse(read(methodRef));
            const metrics = method.mode === 'numeric' ? method.rules.map(rule => metricDefinitionSchema.parse(read(rule.metricRef))) : [];
            validateReferences(entityReferences('method_version', method).filter(r => r.ref.entityType !== 'publication_anchor'), read);
            return { packageId: pkg.packageId, assignmentRef: assignment.versionRef, goalRef, standaloneMethodRef, method, metrics };
        } });
}
