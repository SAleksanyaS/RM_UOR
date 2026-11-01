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
});
