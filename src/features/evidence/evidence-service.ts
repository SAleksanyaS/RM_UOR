import { createHash } from 'node:crypto';
import { readFile,mkdir,writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { Evidence,Classification,Session } from '../../domain/contracts';
import type { ApplicationContext } from '../../server/workspace/context';
import { safeArtifactPath } from '../../server/workspace/paths';
import { ActionError } from '../identity/role-service';

export const MAX_EVIDENCE_BYTES=5_000_000;
const idSchema=z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/), nameSchema=z.string().min(1).max(200).refine(value=>!/[\x00-\x1f\x7f/\\]/.test(value),'Недопустимое имя файла');
export const evidenceBundleSchema=z.object({schemaVersion:z.literal(1),classification:z.enum(['demo','corporate']),id:idSchema,name:nameSchema,size:z.number().int().min(1).max(MAX_EVIDENCE_BYTES),sha256:z.string().regex(/^[a-f0-9]{64}$/),base64:z.string().max(6_666_668),uploadedBy:z.string().max(500).optional(),uploadedAt:z.iso.datetime({offset:true}).optional()}).strict();
export type EvidenceBundle=z.infer<typeof evidenceBundleSchema>;
export interface EvidenceRecord extends Evidence {classification?:Classification;curatorId?:string|null;ownerInstallationId?:string;uploadedBy?:string;uploadedAt?:string;shared?:boolean}
export interface EvidenceMetadata extends Omit<EvidenceRecord,'relativePath'> {downloadUrl:string}
export interface ValidatedEvidenceBundle {bundle:EvidenceBundle;bytes:Buffer}
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const fail=(message:string)=>new ActionError(message,400);
function decoded(input:string){if(!input||input.length%4||!/^[A-Za-z0-9+/]*={0,2}$/.test(input))throw fail('Некорректный base64 доказательства');const bytes=Buffer.from(input,'base64');if(bytes.toString('base64')!==input)throw fail('Неканонический base64 доказательства');return bytes;}
/** Legacy relativePath is deliberately discarded; only verified bytes identify the file. */
export function validateEvidenceBundle(raw:unknown,classification:Classification):ValidatedEvidenceBundle {
  let normalized=raw;
  if(raw&&typeof raw==='object'&&!('schemaVersion' in raw)){
    const legacy=z.object({id:idSchema,name:nameSchema,size:z.number().int().min(1).max(MAX_EVIDENCE_BYTES),sha256:z.string().regex(/^[a-f0-9]{64}$/),base64:z.string().max(6_666_668),classification:z.enum(['demo','corporate']).optional(),uploadedBy:z.string().max(500).optional(),uploadedAt:z.iso.datetime({offset:true}).optional()}).passthrough().parse(raw);
    normalized={schemaVersion:1,classification:legacy.classification??classification,id:legacy.id,name:legacy.name,size:legacy.size,sha256:legacy.sha256,base64:legacy.base64,...(legacy.uploadedBy?{uploadedBy:legacy.uploadedBy}:{}),...(legacy.uploadedAt?{uploadedAt:legacy.uploadedAt}:{})};
  }
  const bundle=evidenceBundleSchema.parse(normalized);if(bundle.classification!==classification)throw fail('Классификация доказательства отличается от каталога');
  const bytes=decoded(bundle.base64);if(bytes.length!==bundle.size||bytes.length>MAX_EVIDENCE_BYTES||!bytes.length)throw fail('Размер доказательства не совпадает или превышает 5 МБ');if(hash(bytes)!==bundle.sha256)throw fail('Хеш доказательства не совпадает');return {bundle,bytes};
}
export function canReadEvidence(context:ApplicationContext,session:Session,record:EvidenceRecord,classification:Classification){return (!record.classification||record.classification===classification)&&(record.shared===true||((!record.ownerInstallationId||record.ownerInstallationId===context.installationId)&&(!record.curatorId||record.curatorId===session.curatorId)));}
export async function listEvidence(context:ApplicationContext,session:Session):Promise<EvidenceMetadata[]>{const catalog=await context.catalogs.readForSession(session);return context.db.list<EvidenceRecord>('evidence').filter(e=>canReadEvidence(context,session,e,catalog.classification)).map(({relativePath:_path,...metadata})=>({...metadata,downloadUrl:`/api/evidence/${encodeURIComponent(metadata.id)}/download`})).sort((a,b)=>(b.uploadedAt??'').localeCompare(a.uploadedAt??'')||a.name.localeCompare(b.name,'ru'));}
export async function readEvidenceBytes(context:ApplicationContext,session:Session,id:string,classification?:Classification){idSchema.parse(id);const record=context.db.get<EvidenceRecord>('evidence',id),kind=classification??(await context.catalogs.readForSession(session)).classification;if(!record||!canReadEvidence(context,session,record,kind))throw new ActionError('Доказательство недоступно',404);let bytes:Buffer;try{bytes=await readFile(await safeArtifactPath(context.paths.runtimeRoot,record.relativePath));}catch{throw new ActionError('Файл доказательства отсутствует или имеет небезопасный путь',404);}if(bytes.length!==record.size||bytes.length>MAX_EVIDENCE_BYTES||hash(bytes)!==record.sha256)throw fail('Файл доказательства повреждён: размер или хеш не совпадает');return {record,bytes};}
export async function prepareEvidenceBundle(context:ApplicationContext,session:Session,id:string,classification:Classification):Promise<EvidenceBundle>{const {record,bytes}=await readEvidenceBytes(context,session,id,classification);return evidenceBundleSchema.parse({schemaVersion:1,classification,id:record.id,name:record.name,size:bytes.length,sha256:hash(bytes),base64:bytes.toString('base64'),...(record.uploadedBy?{uploadedBy:record.uploadedBy}:{}),...(record.uploadedAt?{uploadedAt:record.uploadedAt}:{})});}
/** Stage outside the DB transaction. Existing content-addressed files are verified, never overwritten. */
export async function stageEvidenceBundle(runtimeRoot:string,checked:ValidatedEvidenceBundle):Promise<EvidenceRecord>{const verified=validateEvidenceBundle(checked.bundle,checked.bundle.classification);if(!verified.bytes.equals(checked.bytes))throw fail('Проверенные байты доказательства изменились');const {bundle,bytes}=verified,relativePath=`evidence/shared/${bundle.id}-${bundle.sha256}`,directory=await safeArtifactPath(runtimeRoot,'evidence/shared');await mkdir(directory,{recursive:true});const destination=await safeArtifactPath(runtimeRoot,relativePath);try{await writeFile(destination,bytes,{flag:'wx'});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;const existing=await readFile(destination);if(existing.length!==bundle.size||hash(existing)!==bundle.sha256)throw fail('Существующий файл общего доказательства повреждён; перезапись запрещена');}return {id:bundle.id,name:bundle.name,size:bundle.size,sha256:bundle.sha256,relativePath,classification:bundle.classification,shared:true,...(bundle.uploadedBy?{uploadedBy:bundle.uploadedBy}:{}),...(bundle.uploadedAt?{uploadedAt:bundle.uploadedAt}:{})};}
