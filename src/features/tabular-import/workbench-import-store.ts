import type { Capture, CanonicalSourceRow, RawSourceRow } from '../../domain/workbench/entities';
import type { VersionRef } from '../../domain/workbench/primitives';
import type { WorkbenchRepository } from '../../server/storage/workbench-repository';
import type { FileHandleView } from '../../server/workbench/files';
import { stableJson } from '../../server/workbench/command-store';
import type { ResolvedCaptureBinding } from '../connectors/workbench-source-store';
import type { ImportApplyResult, ImportPreviewResult } from './workbench-import';

export type ImportPreviewRecord = {
  installationId: string; personId: string; goalId: string; file: FileHandleView;
  binding: ResolvedCaptureBinding; basisDigest: string; view: ImportPreviewResult;
  capture: Capture; rawRows: RawSourceRow[]; canonicalRows: CanonicalSourceRow[]; unchangedRowIds: string[]; selectedRowKeys: Record<string,string[]>;
  groupMembership: Record<string,string[]>; validGroupKeys: string[];
};
export type ImportApplied = { selectionDigest: string; result: ImportApplyResult };
export interface ImportStore {
  save(record: ImportPreviewRecord): void;
  read(token: string, installationId: string, personId: string): ImportPreviewRecord | null;
  readApplied(token: string, installationId: string, personId: string): ImportApplied | null;
  findAppliedFile(installationId: string, personId: string, goalId: string, fileHandle: string, configurationRevision: string): ImportPreviewRecord | null;
  complete(token: string, selectionDigest: string, result: ImportApplyResult): void;
  groupRows(installationId: string, sourceId: string, mappingRef: VersionRef, keys: string[]): Record<string,string[]>;
  rememberGroups(record: ImportPreviewRecord, selectedKeys: string[]): void;
}
export function createImportStore({ repository }: { repository: WorkbenchRepository }): ImportStore {
  const sql = repository.sqlForModule('imports');
  sql.execMigration('v1', `CREATE TABLE wb_imports_previews(token TEXT PRIMARY KEY,installation_id TEXT NOT NULL,person_id TEXT NOT NULL,goal_id TEXT NOT NULL,file_handle TEXT NOT NULL,configuration_revision TEXT NOT NULL,value_json TEXT NOT NULL,selection_digest TEXT,result_json TEXT);
    CREATE INDEX wb_imports_owned_file ON wb_imports_previews(installation_id,person_id,goal_id,file_handle,configuration_revision);`);
  sql.execMigration('v2-group-membership', `CREATE TABLE wb_imports_groups(installation_id TEXT NOT NULL,source_id TEXT NOT NULL,mapping_id TEXT NOT NULL,mapping_revision INTEGER NOT NULL,group_key TEXT NOT NULL,members_json TEXT NOT NULL,PRIMARY KEY(installation_id,source_id,mapping_id,mapping_revision,group_key));`);
  const owned = (token: string, installationId: string, personId: string) => sql.get<{ value_json: string; selection_digest: string | null; result_json: string | null }>('SELECT value_json,selection_digest,result_json FROM wb_imports_previews WHERE token=? AND installation_id=? AND person_id=?', [token,installationId,personId]);
  const groupRows = (installationId: string, sourceId: string, mappingRef: VersionRef, keys: string[]): Record<string,string[]> => {
    const result:Record<string,string[]>={};
    for(let offset=0;offset<keys.length;offset+=200) {
      const chunk=keys.slice(offset,offset+200);
      const rows=sql.all<{group_key:string;members_json:string}>(`SELECT group_key,members_json FROM wb_imports_groups WHERE installation_id=? AND source_id=? AND mapping_id=? AND mapping_revision=? AND group_key IN (${chunk.map(()=>'?').join(',')})`, [installationId,sourceId,mappingRef.id,mappingRef.revision,...chunk]);
      for(const row of rows)result[row.group_key]=JSON.parse(row.members_json) as string[];
    }
    return result;
  };
  return {
    save(record) { sql.run('INSERT INTO wb_imports_previews(token,installation_id,person_id,goal_id,file_handle,configuration_revision,value_json) VALUES(?,?,?,?,?,?,?)', [record.view.previewToken,record.installationId,record.personId,record.goalId,record.file.fileHandle,record.binding.configurationRevision,stableJson(record)]); },
    read(token, installationId, personId) { const row = owned(token,installationId,personId); return row ? JSON.parse(row.value_json) as ImportPreviewRecord : null; },
    readApplied(token, installationId, personId) { const row = owned(token,installationId,personId); return row?.result_json && row.selection_digest ? { selectionDigest: row.selection_digest, result: JSON.parse(row.result_json) as ImportApplyResult } : null; },
    findAppliedFile(installationId, personId, goalId, fileHandle, configurationRevision) { const row = sql.get<{ value_json: string }>('SELECT value_json FROM wb_imports_previews WHERE installation_id=? AND person_id=? AND goal_id=? AND file_handle=? AND configuration_revision=? AND result_json IS NOT NULL ORDER BY rowid DESC LIMIT 1', [installationId,personId,goalId,fileHandle,configurationRevision]); return row ? JSON.parse(row.value_json) as ImportPreviewRecord : null; },
    complete(token, selectionDigest, result) { sql.run('UPDATE wb_imports_previews SET selection_digest=?,result_json=? WHERE token=? AND result_json IS NULL', [selectionDigest,stableJson(result),token]); },
    groupRows,
    rememberGroups(record,selectedKeys) {
      const previous=groupRows(record.installationId,record.binding.source.id,record.binding.mappingRef,Object.keys(record.groupMembership));
      for(const [key,members] of Object.entries(record.groupMembership)) {
        if(!selectedKeys.includes(key)&&record.validGroupKeys.includes(key))continue;
        const next=selectedKeys.includes(key)?members:[...new Set([...(previous[key]??[]),...members])].sort();
        sql.run('INSERT OR REPLACE INTO wb_imports_groups VALUES(?,?,?,?,?,?)', [record.installationId,record.binding.source.id,record.binding.mappingRef.id,record.binding.mappingRef.revision,key,JSON.stringify(next)]);
      }
    },
  };
}
