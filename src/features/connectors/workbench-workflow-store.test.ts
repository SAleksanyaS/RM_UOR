import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createWorkbenchRepository } from '../../server/storage/workbench-repository';
import { createOkoWorkflowStore } from './workbench-workflow-store';
describe('own OKO durable store', () => {
  it('uses real SQLite owner filtering and revision CAS', () => {
    const repository = createWorkbenchRepository({ filename: ':memory:', artifactRoot: process.env.TEMP! });
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
