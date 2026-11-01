import { AsyncLocalStorage } from 'node:async_hooks';
import { WorkbenchError } from '../../domain/workbench/errors';
import type { WorkbenchRepository, WorkbenchSql } from './workbench-repository';

type Lease = { active: boolean; parent?: Lease };
type Migration = { moduleId: string; options?: { trackStateRevision?: boolean }; id: string; ddl: string };
/** Stable runtime identity. Only the lifecycle owner may switch a fully prepared native repository.
 * Construct every service/projection with this facade, not its native repository. SQL handles and
 * captured methods follow the active root. This does not copy subject data, local operations or
 * files, rebuild projections, authorize a restore, or close the old native repository.
 */
export function createStableWorkbenchRepository(initial: WorkbenchRepository): { repository: WorkbenchRepository; rebind(next: WorkbenchRepository): void } {
  let active = initial, closed = false, depth = 0;
  const leases = new AsyncLocalStorage<Lease>();
  const migrations = new Map<string, Migration>();
  const registrations = new Map<string, (candidate: WorkbenchRepository) => void>();
  const projections = new Map<string, Parameters<WorkbenchRepository['registerProjection']>[1]>();
  const catalogProjections = new Map<string, Parameters<WorkbenchRepository['registerCatalogProjection']>[1]>();
  const methods = new Map<PropertyKey, unknown>();
  const assertOpen = () => { if (closed) throw new WorkbenchError('REPOSITORY_CLOSED'); };
  const assertLease = () => {
    assertOpen();
    for (let lease = leases.getStore(); lease; lease = lease.parent) if (!lease.active) throw new WorkbenchError('TRANSACTION_CONTEXT_CLOSED');
  };
  const assertQuiescent = () => { assertLease(); if (depth) throw new Error('TRANSACTION_ACTIVE'); };
  const special: Pick<WorkbenchRepository, 'transaction' | 'sqlForModule' | 'registerEntityType' | 'registerProjection' | 'registerCatalogProjection' | 'close'> = {
    transaction(action) {
      assertLease();
      const lease: Lease = { active: true, parent: leases.getStore() }; depth++;
      try { return leases.run(lease, () => active.transaction(action)); }
      finally { lease.active = false; depth--; }
    },
    sqlForModule(moduleId, options) {
      assertOpen();
      const copiedOptions = options ? { ...options } : undefined;
      // Validate the module and options now; each call below resolves the current native handle.
      active.sqlForModule(moduleId, copiedOptions);
      const sql = () => { assertOpen(); return active.sqlForModule(moduleId, copiedOptions); };
      const result: WorkbenchSql = {
        get(query, params) { return sql().get(query, params); },
        all(query, params) { return sql().all(query, params); },
        run(query, params) { assertLease(); return sql().run(query, params); },
        execMigration(id, ddl) {
          assertLease(); sql().execMigration(id, ddl);
          migrations.set(JSON.stringify([moduleId, id]), { moduleId, options: copiedOptions, id, ddl });
        },
      };
      return result;
    },
    registerEntityType(type, registration) {
      assertLease(); active.registerEntityType(type, registration);
      registrations.set(type, candidate => candidate.registerEntityType(type, registration));
    },
    registerProjection(name, project) { assertLease(); active.registerProjection(name, project); projections.set(name, project); },
    registerCatalogProjection(name, project) { assertLease(); active.registerCatalogProjection(name, project); catalogProjections.set(name, project); },
    close() { if (closed) return; assertQuiescent(); active.close(); closed = true; },
  };
  const writes = new Set<PropertyKey>(['append', 'importPublishedVersion', 'restoreWorkspaceCore', 'appendPublicationAnchor']);
  const repository = new Proxy(initial, {
    get(_target, key) {
      if (Object.hasOwn(special, key)) return special[key as keyof typeof special];
      if (methods.has(key)) return methods.get(key);
      const value = Reflect.get(active, key);
      if (typeof value !== 'function') return value;
      const invoke = (...args: unknown[]) => {
        assertOpen(); if (writes.has(key)) assertLease();
        return Reflect.apply(Reflect.get(active, key), active, args);
      };
      methods.set(key, invoke); return invoke;
    },
  });
  return {
    repository,
    rebind(next) {
      assertQuiescent();
      if (next === repository) throw new Error('Cannot bind the facade to itself');
      if (next === active) return;
      // Prepare without exposing a partially initialized candidate through existing readers.
      for (const register of registrations.values()) register(next);
      for (const { moduleId, options, id, ddl } of migrations.values()) next.sqlForModule(moduleId, options).execMigration(id, ddl);
      for (const [name, project] of projections) next.registerProjection(name, project);
      for (const [name, project] of catalogProjections) next.registerCatalogProjection(name, project);
      active = next;
    },
  };
}
