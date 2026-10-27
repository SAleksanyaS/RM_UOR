import type { DatabaseSync } from 'node:sqlite';

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
    `);
    db.prepare('INSERT OR IGNORE INTO wb_schema_migrations(id,applied_at) VALUES(?,?)').run('workbench-core-v1', new Date().toISOString());
    db.prepare('INSERT OR IGNORE INTO wb_schema_migrations(id,applied_at) VALUES(?,?)').run('workbench-evaluation-digest-v1', new Date().toISOString());
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
