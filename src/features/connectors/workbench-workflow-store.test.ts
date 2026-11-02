import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { createWorkbenchRepository } from '../../server/storage/workbench-repository';
import { createOkoWorkflowStore } from './workbench-workflow-store';
describe('own OKO durable store', () => {
  it('checks one exact result metadata key without deserializing any artifact payload',()=>{
    const repository=createWorkbenchRepository({filename:':memory:',artifactRoot:tmpdir()});try{const store=createOkoWorkflowStore(repository),owner=randomUUID(),id=randomUUID();repository.sqlForModule('oko_workflow').run('INSERT INTO wb_oko_workflow_results VALUES(?,?,?)',[owner,id,'malformed selected artifact payload']);expect(store.hasResult(owner,id)).toBe(true);expect(store.hasResult(randomUUID(),id)).toBe(false);expect(store.hasResult(owner,randomUUID())).toBe(false);}finally{repository.close();}
  });
  it('uses real SQLite owner filtering and revision CAS', () => {
    const repository = createWorkbenchRepository({ filename: ':memory:', artifactRoot: tmpdir() });
    try {
      const store = createOkoWorkflowStore(repository), id = randomUUID(), owner = randomUUID();
      store.save(owner, id, null, { revision: '1', title: 'Private' });
      expect(store.get(owner, id)).toEqual({ revision: '1', title: 'Private' });
      expect(store.get(randomUUID(), id)).toBeNull();
      expect(() => store.save(owner, id, 'stale', { revision: '2' })).toThrow();
      expect(store.get(owner, id)).toEqual({ revision: '1', title: 'Private' });
      store.save(owner, id, '1', { revision: '2', title: 'Updated' });
      expect(store.list(owner)).toHaveLength(1);
    } finally { repository.close(); }
  });
  it('lists own raw exports newest first, keeps hidden bytes and never leaks a foreign owner', () => {
    const repository = createWorkbenchRepository({ filename: ':memory:', artifactRoot: tmpdir() });
    try {
      const store = createOkoWorkflowStore(repository), owner = randomUUID(), other = randomUUID(), workflowId = randomUUID();
      const meta = (id: string, capturedAt: string) => ({ id, workflowId, title: 'Отчёт', fileName: `ОКО_Отчёт_${capturedAt.slice(0, 10)}_${capturedAt.slice(11, 16).replace(':', '-')}.csv`, mimeType: 'text/csv', bytes: 6, sha256: 'a'.repeat(64), capturedAt, sourceDate: null, rowCount: null, origin: 'record', deletedAt: null });
      const first = meta(randomUUID(), '2026-10-28T10:00:00Z'), second = meta(randomUUID(), '2026-10-29T10:00:00Z');
      store.putExport(owner, first, { artifact: { base64: 'QQ==' } });
      store.putExport(owner, second, { artifact: { base64: 'Qg==' } });
      expect(store.listExports(owner).map(item => item.id)).toEqual([second.id, first.id]);
      expect(store.listExports(owner, { workflowId })).toHaveLength(2);
      expect(store.listExports(owner, { workflowId: randomUUID() })).toEqual([]);
      // A retried download never replaces the bytes already stored for that id.
      expect(()=>store.putExport(owner, { ...first, fileName: 'replaced.csv' }, { artifact: { base64: 'Qw==' } })).toThrow(/EXPORT_CONFLICT/);
      expect(store.getExport<{ artifact: { base64: string } }>(owner, first.id)!.payload.artifact.base64).toBe('QQ==');
      expect(store.getExport<{ artifact: unknown }>(owner, first.id)!.meta.fileName).toBe(first.fileName);
      expect(store.getExport(other, first.id)).toBeNull();
      expect(store.hasExport(other, first.id)).toBe(false);
      expect(store.markExportDeleted(other, first.id, '2026-10-30T00:00:00Z')).toBe(false);
      expect(store.markExportDeleted(owner, first.id, '2026-10-30T00:00:00Z')).toBe(true);
      expect(store.listExports(owner).map(item => item.id)).toEqual([second.id]);
      expect(store.countHiddenExports(owner)).toBe(1);
      expect(store.countHiddenExports(other)).toBe(0);
      // "Скрывать из списка" is a soft delete: the stored bytes stay readable.
      expect(store.getExport<{ artifact: { base64: string } }>(owner, first.id)!.payload.artifact.base64).toBe('QQ==');
      expect(store.unhideExport(owner, first.id)).toBe(true);
      expect(store.listExports(owner).map(item => item.id)).toEqual([second.id, first.id]);
      store.updateExportOutcome(owner, second.id, { rowCount: 2, sourceDate: '2026-10-28' });
      expect(store.getExport<unknown>(owner, second.id)!.meta).toMatchObject({ rowCount: 2, sourceDate: '2026-10-28' });
      expect(store.getExport<unknown>(owner, first.id)!.meta.rowCount).toBeNull();
    } finally { repository.close(); }
  });
});
