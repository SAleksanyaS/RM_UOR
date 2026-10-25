import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, renameSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

export class LocalDatabase {
  private db: DatabaseSync;
  constructor(private readonly filename: string) {
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS records (namespace TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(namespace,id));');
  }
  /** SQLite creates a consistent standalone copy, including committed WAL pages. */
  snapshot(destination: string): void { this.db.prepare('VACUUM INTO ?').run(destination); }
  integrity(): string { return String((this.db.prepare('PRAGMA integrity_check').get() as Record<string,unknown>).integrity_check); }
  /** The caller must hold the application maintenance gate and validate this file first. */
  replaceFrom(filename: string): void {
    const suffix=randomUUID(),temporary=`${this.filename}.restore-${suffix}`,previous=`${this.filename}.before-${suffix}`;
    copyFileSync(filename,temporary); this.db.close();let moved=false,replaced=false;
    try { renameSync(this.filename,previous);moved=true;renameSync(temporary,this.filename);replaced=true;
      this.db=new DatabaseSync(this.filename);this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
      if(this.integrity()!=='ok')throw new Error('Восстановленная база не прошла проверку целостности');
      unlinkSync(previous);
    } catch(error) { try{if(replaced){try{this.db.close();}catch{}unlinkSync(this.filename);}if(moved)renameSync(previous,this.filename);this.db=new DatabaseSync(this.filename);this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');}catch(rollbackError){throw new AggregateError([error,rollbackError],'Не удалось открыть исходную базу после ошибки замены');}
      throw error;
    } finally {try{unlinkSync(temporary);}catch{}}
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
  clear(namespace:string):void{this.db.prepare('DELETE FROM records WHERE namespace=?').run(namespace);}
  counts(): Record<string,number> { return Object.fromEntries((this.db.prepare('SELECT namespace,COUNT(*) AS count FROM records GROUP BY namespace').all() as {namespace:string;count:number}[]).map(row=>[row.namespace,row.count])); }
  transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close() { this.db.close(); }
}
