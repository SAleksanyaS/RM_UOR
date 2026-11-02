import { isDeepStrictEqual } from 'node:util';
import { lstatSync,realpathSync,readFileSync,rmSync,rmdirSync } from 'node:fs';
import path from 'node:path';
import { browserArtifactMime } from './workbench-artifact-policy';
import { createHash } from 'node:crypto';
import { captureIntentSchema, captureReceiptSchema, captureArtifactSchema, captureStagingSchema, type CaptureStaging, type CaptureIntent, type CaptureReceipt } from './workbench-capture-contracts';
import type { Downloaded } from './transport';
import type { WorkbenchRepository } from '../../server/storage/workbench-repository';
import { WorkbenchHttpError } from '../../server/workbench/protocol';
/** Metadata row of a saved raw report file; bytes stay in `payload_json`. */
export type StoredExportMeta = {
    id: string;
    workflowId: string;
    title: string;
    fileName: string;
    mimeType: string;
    bytes: number;
    sha256: string;
    capturedAt: string;
    sourceDate: string | null;
    rowCount: number | null;
    origin: string;
    deletedAt: string | null;
};
/** Private installation/person drafts: no portable entity headers or published heads. */
export function createOkoWorkflowStore(repository: WorkbenchRepository) {
    const sql = repository.sqlForModule('oko_workflow');
    sql.execMigration('v1', `CREATE TABLE wb_oko_workflow_drafts(owner TEXT NOT NULL,id TEXT NOT NULL,revision TEXT NOT NULL,payload_json TEXT NOT NULL,PRIMARY KEY(owner,id));
    CREATE TABLE wb_oko_workflow_results(owner TEXT NOT NULL,id TEXT NOT NULL,payload_json TEXT NOT NULL,PRIMARY KEY(owner,id))`);
    sql.execMigration('v2-original-omissions','CREATE TABLE wb_oko_workflow_original_omissions(file_key TEXT PRIMARY KEY,sha256 TEXT NOT NULL,bytes INTEGER NOT NULL)');
    sql.execMigration('v3-exports',`CREATE TABLE wb_oko_workflow_exports(owner TEXT NOT NULL,id TEXT NOT NULL,workflow_id TEXT NOT NULL,title TEXT NOT NULL,file_name TEXT NOT NULL,mime_type TEXT NOT NULL,bytes INTEGER NOT NULL,sha256 TEXT NOT NULL,captured_at TEXT NOT NULL,source_date TEXT,row_count INTEGER,origin TEXT NOT NULL,deleted_at TEXT,payload_json TEXT NOT NULL,PRIMARY KEY(owner,id))`);
    sql.execMigration('v4-exports-index','CREATE INDEX wb_oko_workflow_exports_captured ON wb_oko_workflow_exports(owner,captured_at DESC)');
    sql.execMigration('v5-captures',`CREATE TABLE wb_oko_workflow_captures(owner TEXT NOT NULL,capture_id TEXT NOT NULL,operation_id TEXT NOT NULL,workflow_id TEXT NOT NULL,intent_json TEXT NOT NULL,receipt_json TEXT,download_json TEXT,state TEXT NOT NULL,PRIMARY KEY(owner,capture_id),UNIQUE(owner,operation_id))`);
    sql.execMigration('v6-capture-staging','ALTER TABLE wb_oko_workflow_captures ADD COLUMN staging_json TEXT');
    const failure=(code:string):never=>{throw new WorkbenchHttpError(409,code,code);};
    const captureRow=(owner:string,id:string)=>sql.get<{intent_json:string;receipt_json:string|null;download_json:string|null;state:string}>('SELECT intent_json,receipt_json,download_json,state FROM wb_oko_workflow_captures WHERE owner=? AND capture_id=?',[owner,id]);
    const receipt=(owner:string,id:string):CaptureReceipt|null=>{const row=captureRow(owner,id);return row?.receipt_json?captureReceiptSchema.parse(JSON.parse(row.receipt_json)):null;};
    const cleanupStaging=(owner:string,id:string)=>{
      const row=sql.get<{staging_json:string|null;receipt_json:string|null}>('SELECT staging_json,receipt_json FROM wb_oko_workflow_captures WHERE owner=? AND capture_id=?',[owner,id]);if(!row?.staging_json||!row.receipt_json)return;
      const binding=captureStagingSchema.parse(JSON.parse(row.staging_json)),verified=captureReceiptSchema.parse(JSON.parse(row.receipt_json));
      const saved=sql.get<{payload_json:string}>('SELECT payload_json FROM wb_oko_workflow_exports WHERE owner=? AND id=?',[owner,verified.exportId]);if(!saved)return;const artifact=captureArtifactSchema.parse(JSON.parse(saved.payload_json).artifact),bytes=Buffer.from(artifact.base64,'base64');if(bytes.length!==verified.bytes||createHash('sha256').update(bytes).digest('hex')!==verified.sha256)return;
      try{if(path.basename(binding.directory)!==id||realpathSync(binding.directory)!==path.resolve(binding.directory))return;for(const name of [binding.guid,binding.guid+'.crdownload']){const target=path.join(binding.directory,name);try{const info=lstatSync(target);if(info.isFile()&&!info.isSymbolicLink())rmSync(target);}catch{ /* Retain inaccessible/busy files for the next recovery pass. */ }}try{rmdirSync(binding.directory);}catch{ /* Unknown files are never recursively removed. */ }}catch{ /* Lost/foreign staging is not cleanup authority. */ }
    };
    const finalize=(owner:string,id:string):CaptureReceipt=>repository.transaction(()=>{
      const row=captureRow(owner,id);if(!row) return failure('CAPTURE_NOT_FOUND');
      if(row.receipt_json)return captureReceiptSchema.parse(JSON.parse(row.receipt_json));
      if(!row.download_json)return failure('CAPTURE_NOT_SECURED');
      const intent=captureIntentSchema.parse(JSON.parse(row.intent_json)),artifact=captureArtifactSchema.parse(JSON.parse(row.download_json));
      const bytes=Buffer.from(artifact.base64,'base64');if(bytes.toString('base64')!==artifact.base64||createHash('sha256').update(bytes).digest('hex')!==artifact.hash)return failure('CAPTURE_INTEGRITY');
      const result=captureReceiptSchema.parse({schemaVersion:1,captureId:id,exportId:id,workflowId:intent.workflowId,operationId:intent.operationId,sha256:artifact.hash,bytes:bytes.length,capturedAt:new Date().toISOString(),sourceName:artifact.name,mimeType:artifact.mimeType,formatStatus:artifact.formatStatus??'unsupported'});
      const extension=/\.([a-z0-9]{1,8})$/i.exec(artifact.name)?.[1]?.toLowerCase()??'bin',title=intent.title.replace(/[\x00-\x1f\x7f/\\:*?"<>|]+/g,' ').replace(/\s+/g,' ').trim().slice(0,60)||'Отчёт';
      const displayName=`ОКО_${title}_${result.capturedAt.slice(0,10)}_${result.capturedAt.slice(11,16).replace(':','-')}.${extension}`;
      const {formatStatus:_formatStatus,...rawArtifact}=artifact;
      sql.run('INSERT INTO wb_oko_workflow_exports(owner,id,workflow_id,title,file_name,mime_type,bytes,sha256,captured_at,source_date,row_count,origin,deleted_at,payload_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',[owner,id,intent.workflowId,intent.title,displayName,artifact.mimeType,bytes.length,artifact.hash,result.capturedAt,null,null,intent.sourceKind==='confluence'?'confluence':intent.origin,null,JSON.stringify({artifact:{...rawArtifact,name:displayName},results:[],captureReceipt:result})]);
      sql.run("UPDATE wb_oko_workflow_captures SET receipt_json=?,state='committed',download_json=NULL WHERE owner=? AND capture_id=?",[JSON.stringify(result),owner,id]);return result;
    });
    const secureStaging=()=>{for(const row of sql.all<{owner:string;capture_id:string;staging_json:string;intent_json:string}>("SELECT owner,capture_id,staging_json,intent_json FROM wb_oko_workflow_captures WHERE receipt_json IS NULL AND download_json IS NULL AND staging_json IS NOT NULL")){
      const binding=captureStagingSchema.parse(JSON.parse(row.staging_json));
      try{if(realpathSync(binding.directory)!==path.resolve(binding.directory)||path.basename(binding.directory)!==row.capture_id)continue;const file=path.join(binding.directory,binding.guid),before=lstatSync(file);if(!before.isFile()||before.isSymbolicLink()||before.size<1||before.size>(captureIntentSchema.parse(JSON.parse(row.intent_json)).maxBytes??10*1024*1024))continue;const bytes=readFileSync(file),after=lstatSync(file);if(before.ino!==after.ino||before.mtimeMs!==after.mtimeMs||before.size!==after.size||bytes.length!==after.size)continue;const ext=/\.([a-z0-9]+)$/i.exec(binding.name)?.[1]?.toLowerCase(),mimeType=browserArtifactMime[ext as keyof typeof browserArtifactMime]??'application/octet-stream';const formatStatus=/^\s*(?:<!doctype\s+html|<html|<form|<\?xml)/i.test(bytes.subarray(0,2048).toString('utf8').replace(/^\uFEFF/,''))?'quarantined':'unsupported';const artifact={name:binding.name,mimeType,formatStatus,base64:bytes.toString('base64'),hash:createHash('sha256').update(bytes).digest('hex')};sql.run("UPDATE wb_oko_workflow_captures SET download_json=?,state='secured' WHERE owner=? AND capture_id=? AND receipt_json IS NULL",[JSON.stringify(artifact),row.owner,row.capture_id]);}catch(error){if(!['ENOENT','EACCES','EPERM'].includes((error as NodeJS.ErrnoException).code??''))throw error;}
    }};
    // Recovery is synchronous before any store read/query is admitted. Pending intent never implies success.
    secureStaging();
    for(const row of sql.all<{owner:string;capture_id:string}>("SELECT owner,capture_id FROM wb_oko_workflow_captures WHERE state='secured'"))finalize(row.owner,row.capture_id);
    return {
        recoverCaptures():void {secureStaging();for(const row of sql.all<{owner:string;capture_id:string}>("SELECT owner,capture_id FROM wb_oko_workflow_captures WHERE state='secured'"))finalize(row.owner,row.capture_id);for(const row of sql.all<{owner:string;capture_id:string}>("SELECT owner,capture_id FROM wb_oko_workflow_captures WHERE state='committed' AND staging_json IS NOT NULL"))cleanupStaging(row.owner,row.capture_id);},
        stageCapture(owner:string,id:string,input:CaptureStaging):void {const binding=captureStagingSchema.parse(input);if(!captureRow(owner,id))failure('CAPTURE_NOT_FOUND');if(!path.isAbsolute(binding.directory)||path.basename(binding.directory)!==id||realpathSync(binding.directory)!==path.resolve(binding.directory))failure('CAPTURE_STAGING_INVALID');const row=sql.get<{staging_json:string|null}>('SELECT staging_json FROM wb_oko_workflow_captures WHERE owner=? AND capture_id=?',[owner,id]);if(row?.staging_json&&row.staging_json!==JSON.stringify(binding))failure('CAPTURE_CONFLICT');sql.run('UPDATE wb_oko_workflow_captures SET staging_json=? WHERE owner=? AND capture_id=?',[JSON.stringify(binding),owner,id]);},
        beginCapture(owner:string,value:CaptureIntent):CaptureIntent {const intent=captureIntentSchema.parse(value);return repository.transaction(()=>{const old=sql.get<{intent_json:string}>('SELECT intent_json FROM wb_oko_workflow_captures WHERE owner=? AND operation_id=?',[owner,intent.operationId]);if(old){const previous=captureIntentSchema.parse(JSON.parse(old.intent_json));if(previous.workflowId!==intent.workflowId||previous.sourceId!==intent.sourceId||previous.origin!==intent.origin||previous.sourceKind!==intent.sourceKind||JSON.stringify(previous.sourceMetadata)!==JSON.stringify(intent.sourceMetadata))failure('CAPTURE_CONFLICT');return previous;}sql.run("INSERT INTO wb_oko_workflow_captures(owner,capture_id,operation_id,workflow_id,intent_json,state) VALUES(?,?,?,?,?,'pending')",[owner,intent.captureId,intent.operationId,intent.workflowId,JSON.stringify(intent)]);return intent;});},
        captureReceipt:receipt,
        captureIntent(owner:string,id:string):CaptureIntent|null {const row=captureRow(owner,id);return row?captureIntentSchema.parse(JSON.parse(row.intent_json)):null;},
        secureCapture(owner:string,id:string,download:Downloaded):void {const row=captureRow(owner,id);if(!row)failure('CAPTURE_NOT_FOUND');if(download.bytes.length<1||download.bytes.length>(captureIntentSchema.parse(JSON.parse(row!.intent_json)).maxBytes??10*1024*1024))failure('CAPTURE_SIZE');const value=captureArtifactSchema.parse({name:download.name,mimeType:download.contentType||'application/octet-stream',base64:Buffer.from(download.bytes).toString('base64'),hash:createHash('sha256').update(download.bytes).digest('hex'),...(download.formatStatus?{formatStatus:download.formatStatus}:{})});const prior=receipt(owner,id);if(prior){if(prior.sha256!==value.hash||prior.sourceName!==value.name||prior.mimeType!==value.mimeType)failure('CAPTURE_CONFLICT');return;}if(row!.download_json&&row!.download_json!==JSON.stringify(value))failure('CAPTURE_CONFLICT');sql.run("UPDATE wb_oko_workflow_captures SET download_json=?,state='secured' WHERE owner=? AND capture_id=?",[JSON.stringify(value),owner,id]);},
        commitCapture(owner:string,id:string,download:Downloaded):CaptureReceipt {this.secureCapture(owner,id,download);const result=finalize(owner,id);cleanupStaging(owner,id);return result;},
        interruptCaptures(owner:string):void {sql.run("UPDATE wb_oko_workflow_captures SET state='interrupted' WHERE owner=? AND state='pending'",[owner]);},
        get<T = Record<string, unknown>>(owner: string, id: string): T | null { const row = sql.get<{
            payload_json: string;
        }>('SELECT payload_json FROM wb_oko_workflow_drafts WHERE owner=? AND id=?', [owner, id]); return row ? JSON.parse(row.payload_json) as T : null; },
        list<T = Record<string, unknown>>(owner: string): T[] { return sql.all<{
            payload_json: string;
        }>('SELECT payload_json FROM wb_oko_workflow_drafts WHERE owner=? ORDER BY id', [owner]).map(row => JSON.parse(row.payload_json) as T); },
        save(owner: string, id: string, expected: string | null, value: {
            revision: string;
            [key: string]: unknown;
        }) {
            repository.transaction(() => {
                const row = sql.get<{
                    revision: string;
                }>('SELECT revision FROM wb_oko_workflow_drafts WHERE owner=? AND id=?', [owner, id]);
                if ((row?.revision ?? null) !== expected)
                    throw new WorkbenchHttpError(409, 'REVISION_CONFLICT', 'Workflow changed; reload your draft');
                if (row)
                    sql.run('UPDATE wb_oko_workflow_drafts SET revision=?,payload_json=? WHERE owner=? AND id=?', [value.revision, JSON.stringify(value), owner, id]);
                else
                    sql.run('INSERT INTO wb_oko_workflow_drafts(owner,id,revision,payload_json) VALUES(?,?,?,?)', [owner, id, value.revision, JSON.stringify(value)]);
            });
        },
        putResult(owner: string, id: string, value: unknown) { sql.run('INSERT INTO wb_oko_workflow_results(owner,id,payload_json) VALUES(?,?,?) ON CONFLICT(owner,id) DO NOTHING', [owner, id, JSON.stringify(value)]); },
        hasResult(owner:string,id:string):boolean { return sql.get('SELECT 1 FROM wb_oko_workflow_results WHERE owner=? AND id=?',[owner,id])!==null; },
        getResult<T>(owner: string, id: string): T | null { const row = sql.get<{
            payload_json: string;
        }>('SELECT payload_json FROM wb_oko_workflow_results WHERE owner=? AND id=?', [owner, id]); return row ? JSON.parse(row.payload_json) as T : null; },
        originalOmitted(owner:string,id:string):boolean { return sql.get('SELECT r.id FROM wb_oko_workflow_results r JOIN wb_oko_workflow_original_omissions o ON o.file_key=r.id WHERE r.owner=? AND r.id=?',[owner,id])!==null; },
        /** Idempotent: a retried download keeps the first stored bytes for the same id. */
        putExport(owner:string,meta:StoredExportMeta,payload:unknown):void {repository.transaction(()=>{const existing=this.getExport<unknown>(owner,meta.id);if(existing){const immutable=(m:StoredExportMeta)=>({id:m.id,workflowId:m.workflowId,title:m.title,fileName:m.fileName,mimeType:m.mimeType,bytes:m.bytes,sha256:m.sha256,capturedAt:m.capturedAt,origin:m.origin});if(!isDeepStrictEqual(immutable(existing.meta),immutable(meta))||!isDeepStrictEqual(existing.payload,payload))failure('EXPORT_CONFLICT');return;}sql.run('INSERT INTO wb_oko_workflow_exports(owner,id,workflow_id,title,file_name,mime_type,bytes,sha256,captured_at,source_date,row_count,origin,deleted_at,payload_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',[owner,meta.id,meta.workflowId,meta.title,meta.fileName,meta.mimeType,meta.bytes,meta.sha256,meta.capturedAt,meta.sourceDate,meta.rowCount,meta.origin,meta.deletedAt,JSON.stringify(payload)]);});},
        listExports(owner: string, filter: { workflowId?: string; includeHidden?: boolean } = {}): StoredExportMeta[] { return sql.all<{
            id: string; workflow_id: string; title: string; file_name: string; mime_type: string; bytes: number; sha256: string; captured_at: string; source_date: string | null; row_count: number | null; origin: string; deleted_at: string | null;
        }>(`SELECT id,workflow_id,title,file_name,mime_type,bytes,sha256,captured_at,source_date,row_count,origin,deleted_at FROM wb_oko_workflow_exports WHERE owner=?${filter.includeHidden ? ' AND (deleted_at IS NULL OR deleted_at IS NOT NULL)' : ' AND deleted_at IS NULL'}${filter.workflowId ? ' AND workflow_id=?' : ''} ORDER BY captured_at DESC,id DESC`, filter.workflowId ? [owner, filter.workflowId] : [owner]).map(row => ({ id: row.id, workflowId: row.workflow_id, title: row.title, fileName: row.file_name, mimeType: row.mime_type, bytes: row.bytes, sha256: row.sha256, capturedAt: row.captured_at, sourceDate: row.source_date, rowCount: row.row_count, origin: row.origin, deletedAt: row.deleted_at })); },
        getExport<T = { artifact: unknown }>(owner: string, id: string): { meta: StoredExportMeta; payload: T } | null { const row = sql.get<{
            payload_json: string; workflow_id: string; title: string; file_name: string; mime_type: string; bytes: number; sha256: string; captured_at: string; source_date: string | null; row_count: number | null; origin: string; deleted_at: string | null;
        }>('SELECT payload_json,workflow_id,title,file_name,mime_type,bytes,sha256,captured_at,source_date,row_count,origin,deleted_at FROM wb_oko_workflow_exports WHERE owner=? AND id=?', [owner, id]); return row ? { meta: { id, workflowId: row.workflow_id, title: row.title, fileName: row.file_name, mimeType: row.mime_type, bytes: row.bytes, sha256: row.sha256, capturedAt: row.captured_at, sourceDate: row.source_date, rowCount: row.row_count, origin: row.origin, deletedAt: row.deleted_at }, payload: JSON.parse(row.payload_json) as T } : null; },
        hasExport(owner: string, id: string): boolean { return sql.get('SELECT 1 FROM wb_oko_workflow_exports WHERE owner=? AND id=?', [owner, id]) !== null; },
        countHiddenExports(owner: string): number { const row = sql.get<{ total: number }>('SELECT COUNT(*) AS total FROM wb_oko_workflow_exports WHERE owner=? AND deleted_at IS NOT NULL', [owner]); return Number(row?.total ?? 0); },
        /** "Hide from the list" only: bytes are retained so a later enrichment can still use them. */
        markExportDeleted(owner: string, id: string, at: string): boolean { sql.run('UPDATE wb_oko_workflow_exports SET deleted_at=? WHERE owner=? AND id=? AND deleted_at IS NULL', [at, owner, id]); return sql.get('SELECT 1 FROM wb_oko_workflow_exports WHERE owner=? AND id=? AND deleted_at=?', [owner, id, at]) !== null; },
        unhideExport(owner: string, id: string): boolean { sql.run('UPDATE wb_oko_workflow_exports SET deleted_at=NULL WHERE owner=? AND id=? AND deleted_at IS NOT NULL', [owner, id]); return sql.get('SELECT 1 FROM wb_oko_workflow_exports WHERE owner=? AND id=? AND deleted_at IS NULL', [owner, id]) !== null; },
        updateExportOutcome(owner: string, id: string, outcome: { rowCount: number | null; sourceDate: string | null }) { sql.run('UPDATE wb_oko_workflow_exports SET row_count=?,source_date=? WHERE owner=? AND id=?', [outcome.rowCount, outcome.sourceDate, owner, id]); },
    };
}
