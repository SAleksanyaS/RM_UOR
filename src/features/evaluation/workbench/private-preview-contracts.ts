import { z } from 'zod';
import { calculationResultSchema, evaluationBasisSchema, coreGoalDefinitionSchema, goalAssignmentSchema, methodVersionSchema, observedFactSchema, metricDefinitionSchema } from '../../../domain/workbench/schemas';
export const privateCalculationPreviewSchema = z.strictObject({ basis: evaluationBasisSchema, result: calculationResultSchema, goal: coreGoalDefinitionSchema, assignment: goalAssignmentSchema, method: methodVersionSchema, facts: z.array(observedFactSchema), metrics: z.array(metricDefinitionSchema) });
export type PrivateCalculationPreview = z.infer<typeof privateCalculationPreviewSchema>;
import { versionRefSchema } from '../../../domain/workbench/primitives';
export const privateMethodConfigurationSchema = z.strictObject({ packageId: z.string().uuid(), assignmentRef: versionRefSchema.refine(ref => ref.entityType === 'goal_assignment'), goalRef: versionRefSchema.refine(ref => ref.entityType === 'core_goal_definition'), standaloneMethodRef: versionRefSchema.nullable(), method: methodVersionSchema, metrics: z.array(metricDefinitionSchema) });
export type PrivateMethodConfiguration = z.infer<typeof privateMethodConfigurationSchema>;
export type SourceMappingHints = {
    packageId: string;
    assignmentRef: z.infer<typeof versionRefSchema>;
    goalRef: z.infer<typeof versionRefSchema>;
    metrics: Array<{
        metricId: string;
        fields: string[];
    }>;
};
import { manualStatusEventSchema } from '../../../domain/workbench/schemas';
import { fieldProblemSchema } from '../../../server/workbench/protocol';
export const privateManualTipSchema = z.strictObject({ packageId: z.string().uuid(), assignmentRef: versionRefSchema, goalRef: versionRefSchema, tipRef: versionRefSchema.nullable(), event: manualStatusEventSchema.nullable(), status: z.enum(['ready', 'incomplete']), problems: z.array(fieldProblemSchema), pending: z.strictObject({ draftId: z.string().uuid(), ref: versionRefSchema, targetState: z.enum(['not_started', 'in_progress', 'completed']), reason: z.string().nullable(), resultDescription: z.string().nullable() }).nullable() });
export type PrivateManualTip = z.infer<typeof privateManualTipSchema>;
export const privateMethodReferenceSchema = z.strictObject({ kind: z.literal('reference'), packageId: z.string().uuid(), assignmentRef: versionRefSchema, standaloneMethodRef: versionRefSchema.nullable() });
export const privateMethodReadSchema = z.union([privateMethodConfigurationSchema, privateMethodReferenceSchema]);
