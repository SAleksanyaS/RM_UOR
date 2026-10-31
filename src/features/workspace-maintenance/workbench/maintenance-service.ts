import type { CommandContext } from '../../../server/workbench/command-registry';
import type { QueryContext } from '../../../server/workbench/query-registry';
import { WorkbenchHttpError } from '../../../server/workbench/protocol';
import type { CodeUpdateInput, CodeUpdateCheckInput, CodeUpdateCheckResult, CodeUpdateApplyResult } from '../../system/workbench/code-update-service';
import type { BackupCreateInput, BackupCreateResult, BackupFile, MaintenanceDependencies, RestoreApplyInput, RestoreApplyResult, RestorePreviewInput, RestorePreviewResult, UUIDv4 } from './contracts';
import { RestoreService } from './restore-service';
import JSZip from 'jszip';
import { archiveManifestSchema,archiveRecordSchema,type WorkspaceArchiveRecord,type WorkspaceArchiveFileSource } from './contracts';
import { snapshotWorkspace,requireArchiveWorkspace,archiveHash,privateExclusions,validateWorkspaceArchive } from './workspace-archive';

export class MaintenanceService {
  private readonly restore: RestoreService;
  constructor(private readonly deps: MaintenanceDependencies) { this.restore = new RestoreService(deps.archive); }
  createBackup(context: CommandContext, input: BackupCreateInput): Promise<BackupCreateResult> { return this.restore.createBackup(context, input); }
  previewRestore(context: CommandContext, input: RestorePreviewInput): Promise<RestorePreviewResult> { return this.restore.previewRestore(context, input); }
  applyRestore(context: CommandContext, input: RestoreApplyInput): Promise<RestoreApplyResult> { return this.restore.applyRestore(context, input); }
  getBackupFile(context: QueryContext, backupId: UUIDv4): Promise<BackupFile> { return this.restore.getBackupFile(context, backupId); }
  recover(): Promise<void> { return this.restore.recover(); }
  migrationSessionBinding(context:CommandContext):string {
    if(context.repository!==this.deps.archive.repository||context.actor.installationId!==context.installationId||context.actor.profilePersonId!==context.ownAccess.personId)throw new WorkbenchHttpError(409,'COMMAND_CONTEXT_MISMATCH','Migration context changed');
    const session=this.deps.archive.sessionId(context);if(!session)throw new WorkbenchHttpError(401,'SESSION_REQUIRED','A local session is required');return session;
  }
  migrationRepositoryBinding(context:CommandContext):string {
    this.migrationSessionBinding(context);return requireArchiveWorkspace(this.deps.archive).repositoryId();
  }
  /** Trusted migration bridge; only its declared inert namespace can supplement the staged copy. */
  async prepareLegacyRestore(context:CommandContext,input:{records:WorkspaceArchiveRecord[];files:WorkspaceArchiveFileSource[]}):Promise<RestorePreviewResult> {
    const archive=this.deps.archive,w=requireArchiveWorkspace(archive),session=this.migrationSessionBinding(context),codec=archive.modules.get('legacy_migration');
    if(!codec||!w.requiredModuleIds.includes('legacy_migration'))throw new WorkbenchHttpError(422,'SCHEMA_UNSUPPORTED','The legacy migration codec is unavailable');
    const snapshot=await snapshotWorkspace(archive),records=new Map(snapshot.records.map(record=>[JSON.stringify([record.moduleId,record.schemaId,record.key]),record])),seen=new Set<string>();
    for(const raw of input.records){const record=archiveRecordSchema.parse(structuredClone(raw)),key=JSON.stringify([record.moduleId,record.schemaId,record.key]);if(record.moduleId!=='legacy_migration'||seen.has(key))throw new WorkbenchHttpError(422,'SCHEMA_UNSUPPORTED','Migration namespace or identity is invalid');seen.add(key);codec.validate(record);records.set(key,record);}
    const files=new Map(snapshot.files.map(file=>[file.path,file]));
    for(const raw of input.files){const bytesValue=new Uint8Array(raw.bytesValue),hash=archiveHash(bytesValue);if(raw.path!=='files/'+hash||!['evidence','original','module'].includes(raw.kind))throw new WorkbenchHttpError(422,'INTEGRITY_MISMATCH','Migration file identity is invalid');const previous=files.get(raw.path);if(previous&&archiveHash(previous.bytesValue)!==hash)throw new WorkbenchHttpError(422,'INTEGRITY_MISMATCH','Migration file conflicts with existing bytes');if(!previous||previous.kind==='original'&&raw.kind!=='original')files.set(raw.path,{path:raw.path,kind:raw.kind,sha256:hash,bytes:bytesValue.length,bytesValue});}
    const values=[...records.values()].sort((a,b)=>JSON.stringify([a.moduleId,a.schemaId,a.key]).localeCompare(JSON.stringify([b.moduleId,b.schemaId,b.key]))),allFiles=[...files.values()].sort((a,b)=>a.path.localeCompare(b.path));
    const manifest=archiveManifestSchema.parse({format:'uor-workspace-v1',version:1,applicationVersion:w.applicationVersion,storageSchemaVersion:w.storageSchemaVersion,createdAt:archive.clock.now(),actor:context.actor,recordsSha256:archiveHash(JSON.stringify(values)),files:allFiles.map(({bytesValue:_bytes,...file})=>file),exclusions:privateExclusions});
    const zip=new JSZip();zip.file('manifest.json',JSON.stringify(manifest));zip.file('records.json',JSON.stringify(values));for(const file of allFiles)zip.file(file.path,file.bytesValue);
    const bytes=await zip.generateAsync({type:'uint8array',compression:'STORE',platform:'DOS'});await validateWorkspaceArchive(bytes,archive.modules,w);
    if(this.migrationSessionBinding(context)!==session)throw new WorkbenchHttpError(409,'PREVIEW_STALE','Migration session changed');
    const uploaded=await archive.files.stage({installationId:context.installationId,profilePersonId:context.ownAccess.personId,purpose:'workspace-restore',name:'migration.zip',mediaType:'application/zip',stream:(async function*(){yield bytes;})()});
    return this.restore.previewRestore(context,{fileHandle:uploaded.fileHandle},snapshot.revision);
  }
  async checkCodeUpdate(context: CommandContext, input: CodeUpdateCheckInput): Promise<CodeUpdateCheckResult> { if (!this.deps.codeUpdate) throw new WorkbenchHttpError(503, 'CODE_UPDATE_UNAVAILABLE', 'Code update lifecycle is unavailable'); return this.deps.codeUpdate.check(context, input); }
  async applyCodeUpdate(context: CommandContext, input: CodeUpdateInput): Promise<CodeUpdateApplyResult> { if (!this.deps.codeUpdate) throw new WorkbenchHttpError(503, 'CODE_UPDATE_UNAVAILABLE', 'Code update lifecycle is unavailable'); return this.deps.codeUpdate.apply(context, input); }
}
