import { z } from 'zod';
import type { EntityRef, Header, VersionRef } from './primitives';
import type { WorkbenchEntity, WorkbenchEntityMap, WorkbenchEntityType } from './entities';
import { WorkbenchError } from './errors';
import * as core from './schemas/core';
import * as sources from './schemas/sources';
import * as states from './schemas/states';
import * as extensions from './schemas/extensions';
import * as evaluation from './schemas/evaluation';

export * from './schemas/core';
export * from './schemas/sources';
export * from './schemas/states';
export * from './schemas/extensions';
export * from './schemas/evaluation';

export const entitySchemas: ReadonlyMap<WorkbenchEntityType, z.ZodType<Header>> = new Map<WorkbenchEntityType, z.ZodType<Header>>([
  ['core_goal_definition', core.coreGoalDefinitionSchema], ['goal_assignment', core.goalAssignmentSchema], ['template', core.templateSchema],
  ['metric_definition', core.metricDefinitionSchema], ['method_version', core.methodVersionSchema], ['directory_entity', core.directoryEntitySchema], ['directory_link', core.directoryLinkSchema],
  ['source_field_mapping', sources.sourceFieldMappingSchema], ['source_definition', sources.sourceDefinitionSchema], ['capture', sources.captureSchema], ['observed_fact', sources.observedFactSchema],
  ['applicability', states.applicabilitySchema], ['manual_correction', states.manualCorrectionSchema], ['manual_status_event', states.manualStatusEventSchema],
  ['work', states.workSchema], ['work_dependency', states.workDependencySchema], ['decision', states.decisionSchema],
  ['custom_field_def', extensions.customFieldDefSchema], ['custom_field_value', extensions.customFieldValueSchema], ['commentary', extensions.commentarySchema], ['evidence', extensions.evidenceSchema], ['dashboard_def', extensions.dashboardDefSchema],
  ['business_calendar', extensions.businessCalendarSchema], ['reminder_settings', extensions.reminderSettingsSchema],
  ['evaluation_basis', evaluation.evaluationBasisSchema], ['calculation_result', evaluation.calculationResultSchema], ['attestation', evaluation.attestationSchema], ['agreed_snapshot', evaluation.agreedSnapshotSchema],
]);
export function schemaForEntity(type: string): z.ZodType<Header> {
  const schema = entitySchemas.get(type as WorkbenchEntityType);
  if (!schema) throw new WorkbenchError('UNKNOWN_ENTITY_TYPE', { entityType: type });
  return schema;
}
export function parseEntity<K extends WorkbenchEntityType>(type: K, input: unknown): WorkbenchEntityMap[K] {
  return schemaForEntity(type).parse(input) as WorkbenchEntityMap[K];
}

export type ReferenceRequirement = { ref: EntityRef | VersionRef; expectedEntityTypes: string[]; validateTarget?: (target: unknown) => void };

/** References are declared by their owning entity; arbitrary nested JSON is never interpreted as a reference. */
export function entityReferences(type: WorkbenchEntityType, value: WorkbenchEntity): ReferenceRequirement[] {
  const result: ReferenceRequirement[] = [];
  const add = (ref: EntityRef | VersionRef, expectedEntityTypes: string[] = [ref.entityType], validateTarget?: (target: unknown) => void) => { result.push({ ref, expectedEntityTypes, validateTarget }); };
  const id = (entityType: string, id: string, check?: (target: unknown) => void) => add({ entityType, id }, [entityType], check);
  const directory = (idValue: string, kind: string) => id('directory_entity', idValue, target => {
    if (core.directoryEntitySchema.parse(target).kind !== kind) throw new WorkbenchError('REFERENCE_SCOPE_MISMATCH', { id: idValue, kind });
  });
  const refs = (values: VersionRef[], entityType: string) => values.forEach(ref => add(ref, [entityType]));
  const ids = (values: string[], entityType: string) => values.forEach(v => id(entityType, v));
  if (value.publicationAnchorId !== null) id('publication_anchor', value.publicationAnchorId);
  // Actor identity is an installation-local attribution; it need not be a public directory person.
  switch (type) {
    case 'core_goal_definition': {
      const v = value as WorkbenchEntityMap['core_goal_definition']; id('source_definition', v.sourceId, target => {
        const source = sources.sourceDefinitionSchema.parse(target);
        if (source.goalId !== v.id || (source.kind === 'manual_status') !== (v.mode === 'manual_status')) throw new WorkbenchError('GOAL_SOURCE_MISMATCH');
      }); directory(v.primaryCuratorPersonId, 'person'); v.coCuratorPersonIds.forEach(person => directory(person, 'person')); break;
    }
    case 'goal_assignment': {
      const v = value as WorkbenchEntityMap['goal_assignment']; id('core_goal_definition', v.goalId, target => {
        const goal = core.coreGoalDefinitionSchema.parse(target);
        if ((goal.mode === 'numeric') !== (v.expectedPopulation !== null)) throw new WorkbenchError('ASSIGNMENT_POPULATION_MISMATCH');
      }); directory(v.scope.id, v.scope.kind);
      if (v.methodBinding.kind === 'template') id('template', v.methodBinding.templateId); else add(v.methodBinding.methodRef, ['method_version']);
      v.expectedPopulation?.forEach(scope => directory(scope.id, scope.kind)); break;
    }
    case 'template': add((value as WorkbenchEntityMap['template']).methodRef, ['method_version']); break;
    case 'method_version': {
      const v = value as WorkbenchEntityMap['method_version']; if (v.mode === 'numeric') v.rules.forEach(rule => add(rule.metricRef, ['metric_definition'])); break;
    }
    case 'directory_entity': (value as WorkbenchEntityMap['directory_entity']).externalKeys.forEach(key => id('source_definition', key.sourceId)); break;
    case 'directory_link': {
      const v = value as WorkbenchEntityMap['directory_link']; if (v.kind === 'leader') { id('directory_entity', v.scope.id); id('directory_entity', v.personId); } else { add(v.from, ['directory_entity']); add(v.to, ['directory_entity']); } break;
    }
    case 'source_field_mapping': {
      const v = value as WorkbenchEntityMap['source_field_mapping']; id('source_definition', v.sourceId); v.metricFields.forEach(field => id('metric_definition', field.metricId)); if (v.fixedScope) id('directory_entity', v.fixedScope.id); break;
    }
    case 'source_definition': {
      const v = value as WorkbenchEntityMap['source_definition']; id('core_goal_definition', v.goalId, target => {
        const goal = core.coreGoalDefinitionSchema.parse(target);
        if (goal.sourceId !== v.id || (v.kind === 'manual_status') !== (goal.mode === 'manual_status')) throw new WorkbenchError('GOAL_SOURCE_MISMATCH');
      }); if (v.mappingRef) add(v.mappingRef, ['source_field_mapping']); if (v.browserScenarioRef) add(v.browserScenarioRef, ['browser_scenario']); break;
    }
    case 'capture': {
      const v = value as WorkbenchEntityMap['capture']; id('source_definition', v.sourceId); add(v.mappingRef, ['source_field_mapping']); break;
    }
    case 'observed_fact': {
      const v = value as WorkbenchEntityMap['observed_fact']; id('source_definition', v.sourceId); id('capture', v.captureId); id('metric_definition', v.metricId); id('directory_entity', v.scope.id); add(v.lineage.mappingRef, ['source_field_mapping']); refs(v.lineage.directoryLinkRefs, 'directory_link'); refs(v.lineage.inputFactRefs, 'observed_fact'); if (v.lineage.reducerMethodRef) add(v.lineage.reducerMethodRef, ['method_version']); break;
    }
    case 'applicability': {
      const v = value as WorkbenchEntityMap['applicability']; id('goal_assignment', v.assignmentId); id('metric_definition', v.metricId); break;
    }
    case 'manual_correction': refs((value as WorkbenchEntityMap['manual_correction']).originalFactRefs, 'observed_fact'); break;
    case 'manual_status_event': {
      const v = value as WorkbenchEntityMap['manual_status_event']; id('goal_assignment', v.assignmentId); ids(v.evidenceIds, 'evidence'); break;
    }
    case 'work': {
      const v = value as WorkbenchEntityMap['work']; ids(v.goalIds, 'core_goal_definition'); ids(v.evidenceIds, 'evidence'); v.responsibility.forEach(r => { id('directory_entity', r.scope.id); id('directory_entity', r.personId); }); break;
    }
    case 'work_dependency': {
      const v = value as WorkbenchEntityMap['work_dependency']; id('work', v.predecessorWorkId); id('work', v.successorWorkId); break;
    }
    case 'decision': {
      const v = value as WorkbenchEntityMap['decision']; id('work', v.workId); id('directory_entity', v.requestedFromPersonId); break;
    }
    case 'custom_field_value': {
      const v = value as WorkbenchEntityMap['custom_field_value']; add(v.objectRef); add(v.fieldRef, ['custom_field_def'], target => extensions.validateCustomFieldValue(v, extensions.customFieldDefSchema.parse(target))); break;
    }
    case 'commentary': add((value as WorkbenchEntityMap['commentary']).targetRef); break;
    case 'reminder_settings': id('business_calendar', (value as WorkbenchEntityMap['reminder_settings']).calendarId); break;
    case 'evaluation_basis': {
      const v = value as WorkbenchEntityMap['evaluation_basis']; add(v.assignmentRef, ['goal_assignment']); add(v.goalRef, ['core_goal_definition']); add(v.methodRef, ['method_version']); if (v.templateRef) add(v.templateRef, ['template']); v.expectedPopulation?.forEach(scope => id('directory_entity', scope.id)); refs(v.factRefs, 'observed_fact'); refs(v.correctionRefs, 'manual_correction'); refs(v.applicabilityRefs, 'applicability'); refs(v.directoryLinkRefs, 'directory_link'); break;
    }
    case 'calculation_result': add((value as WorkbenchEntityMap['calculation_result']).basisRef, ['evaluation_basis']); break;
    case 'attestation': ids((value as WorkbenchEntityMap['attestation']).evidenceIds, 'evidence'); break;
    case 'agreed_snapshot': {
      const v = value as WorkbenchEntityMap['agreed_snapshot']; add(v.basisRef, ['evaluation_basis']); if (v.numericResult) add(v.numericResult.basisRef, ['evaluation_basis']); if (v.manualStatusRef) add(v.manualStatusRef, ['manual_status_event']); if (v.attestationRef) add(v.attestationRef, ['attestation']); break;
    }
    case 'metric_definition': case 'custom_field_def': case 'evidence': case 'dashboard_def': case 'business_calendar': break;
    default: { const never: never = type; throw new WorkbenchError('UNKNOWN_ENTITY_TYPE', { type: never }); }
  }
  return result;
}

export function validateReferences(requirements: ReferenceRequirement[], resolve: (ref: EntityRef | VersionRef) => unknown | null): void {
  for (const { ref, expectedEntityTypes, validateTarget } of requirements) {
    if (!expectedEntityTypes.includes(ref.entityType)) throw new WorkbenchError('REFERENCE_TYPE_MISMATCH', { ref, expectedEntityTypes });
    const value = resolve(ref);
    if (value === null || value === undefined) throw new WorkbenchError('REFERENCE_NOT_FOUND', { ref });
    const parsed = ref.entityType === 'publication_anchor' ? core.publicationAnchorSchema.parse(value) : schemaForEntity(ref.entityType).parse(value);
    if (parsed.id !== ref.id || ('revision' in ref && parsed.revision !== ref.revision)) throw new WorkbenchError('REFERENCE_VERSION_MISMATCH', { ref });
    validateTarget?.(parsed);
  }
}
