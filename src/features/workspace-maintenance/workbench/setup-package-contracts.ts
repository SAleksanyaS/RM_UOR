import { z } from 'zod';
import { versionRefSchema, uuidSchema } from '../../../domain/workbench/primitives';
import { maturityDefinitionSchema, maturityMaterialBundleSchema } from '../../maturity/workbench-contracts';
import { promptSchema } from '../../weekly-report/workbench/contracts';
import { reportDefinitionSchema } from '../../reporting/workbench/contracts';
export const setupSelectionSchema = z.strictObject({ materials: z.boolean(), references: z.boolean(), dashboards: z.boolean(), reports: z.boolean(), weeklyPrompts: z.boolean(), publishedRoots: z.array(versionRefSchema).max(1000).default([]) });
export type SetupSelection = z.input<typeof setupSelectionSchema>;
export const setupOwnerSchema = z.strictObject({ installationId: uuidSchema, personId: uuidSchema.nullable() });
export type SetupOwner = z.infer<typeof setupOwnerSchema>;
export const setupHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const setupKeySchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,250}$/).refine(v => !v.includes('..') && !v.includes('//'));
export const setupValueSchemas = {
    'maturity-definition': maturityDefinitionSchema,
    'maturity-reference': maturityMaterialBundleSchema,
    'weekly-prompt': promptSchema,
    'report-recipe': reportDefinitionSchema,
    'dashboard-template': z.strictObject({ title: z.string().min(1).max(160), blocks: z.array(z.enum(['summary', 'matrix', 'quality', 'sources'])).min(1), requiresGoalSelection: z.literal(true) }),
};
export const setupRecordSchema = z.strictObject({ key: setupKeySchema, kind: z.enum(['maturity-definition', 'maturity-reference', 'weekly-prompt', 'report-recipe', 'dashboard-template']), value: z.record(z.string(), z.unknown()), dependencies: z.array(setupKeySchema), sha256: setupHashSchema });
export type SetupRecord = z.infer<typeof setupRecordSchema>;
export const setupFileSchema = z.strictObject({ path: setupKeySchema, sha256: setupHashSchema, bytes: z.number().int().nonnegative().max(1024 * 1024), bytesBase64: z.string().max(1400000) });
export const setupCoreSchema = z.strictObject({ entityType: z.string().min(1), version: z.number().int().positive(), value: z.record(z.string(), z.unknown()) });
export const setupPackageSchema = z.strictObject({ schemaVersion: z.literal(1), format: z.literal('uor-common-setup'), packageId: setupKeySchema, version: z.number().int().positive(), minAppVersion: z.string().regex(/^\d+\.\d+\.\d+$/), selection: setupSelectionSchema, provenance: z.strictObject({ kind: z.literal('selected-common-content'), description: z.string().min(1), sourceHashes: z.array(setupHashSchema) }), records: z.array(setupRecordSchema).max(1000), core: z.array(setupCoreSchema).max(10000), files: z.array(setupFileSchema).max(100), inventory: z.strictObject({ records: z.number().int(), coreVersions: z.number().int(), files: z.number().int(), bytes: z.number().int() }), sha256: setupHashSchema });
export type SetupPackage = z.infer<typeof setupPackageSchema>;
export const setupPreviewSchema = z.strictObject({ digest: setupHashSchema, packageHash: setupHashSchema, currentRevision: z.number().int().nonnegative(), changes: z.array(z.strictObject({ key: z.string(), action: z.enum(['add', 'update', 'unchanged', 'conflict']) })), coreChanges: z.array(z.strictObject({ key: z.string(), action: z.enum(['add', 'unchanged', 'conflict']) })), warnings: z.array(z.string()) });
export type SetupPreview = z.infer<typeof setupPreviewSchema>;
