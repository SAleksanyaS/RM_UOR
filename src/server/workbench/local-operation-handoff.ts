import type { Clock } from '../../domain/workbench/primitives';
import type { SqlValue, WorkbenchRepository } from '../storage/workbench-repository';
import { createCommandStore } from './command-store';
import { createJobStore } from './jobs';

const tables = [
 {module:'commands',name:'wb_commands_intents',columns:['installation_id','command_id','name','digest','request_json','phase','accepted_json','receipt_json','recovery_json','owner_scope','owner_person_id']},
 {module:'jobs',name:'wb_jobs_heads',columns:['job_id','installation_id','command_id','name','snapshot_json','irreversible','resource_key']},
 {module:'jobs',name:'wb_jobs_events',columns:['sequence','job_id','snapshot_json','recorded_at']},
 {module:'jobs',name:'wb_jobs_checkpoints',columns:['sequence','job_id','value_json']},
] as const;
declare const localOnly: unique symbol;
export type LocalOperationHandoff = { readonly [localOnly]: true };
const snapshots = new WeakMap<LocalOperationHandoff, SqlValue[][][]>();

/** Local lifecycle bridge, never an archive codec. Only a token captured in this
 * process can be restored. Quiesce must prevent other commands during handoff. */
export function captureLocalOperations(repository:WorkbenchRepository):LocalOperationHandoff {
 const rows=repository.transaction(()=>tables.map(table=>repository.sqlForModule(table.module).all<Record<string,SqlValue>>(`SELECT ${table.columns.join(',')} FROM ${table.name}`).map(row=>table.columns.map(column=>row[column]))));
 const token=Object.freeze({}) as LocalOperationHandoff;snapshots.set(token,rows);return token;
}
/** Copies CURRENT trusted operational rows to an empty staged DB. Domain effects
 * and subsequent receipts still use one SQLite transaction after activation. */
export function restoreLocalOperations(repository:WorkbenchRepository,handoff:LocalOperationHandoff,clock:Clock):void {
 const rows=snapshots.get(handoff);if(!rows)throw Error('Local operation handoff must originate in the current process');
 createCommandStore(repository);createJobStore({repository,clock});
 repository.transaction(()=>{
  for(const table of tables)if(repository.sqlForModule(table.module).get<{count:number}>(`SELECT COUNT(*) AS count FROM ${table.name}`)?.count)throw Error('Local operation target must be empty');
  tables.forEach((table,index)=>{const sql=repository.sqlForModule(table.module);for(const values of rows[index])sql.run(`INSERT INTO ${table.name} (${table.columns.join(',')}) VALUES (${table.columns.map(()=>'?').join(',')})`,values);});
 });
}
