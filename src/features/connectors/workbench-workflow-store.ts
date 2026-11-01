import type { WorkbenchRepository } from '../../server/storage/workbench-repository';
import { WorkbenchHttpError } from '../../server/workbench/protocol';
/** Private installation/person drafts: no portable entity headers or published heads. */
export function createOkoWorkflowStore(repository: WorkbenchRepository) {
    const sql = repository.sqlForModule('oko_workflow');
    sql.execMigration('v1', `CREATE TABLE wb_oko_workflow_drafts(owner TEXT NOT NULL,id TEXT NOT NULL,revision TEXT NOT NULL,payload_json TEXT NOT NULL,PRIMARY KEY(owner,id));
    CREATE TABLE wb_oko_workflow_results(owner TEXT NOT NULL,id TEXT NOT NULL,payload_json TEXT NOT NULL,PRIMARY KEY(owner,id))`);
    sql.execMigration('v2-original-omissions','CREATE TABLE wb_oko_workflow_original_omissions(file_key TEXT PRIMARY KEY,sha256 TEXT NOT NULL,bytes INTEGER NOT NULL)');
    return {
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
        putResult(owner: string, id: string, value: unknown) { sql.run('INSERT INTO wb_oko_workflow_results(owner,id,payload_json) VALUES(?,?,?)', [owner, id, JSON.stringify(value)]); },
        hasResult(owner:string,id:string):boolean { return sql.get('SELECT 1 FROM wb_oko_workflow_results WHERE owner=? AND id=?',[owner,id])!==null; },
        getResult<T>(owner: string, id: string): T | null { const row = sql.get<{
            payload_json: string;
        }>('SELECT payload_json FROM wb_oko_workflow_results WHERE owner=? AND id=?', [owner, id]); return row ? JSON.parse(row.payload_json) as T : null; },
        originalOmitted(owner:string,id:string):boolean { return sql.get('SELECT r.id FROM wb_oko_workflow_results r JOIN wb_oko_workflow_original_omissions o ON o.file_key=r.id WHERE r.owner=? AND r.id=?',[owner,id])!==null; },
    };
}
