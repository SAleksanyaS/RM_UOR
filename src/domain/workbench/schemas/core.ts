import { z } from 'zod';
import { add, compare } from '../exact-number';
import { actorRefSchema, decimalSchema, entityRefSchema, headerShape, moscowDateSchema, positiveIntSchema, scopeRefSchema, sha256Schema, utcInstantSchema, uuidSchema, versionRefSchema } from '../primitives';

export const textSchema = z.string().refine(v => v.trim().length > 0, 'Expected nonempty text');
export const unique = <T>(values: T[], key: (v: T) => string = v => String(v)): boolean => new Set(values.map(key)).size === values.length;
export const refKey = (v: { entityType: string; id: string; revision?: number }): string => `${v.entityType}/${v.id}/${v.revision ?? ''}`;
export const scopeKey = (v: { kind: string; id: string }): string => `${v.kind}/${v.id}`;
export const refOf = (entityType: string) => versionRefSchema.refine(v => v.entityType === entityType, `Expected ${entityType} version`);
export const entityRefOf = (entityType: string) => entityRefSchema.refine(v => v.entityType === entityType, `Expected ${entityType} entity`);
export const idsSchema = z.array(uuidSchema).refine(v => unique(v));
export const refsSchema = (entityType: string) => z.array(refOf(entityType)).refine(v => unique(v, refKey));
export const populationSchema = z.array(scopeRefSchema).min(1).refine(v => unique(v, scopeKey));
const decimalTest = (v: string, test: (v: string) => boolean): boolean => { try { return test(v); } catch { return false; } };
export const nonnegativeDecimalSchema = decimalSchema.refine(v => decimalTest(v, n => compare(n, '0') >= 0));
export const positiveDecimalSchema = decimalSchema.refine(v => decimalTest(v, n => compare(n, '0') > 0));
export const safeCountSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const publicUrlSchema = z.string().refine(value => {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; } catch { return false; }
}, 'Expected absolute HTTP(S) URL without credentials');
export const numericConditionSchema = z.discriminatedUnion('op', [
  z.strictObject({ op: z.enum(['gte', 'lte', 'eq']), target: decimalSchema }),
  z.strictObject({ op: z.literal('range'), min: decimalSchema, max: decimalSchema }).refine(v => decimalTest(v.min, n => compare(n, v.max) <= 0)),
]);
export const normalizationSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('increase_ratio_v1') }),
  z.strictObject({ kind: z.literal('decrease_ratio_capped_v1'), maxPercent: positiveDecimalSchema }),
  z.strictObject({ kind: z.literal('zero_counter_v1') }),
  z.strictObject({ kind: z.literal('binary_condition_v1') }),
]);
export const inputReducerSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.enum(['source_provided_value', 'sum']), valueField: textSchema }),
  z.strictObject({ kind: z.literal('count') }),
  z.strictObject({ kind: z.literal('ratio'), numeratorField: textSchema, denominatorField: textSchema, multiplier: decimalSchema }),
]);
export const metricRuleSchema = z.strictObject({ metricRef: refOf('metric_definition'), mandatory: z.boolean(), originalWeight: nonnegativeDecimalSchema, condition: numericConditionSchema, normalization: normalizationSchema, freshness: z.strictObject({ maxAgeHours: positiveDecimalSchema, updateEveryHours: positiveDecimalSchema }), reducer: inputReducerSchema });
export const methodVersionSchema = z.discriminatedUnion('mode', [
  z.strictObject({ ...headerShape, mode: z.literal('numeric'), rules: z.array(metricRuleSchema).min(1).refine(v => unique(v, r => refKey(r.metricRef))).refine(v => {
    try { return compare(v.reduce((sum, r) => add(sum, r.originalWeight), { numerator: '0', denominator: '1' }), '0') > 0; } catch { return false; }
  }, 'Positive total weight required'), formula: z.strictObject({ kind: z.literal('weighted_mean_v1'), scoreCondition: numericConditionSchema }) }),
  z.strictObject({ ...headerShape, mode: z.literal('manual_status') }),
]);
export const coreGoalDefinitionSchema = z.strictObject({ ...headerShape, title: textSchema, description: z.string(), mode: z.enum(['numeric', 'manual_status']), measurementMode: z.enum(['as_of', 'period']), sourceId: uuidSchema, primaryCuratorPersonId: uuidSchema, coCuratorPersonIds: idsSchema, lifecycle: z.enum(['active', 'archived']), archiveReason: textSchema.nullable() }).refine(v => v.lifecycle !== 'archived' || v.archiveReason !== null);
export const methodBindingSchema = z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('template'), templateId: uuidSchema }), z.strictObject({ kind: z.literal('standalone'), methodRef: refOf('method_version') })]);
export const goalAssignmentSchema = z.strictObject({ ...headerShape, goalId: uuidSchema, scope: scopeRefSchema, methodBinding: methodBindingSchema, officialDueOn: moscowDateSchema.nullable(), expectedPopulation: populationSchema.nullable() });
export const templateSchema = z.strictObject({ ...headerShape, name: textSchema, methodRef: refOf('method_version') });
export const metricDefinitionSchema = z.strictObject({ ...headerShape, name: textSchema, unit: z.strictObject({ code: textSchema, label: textSchema }), domain: z.enum(['nonnegative_decimal', 'nonnegative_integer', 'signed_decimal']) });
export const directoryEntitySchema = z.strictObject({ ...headerShape, kind: z.enum(['dit', 'cluster', 'product', 'team', 'person', 'it_service']), name: textSchema, externalKeys: z.array(z.strictObject({ sourceId: uuidSchema, key: textSchema })).refine(v => unique(v, item => JSON.stringify([item.sourceId, item.key]))) });
export const directoryLinkSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...headerShape, kind: z.enum(['dit_cluster', 'cluster_product', 'cluster_team', 'product_team']), from: entityRefOf('directory_entity'), to: entityRefOf('directory_entity') }).refine(v => v.from.id !== v.to.id),
  z.strictObject({ ...headerShape, kind: z.literal('leader'), scope: scopeRefSchema, personId: uuidSchema }),
]);
export const gitOidSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
export const publicationAnchorSchema = z.strictObject({ schemaVersion: z.literal(1), id: uuidSchema, packageId: uuidSchema, revision: positiveIntSchema, contentHash: sha256Schema, repositoryId: textSchema, targetBranch: z.literal('main'), pullRequestId: textSchema.nullable(), proposalCommit: gitOidSchema.nullable(), mainCommit: gitOidSchema.nullable(), publicationState: z.enum(['confirmed', 'unconfirmed']), timeVerification: z.enum(['verified', 'unknown']), mergedAt: utcInstantSchema.nullable(), verifiedAt: utcInstantSchema.nullable(), reason: textSchema.nullable() }).refine(v => v.publicationState !== 'confirmed' || (v.mainCommit !== null && v.verifiedAt !== null)).refine(v => v.timeVerification === 'verified' ? v.mergedAt !== null && v.verifiedAt !== null && v.publicationState === 'confirmed' : v.mergedAt === null);
export { actorRefSchema };
