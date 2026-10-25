import { z } from 'zod';
export const MAX_BUNDLE_BYTES=64*1024*1024;
export const MAX_EXPANDED_BYTES=256*1024*1024;
export const MAX_FILE_BYTES=32*1024*1024;
export const exportOptionsSchema=z.object({includeOriginals:z.boolean().default(false),includeReports:z.boolean().default(false)}).strict();
export type ExportOptions=z.infer<typeof exportOptionsSchema>;
export const storagePolicySchema=z.object({originalDays:z.number().int().min(1).max(3650),reportDays:z.number().int().min(1).max(3650),temporaryGitDays:z.number().int().min(1).max(365),factDays:z.number().int().min(30).max(3650).nullable(),keepPeriods:z.number().int().min(3).max(120),graceDays:z.number().int().min(7).max(365),automaticQuarantine:z.boolean()}).strict();
export type StoragePolicy=z.infer<typeof storagePolicySchema>;
export const defaultStoragePolicy:StoragePolicy={originalDays:180,reportDays:180,temporaryGitDays:7,factDays:null,keepPeriods:12,graceDays:30,automaticQuarantine:false};
export interface PortableRecord{namespace:string;id:string;value:unknown}
export interface BundleFile{key:string;kind:'evidence'|'original';relativePath:string;sha256:string;bytes:number}
export interface BundleManifest{format:'uor-workspace-v1';version:1;applicationVersion:string;storageSchemaVersion:number;classification:'demo'|'corporate';createdAt:string;actor:{id:string;name:string;installationId:string};options:ExportOptions;recordsSha256:string;files:BundleFile[];omissions:string[]}
export interface BundleSummary{createdAt:string;classification:'demo'|'corporate';goals:number;snapshots:number;evidence:number;reports:number;files:number;bytes:number;actor:string;omissions:string[]}
export interface RestorePreview extends BundleSummary{id:string;expiresAt:string;sourceCuratorId:string;sourceCuratorName:string;targetCuratorId:string;canRebind:boolean}
export interface StorageItem{id:string;kind:'source_file'|'evidence_file'|'export_file'|'staging_file'|'rollback_bundle'|'git_workspace'|'snapshot'|'report';relativePath?:string;namespace?:string;recordId?:string;label:string;bytes:number;at:string;pinned:boolean;reason:string;fingerprint:string}
export interface StoragePreview{id:string;expiresAt:string;policy:StoragePolicy;items:StorageItem[];eligibleBytes:number;protectedBytes:number}
export interface QuarantineItem{id:string;batchId:string;at:string;expiresAt:string;kind:StorageItem['kind'];label:string;bytes:number;originalPath?:string;storedPath?:string;sha256?:string;record?:PortableRecord;relatedRecords?:PortableRecord[];fileHashes?:{path:string;sha256:string;bytes:number}[]}
