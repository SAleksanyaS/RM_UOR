import { z } from 'zod';
import type { Header } from '../../../domain/workbench/primitives';
import { entityRefSchema, positiveIntSchema, sha256Schema, utcInstantSchema, uuidSchema, versionRefSchema } from '../../../domain/workbench/primitives';
import { problemSchema } from '../../../server/workbench/protocol';

export const gitOidSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
export const rawSha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const packageRevisionSchema = z.strictObject({schemaVersion:z.literal(1),packageId:uuidSchema,cycleId:uuidSchema,curatorPersonId:uuidSchema,revision:positiveIntSchema,baseCommit:gitOidSchema,targetBranch:z.literal('main'),contentHash:sha256Schema,createdAt:utcInstantSchema});
export type PackageRevision = z.infer<typeof packageRevisionSchema>;
export const packageFileSchema = z.strictObject({path:z.string().min(1),sha256:rawSha256Schema,bytes:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)});
export type PackageFile = z.infer<typeof packageFileSchema>;
export const packageManifestSchema = z.strictObject({packageRevision:packageRevisionSchema,files:z.array(packageFileSchema)});
export type PackageManifest = z.infer<typeof packageManifestSchema>;
export const packageStateSchema = z.enum(['draft','validating','preview_ready','publishing','open_pr','needs_rework','merged','declined']);
export type PackageState = z.infer<typeof packageStateSchema>;
export type PublicationPackageRecord = Header & {cycleId:string;curatorPersonId:string;state:PackageState;current:PackageRevision|null;sent:PackageRevision|null;draftRefs:Array<z.infer<typeof versionRefSchema>>;proposal:null|{provider:'bitbucket';repositoryId:string;id:string;url:string}};
export const packagePreviewInputSchema = z.strictObject({packageId:uuidSchema});
export type PackagePreviewInput = z.infer<typeof packagePreviewInputSchema>;
export type PackageSubmitInput = {packageId:string;previewToken:string};
export const packageChangeSchema = z.strictObject({objectRef:entityRefSchema,field:z.string(),before:z.unknown(),main:z.unknown(),proposed:z.unknown(),conflict:z.boolean()});
export type PackageChange = z.infer<typeof packageChangeSchema>;
export const packagePreviewResultSchema = z.strictObject({packageRevision:packageRevisionSchema,previewToken:z.string().min(1),expiresAt:utcInstantSchema,changes:z.array(packageChangeSchema),warnings:z.array(problemSchema),errors:z.array(problemSchema)});
export type PackagePreviewResult = z.infer<typeof packagePreviewResultSchema>;
export interface PackageArtifactStore {readRevision(ref:PackageRevision):Promise<ReadonlyMap<string,Uint8Array>>;writeRevision(ref:PackageRevision,files:ReadonlyMap<string,Uint8Array>):Promise<void>}
export type VerifiedMain = {repositoryId:string;commit:string;files:ReadonlyMap<string,Uint8Array>};
export type PackageMainReader = {readMain:()=>Promise<VerifiedMain>};
