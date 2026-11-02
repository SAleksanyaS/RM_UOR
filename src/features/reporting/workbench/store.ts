import type { WorkbenchRepository } from '../../../server/storage/workbench-repository';
import { reportSnapshotSchema, type ReportSnapshot } from './contracts';
export function createReportStore(repository: WorkbenchRepository) {
    const sql = repository.sqlForModule('reporting');
    sql.execMigration('001', 'CREATE TABLE wb_reporting_snapshots(id TEXT NOT NULL,revision INTEGER NOT NULL,person_id TEXT NOT NULL,installation_id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(id,revision))');
    return {
        latest: (personId: string, installationId: string) => sql.all<{
            id: string;
            revision: number;
            title: string;
            period: string;
            createdAt: string;
        }>(`SELECT s.id,s.revision,json_extract(s.payload,'$.definition.title') AS title,json_extract(s.payload,'$.definition.period') AS period,json_extract(s.payload,'$.createdAt') AS createdAt FROM wb_reporting_snapshots s WHERE s.person_id=? AND s.installation_id=? AND s.revision=(SELECT MAX(v.revision) FROM wb_reporting_snapshots v WHERE v.id=s.id) ORDER BY createdAt DESC,s.id LIMIT 200`, [personId, installationId]),
        all: () => sql.all<{
            payload: string;
        }>('SELECT payload FROM wb_reporting_snapshots ORDER BY id,revision').map(r => reportSnapshotSchema.parse(JSON.parse(r.payload))),
        read: (id: string, revision?: number) => { const row = revision === undefined ? sql.get<{
            payload: string;
        }>('SELECT payload FROM wb_reporting_snapshots WHERE id=? ORDER BY revision DESC LIMIT 1', [id]) : sql.get<{
            payload: string;
        }>('SELECT payload FROM wb_reporting_snapshots WHERE id=? AND revision=?', [id, revision]); return row ? reportSnapshotSchema.parse(JSON.parse(row.payload)) : null; },
        owner: (id: string) => sql.get<{
            person_id: string;
            installation_id: string;
        }>('SELECT person_id,installation_id FROM wb_reporting_snapshots WHERE id=? LIMIT 1', [id]),
        insert: (value: ReportSnapshot, installationId = value.installationId) => { const v = reportSnapshotSchema.parse(value); sql.run('INSERT INTO wb_reporting_snapshots VALUES(?,?,?,?,?)', [v.id, v.revision, v.ownerPersonId, installationId, JSON.stringify(v)]); },
    };
}
