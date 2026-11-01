import { useEffect, useRef, useState } from 'react';
import { useWorkbench, useWorkbenchQuery } from '../../../app/workbench/context';
import type { CommandResult, QueryRequest } from '../../../server/workbench/protocol';
import type { GoalReadRow, WorkbenchReadModels } from '../../catalog/workbench-read-models';

type GoalQuery = 'overview' | 'goals.list' | 'goals.detail';
function rowsFrom(data: WorkbenchReadModels[GoalQuery]): GoalReadRow[] { return 'goals' in data ? data.goals : 'rows' in data ? data.rows : data.items; }
/** The only loading-stage write is the server's idempotent derived calculation.
 * It cannot capture facts, confirm a result, save history or publish anything. */
export function useGoalRead<K extends GoalQuery>(name: K, request: QueryRequest | null) {
  const query = useWorkbenchQuery<WorkbenchReadModels[K]>(name, request);
  const { client, session } = useWorkbench();
  const key = JSON.stringify([name, request]);
  const attempts = useRef(new Map<string, { client: typeof client; work: Promise<unknown> }>());
  const owner = useRef({ client, personId: session?.personId, role: session?.role, blockedResponse: query.response });
  if (owner.current.client !== client || owner.current.personId !== session?.personId || owner.current.role !== session?.role) {
    // A hook's previous render can still contain the preceding client's data
    // until its effect clears it. Never use that transitional model for writes.
    owner.current = { client, personId: session?.personId, role: session?.role, blockedResponse: query.response };
  }
  const obsoleteOwner = query.data !== null && query.response === owner.current.blockedResponse;
  const [prepared, setPrepared] = useState<{ key: string; source: unknown; data: WorkbenchReadModels[K] | null; loading: boolean; error: unknown; errorOperation: 'read' | 'mutation' } | null>(null);
  useEffect(() => {
    const source = query.data;
    if (obsoleteOwner || !request || request.context.resultMode !== 'current' || !source) return;
    const missing = rowsFrom(source).filter(row => row.needs_calculation && !row.unavailableReason);
    if (!missing.length) return;
    const controller = new AbortController(); let active = true;
    let errorOperation: 'read' | 'mutation' = 'mutation';
    setPrepared({ key, source, data: source, loading: true, error: null, errorOperation });
    void (async () => {
      for (let row of missing) {
        if (!active) return;
        // Pending and unknown operations keep one identity across unrelated
        // repository changes. A rejected unknown outcome is never auto-retried.
        const identity = JSON.stringify([session?.personId, session?.role, request.context.time, row.ref.id]);
        let attempt = attempts.current.get(identity);
        if (attempt?.client === client) {
          errorOperation = 'mutation';
          await attempt.work;
          if (!active) return;
          // Only a known successful operation may be superseded. Read again
          // after it finishes: an earlier response may predate its commit.
          errorOperation = 'read';
          const fresh = await client.query<WorkbenchReadModels[K]>(name, request, { signal: controller.signal });
          if (!active) return;
          const current = rowsFrom(fresh.data).find(item => item.ref.id === row.ref.id);
          if (!current?.needs_calculation || current.unavailableReason) continue;
          row = current; attempt = undefined;
        }
        if (!attempt || attempt.client !== client) {
          errorOperation = 'mutation';
          const commandId = crypto.randomUUID();
          const work = client.command<CommandResult>({ commandId, name: 'calculation.prepare', baseRevision: null, payload: { assignmentRef: row.ref, businessTime: request.context.time } }).then(response => { if ('jobId' in response.data) throw Error('Calculation requires a synchronous receipt'); });
          attempt = { client, work }; attempts.current.set(identity, attempt);
        }
        await attempt.work;
      }
      if (!active) return;
      errorOperation = 'read';
      const response = await client.query<WorkbenchReadModels[K]>(name, request, { signal: controller.signal });
      if (active) setPrepared({ key, source, data: response.data, loading: false, error: null, errorOperation });
    })().catch(error => { if (active) setPrepared({ key, source, data: source, loading: false, error, errorOperation }); });
    return () => { active = false; controller.abort(); };
  }, [client, key, query.data, obsoleteOwner, session?.personId, session?.role]);
  if (obsoleteOwner) return { ...query, data: null, response: null, loading: true, error: null, errorOperation: 'read' as const };
  return prepared?.key === key && prepared.source === query.data ? { ...query, data: prepared.data, loading: prepared.loading, error: prepared.error, errorOperation: prepared.errorOperation } : { ...query, errorOperation: 'read' as const };
}
