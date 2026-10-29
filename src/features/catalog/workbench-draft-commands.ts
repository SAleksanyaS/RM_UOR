import { z } from 'zod';
import { businessTimeSchema, decimalSchema, entityRefSchema, uuidSchema, versionRefSchema } from '../../domain/workbench/primitives';
import { idsSchema, refsSchema, textSchema } from '../../domain/workbench/schemas';
import type { CommandContext, CommandOutcome, CommandRegistry } from '../../server/workbench/command-registry';
import { createCommandStore } from '../../server/workbench/command-store';
import { fieldProblemSchema } from '../../server/workbench/protocol';
import { WorkbenchHttpError } from '../../server/workbench/protocol';
import { WorkbenchError } from '../../domain/workbench/errors';
import { draftDefinitionSchema, draftEntityTypes, type DraftService, type DraftSaveInput } from './workbench-drafts';

const typedRef = (type: string) => versionRefSchema.refine(ref => ref.entityType === type);
export const draftOpenInputSchema = z.strictObject({ entityType: z.enum(draftEntityTypes), ref: entityRefSchema.nullable(), packageId: uuidSchema.nullable() });
export const draftOpenResultSchema = z.strictObject({ draftId: uuidSchema, objectId: uuidSchema, entityRef: entityRefSchema, editToken: z.string().min(1) });
export const draftSaveResultSchema = z.strictObject({ draftId: uuidSchema, entityRef: entityRefSchema, versionRef: versionRefSchema, complete: z.boolean(), problems: z.array(fieldProblemSchema) });
export const calculationPrepareInputSchema = z.strictObject({ assignmentRef: typedRef('goal_assignment'), businessTime: z.union([businessTimeSchema.options[0], businessTimeSchema.options[1]]) });
export const calculationPrepareResultSchema = z.strictObject({ basisRef: typedRef('evaluation_basis'), resultRef: typedRef('calculation_result').nullable() });
export function registerDraftCommands(registry: CommandRegistry, service: DraftService): void {
  const bind = <I, O>(name: string, input: z.ZodType<I>, output: z.ZodType<O>, action: (context: CommandContext, input: I) => Promise<O>, calculation = false) => {
    registry.register({ name, inputSchema: input, outputSchema: output, capability: calculation ? 'calculation.local' : 'uor.prepare', execution: 'sync', effect: calculation ? 'local' : 'sharedDraft', ownership: calculation ? 'person-if-present' : 'person', async handler(context, payload) {
      try { await action(context, payload); }
      catch (error) { if (error instanceof WorkbenchError) throw new WorkbenchHttpError(['REFERENCE_NOT_FOUND','BROKEN_REFERENCE'].includes(error.code) ? 404 : ['REVISION_CONFLICT','REFERENCE_NOT_PUBLISHED','DRAFT_REFERENCE_AMBIGUOUS'].includes(error.code) ? 409 : 422, error.code, 'Business validation failed'); throw error; }
      const receipt = createCommandStore(context.repository).get(context.installationId, context.commandId)?.receipt_json;
      if (!receipt) throw Error('Draft effect did not commit its atomic receipt');
      return JSON.parse(receipt) as CommandOutcome<O>;
    } });
  };
  bind('draft.open', draftOpenInputSchema, draftOpenResultSchema, service.open);
  const definitions: Array<[string, string[]]> = [['goal',['core_goal_definition']],['assignment',['goal_assignment']],['method',['method_version']],['metric',['metric_definition']],['template',['template']],['source',['source_definition']],['fieldMapping',['source_field_mapping']],['na',['applicability']],['organization',['directory_entity','directory_link']]];
  for (const [name, types] of definitions) {
    const schemas = types.map(type => draftDefinitionSchema(type));
    const definition = schemas.length === 1 ? schemas[0] : z.union(schemas);
    const input = z.strictObject({ draftId: uuidSchema, definition });
    bind(name + '.draft.save', input, draftSaveResultSchema, (context, payload) => service.saveDefinition(context, payload as DraftSaveInput, types));
  }
  bind('calculation.prepare', calculationPrepareInputSchema, calculationPrepareResultSchema, service.prepare, true);
  bind('organization.team.propose', z.strictObject({ teamDraftId: uuidSchema, clusterRef: entityRefSchema.refine(ref => ref.entityType === 'directory_entity'), teamTemplateBindings: z.array(z.strictObject({ goalId: uuidSchema, templateId: uuidSchema })) }), z.strictObject({ draftIds: z.array(uuidSchema), assignmentRefs: z.array(entityRefSchema), pendingLinkRefs: z.array(entityRefSchema) }), service.proposeTeam);
  bind('comment.draft.save', z.strictObject({ draftId: uuidSchema, targetRef: entityRefSchema, text: textSchema }), draftSaveResultSchema, service.saveComment);
  bind('evidence.draft.save', z.discriminatedUnion('kind', [z.strictObject({ draftId: uuidSchema, kind: z.literal('file'), fileHandle: uuidSchema }), z.strictObject({ draftId: uuidSchema, kind: z.literal('url'), url: z.string().min(1) })]), draftSaveResultSchema, service.saveEvidence);
  bind('fact.correct', z.strictObject({ draftId: uuidSchema, factKey: textSchema, originalFactRefs: refsSchema('observed_fact').min(1), replacement: decimalSchema, reason: textSchema }), draftSaveResultSchema, service.correct);
  bind('result.confirm', z.strictObject({ draftId: uuidSchema, resultRef: typedRef('calculation_result'), comment: textSchema, evidenceIds: idsSchema }), draftSaveResultSchema, service.confirm);
  bind('snapshot.save', z.strictObject({ draftId: uuidSchema, basisRef: typedRef('evaluation_basis'), resultRef: typedRef('calculation_result').nullable(), manualStatusRef: typedRef('manual_status_event').nullable(), attestationRef: typedRef('attestation').nullable() }).refine(value => (value.resultRef === null) !== (value.manualStatusRef === null)), draftSaveResultSchema, service.snapshot);
  bind('manualGoal.transition', z.strictObject({ draftId: uuidSchema, ref: versionRefSchema.refine(ref => ['goal_assignment','manual_status_event'].includes(ref.entityType)), targetState: z.enum(['not_started','in_progress','completed']), reason: textSchema.nullable(), resultDescription: textSchema.nullable() }), draftSaveResultSchema, service.transition);
  for (const name of ['archive','restore']) bind('goal.' + name, z.strictObject({ draftId: uuidSchema, goalRef: typedRef('core_goal_definition'), reason: textSchema }), draftSaveResultSchema, (context, input) => service.archive(context, input, name === 'restore'));
}
