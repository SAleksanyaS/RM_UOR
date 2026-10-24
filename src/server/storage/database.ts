import { DatabaseSync } from 'node:sqlite';

export class LocalDatabase {
  private readonly db: DatabaseSync;
  constructor(filename: string) {
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS records (namespace TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(namespace,id));');
  }
  get<T>(namespace: string, id: string): T | null {
    const row = this.db.prepare('SELECT value FROM records WHERE namespace = ? AND id = ?').get(namespace, id) as { value: string } | undefined;
    return row ? JSON.parse(row.value) as T : null;
  }
  list<T>(namespace: string): T[] {
    return (this.db.prepare('SELECT value FROM records WHERE namespace = ? ORDER BY id').all(namespace) as { value: string }[]).map(r => JSON.parse(r.value) as T);
  }
  set<T>(namespace: string, id: string, value: T): void {
    this.db.prepare('INSERT INTO records(namespace,id,value) VALUES(?,?,?) ON CONFLICT(namespace,id) DO UPDATE SET value=excluded.value').run(namespace, id, JSON.stringify(value));
  }
  remove(namespace: string, id: string): void { this.db.prepare('DELETE FROM records WHERE namespace=? AND id=?').run(namespace, id); }
  transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close() { this.db.close(); }
}
