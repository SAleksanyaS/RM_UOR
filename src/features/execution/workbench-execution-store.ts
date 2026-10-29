import type { Work } from '../../domain/workbench/entities';
import type { VersionRef } from '../../domain/workbench/primitives';
import type { WorkbenchRepository } from '../../server/storage/workbench-repository';

export type WorkCompletionEvent = { workRef: VersionRef; recordedAt: string; resultDescription: string; actor: Work['actor'] };
export function createExecutionStore({ repository }: { repository: WorkbenchRepository }) {
  const sql = repository.sqlForModule('execution');
  sql.execMigration('v1-work-completions', 'CREATE TABLE wb_execution_completions(package_id TEXT NOT NULL,work_id TEXT NOT NULL,revision INTEGER NOT NULL,payload_json TEXT NOT NULL,PRIMARY KEY(package_id,work_id,revision));');
  return {
    readPublishedGraph: repository.readPublishedExecutionGraph,
    recordCompletion(packageId: string, value: Work) {
      const event: WorkCompletionEvent = { workRef: { entityType: 'work', id: value.id, revision: value.revision }, recordedAt: value.recordedAt, resultDescription: value.resultDescription!, actor: value.actor };
      sql.run('INSERT OR IGNORE INTO wb_execution_completions VALUES(?,?,?,?)', [packageId, value.id, value.revision, JSON.stringify(event)]);
    },
    completionEvents(packageId: string, workId: string): WorkCompletionEvent[] { return sql.all<{ payload_json: string }>('SELECT payload_json FROM wb_execution_completions WHERE package_id=? AND work_id=? ORDER BY revision', [packageId, workId]).map(r => JSON.parse(r.payload_json)); },
  };
}
export type ExecutionStore = ReturnType<typeof createExecutionStore>;
