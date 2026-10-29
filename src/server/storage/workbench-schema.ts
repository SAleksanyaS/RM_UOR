import type { DatabaseSync } from 'node:sqlite';
import { historyIndexDdl } from '../../features/history/workbench-history-index';

/** Separate schema: never updates or replaces legacy records. */
export function migrateWorkbench(db: DatabaseSync): void {
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS wb_schema_migrations(id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS wb_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT OR IGNORE INTO wb_meta(key,value) VALUES('state_revision','0');
      CREATE TABLE IF NOT EXISTS wb_entity_versions(
        entity_type TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>=1),
        payload_json TEXT NOT NULL,recorded_at TEXT NOT NULL,publication_anchor_id TEXT,
        PRIMARY KEY(entity_type,id,revision));
      CREATE TABLE IF NOT EXISTS wb_entity_heads(entity_type TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,
        PRIMARY KEY(entity_type,id), FOREIGN KEY(entity_type,id,revision) REFERENCES wb_entity_versions(entity_type,id,revision));
      CREATE TABLE IF NOT EXISTS wb_publication_anchors(id TEXT NOT NULL,revision INTEGER NOT NULL,
        payload_json TEXT NOT NULL,publication_state TEXT NOT NULL,merged_at TEXT,PRIMARY KEY(id,revision));
      CREATE TABLE IF NOT EXISTS wb_fact_index(entity_type TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,
        source_id TEXT NOT NULL,metric_id TEXT NOT NULL,scope_kind TEXT NOT NULL,scope_id TEXT NOT NULL,
        business_kind TEXT NOT NULL,business_start TEXT,business_end TEXT,capture_id TEXT NOT NULL,fact_key TEXT NOT NULL,
        PRIMARY KEY(entity_type,id,revision));
      CREATE TABLE IF NOT EXISTS wb_capture_index(id TEXT NOT NULL,revision INTEGER NOT NULL,captured_at TEXT NOT NULL,
        PRIMARY KEY(id,revision));
      CREATE TABLE IF NOT EXISTS wb_applicability_index(id TEXT NOT NULL,revision INTEGER NOT NULL,
        assignment_id TEXT NOT NULL,metric_id TEXT NOT NULL,start_date TEXT NOT NULL,end_date TEXT,PRIMARY KEY(id,revision));
      CREATE TABLE IF NOT EXISTS wb_correction_index(id TEXT NOT NULL,revision INTEGER NOT NULL,fact_key TEXT NOT NULL,PRIMARY KEY(id,revision));
      CREATE TABLE IF NOT EXISTS wb_evaluation_digest(digest TEXT PRIMARY KEY,basis_id TEXT NOT NULL,basis_revision INTEGER NOT NULL,result_id TEXT,result_revision INTEGER,
        CHECK((result_id IS NULL)=(result_revision IS NULL)));
      CREATE INDEX IF NOT EXISTS wb_fact_scope_time ON wb_fact_index(source_id,metric_id,scope_kind,scope_id,business_kind,business_start,business_end);
      CREATE INDEX IF NOT EXISTS wb_capture_time ON wb_capture_index(captured_at,id);
      CREATE INDEX IF NOT EXISTS wb_fact_key ON wb_fact_index(fact_key);
      CREATE INDEX IF NOT EXISTS wb_applicability_assignment ON wb_applicability_index(assignment_id,metric_id,start_date);
      CREATE INDEX IF NOT EXISTS wb_correction_fact_key ON wb_correction_index(fact_key);
      CREATE INDEX IF NOT EXISTS wb_versions_anchor ON wb_entity_versions(publication_anchor_id,entity_type,id,revision);
      CREATE INDEX IF NOT EXISTS wb_manual_assignment_current ON wb_entity_versions(json_extract(payload_json,'$.assignmentId'),recorded_at) WHERE entity_type='manual_status_event';
      CREATE INDEX IF NOT EXISTS wb_evidence_artifact ON wb_entity_versions(json_extract(payload_json,'$.file.artifactId')) WHERE entity_type='evidence';
    `);
    db.prepare('INSERT OR IGNORE INTO wb_schema_migrations(id,applied_at) VALUES(?,?)').run('workbench-core-v1', new Date().toISOString());
    db.prepare('INSERT OR IGNORE INTO wb_schema_migrations(id,applied_at) VALUES(?,?)').run('workbench-evaluation-digest-v1', new Date().toISOString());
    // The repository owns the only historical scan: one durable migration, never an online query.
    if (!db.prepare('SELECT id FROM wb_schema_migrations WHERE id=?').get('workbench-history-backfill-v1')) {
      db.exec(historyIndexDdl);
      db.exec(`INSERT OR IGNORE INTO wb_history_observations
        SELECT f.id,f.revision,json_extract(f.payload_json,'$.sourceId'),json_extract(f.payload_json,'$.metricId'),
        json_extract(f.payload_json,'$.scope.kind'),json_extract(f.payload_json,'$.scope.id'),
        COALESCE(json_extract(f.payload_json,'$.businessTime.date'),json_extract(f.payload_json,'$.businessTime.startInclusive')),
        json_extract(f.payload_json,'$.businessTime.endExclusive'),strftime('%Y-%m-%dT%H:%M:%fZ',json_extract(c.payload_json,'$.capturedAt')),
        json_object('entityType','observed_fact','id',f.id,'revision',f.revision)
        FROM wb_entity_versions f JOIN wb_entity_versions c ON c.entity_type='capture' AND c.id=json_extract(f.payload_json,'$.captureId') AND c.revision=1
        WHERE f.entity_type='observed_fact';
        INSERT OR IGNORE INTO wb_history_snapshots
        SELECT s.id,s.revision,json_extract(b.payload_json,'$.assignmentRef.id'),
        COALESCE(json_extract(b.payload_json,'$.businessTime.date'),json_extract(b.payload_json,'$.businessTime.startInclusive')),
        b.id,b.revision FROM wb_entity_versions s JOIN wb_entity_versions b ON b.entity_type='evaluation_basis'
        AND b.id=json_extract(s.payload_json,'$.basisRef.id') AND b.revision=json_extract(s.payload_json,'$.basisRef.revision') WHERE s.entity_type='agreed_snapshot';`);
      db.prepare('INSERT INTO wb_schema_migrations VALUES(?,?)').run('workbench-history-backfill-v1',new Date().toISOString());
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
