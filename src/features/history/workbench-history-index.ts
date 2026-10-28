import type { Capture, EvaluationBasis, ObservedFact, AgreedSnapshot } from '../../domain/workbench/entities';
import type { Header } from '../../domain/workbench/primitives';
import type { WorkbenchRepository, WorkbenchSql } from '../../server/storage/workbench-repository';
export const historyIndexDdl = `
CREATE TABLE IF NOT EXISTS wb_history_observations(id TEXT NOT NULL,revision INTEGER NOT NULL,source_id TEXT NOT NULL,metric_id TEXT NOT NULL,scope_kind TEXT NOT NULL,scope_id TEXT NOT NULL,business_start TEXT,business_end TEXT,captured_at TEXT NOT NULL,payload_ref TEXT NOT NULL,PRIMARY KEY(id,revision));
CREATE INDEX IF NOT EXISTS wb_history_scope_time ON wb_history_observations(source_id,metric_id,scope_kind,scope_id,business_start,captured_at,id,revision);
CREATE TABLE IF NOT EXISTS wb_history_snapshots(id TEXT NOT NULL,revision INTEGER NOT NULL,assignment_id TEXT NOT NULL,business_start TEXT,basis_id TEXT NOT NULL,basis_revision INTEGER NOT NULL,PRIMARY KEY(id,revision));
CREATE INDEX IF NOT EXISTS wb_history_snapshot_assignment_time ON wb_history_snapshots(assignment_id,business_start,id,revision);`;
const installed = new WeakSet<WorkbenchRepository>();
export function installHistoryIndex(repository: WorkbenchRepository): void {
    if (installed.has(repository))
        return;
    const sql = repository.sqlForModule('history');
    sql.execMigration('index-v1', historyIndexDdl);
    repository.registerProjection('history', (type, value) => {
        const capture = type === 'observed_fact' ? repository.getHead<Capture>({ entityType: 'capture', id: (value as ObservedFact).captureId }) : null;
        const basis = type === 'agreed_snapshot' ? repository.readVersion<EvaluationBasis>((value as AgreedSnapshot).basisRef) : null;
        indexHistoryVersion(sql, type, value, { capture, basis });
    });
    installed.add(repository);
}
export function indexHistoryVersion(sql: WorkbenchSql, type: string, value: Header, context: {
    capture: Capture | null;
    basis: EvaluationBasis | null;
}): void {
    if (type === 'observed_fact' && context.capture) {
        const f = value as ObservedFact;
        const t = f.businessTime;
        sql.run('INSERT OR IGNORE INTO wb_history_observations VALUES(?,?,?,?,?,?,?,?,?,?)', [f.id, f.revision, f.sourceId, f.metricId, f.scope.kind, f.scope.id, t.kind === 'as_of' ? t.date : t.kind === 'period' ? t.startInclusive : null, t.kind === 'period' ? t.endExclusive : null, new Date(context.capture.capturedAt).toISOString(), JSON.stringify({ entityType: 'observed_fact', id: f.id, revision: f.revision })]);
    }
    else if (type === 'agreed_snapshot' && context.basis) {
        const b = context.basis;
        const t = b.businessTime;
        const s = value as AgreedSnapshot;
        sql.run('INSERT OR IGNORE INTO wb_history_snapshots VALUES(?,?,?,?,?,?)', [s.id, s.revision, b.assignmentRef.id, t.kind === 'as_of' ? t.date : t.kind === 'period' ? t.startInclusive : null, s.basisRef.id, s.basisRef.revision]);
    }
}
