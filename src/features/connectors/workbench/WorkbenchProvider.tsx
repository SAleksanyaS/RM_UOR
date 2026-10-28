import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { JobSnapshot, SessionView } from '../../../server/workbench/protocol';
import type { OkoWorkspaceView, OkoWorkflowView } from '../workbench-workflow-contracts';
import { OkoClient, OkoClientError } from './client';

type Workspace = { client: OkoClient; session: SessionView | null; workspace: OkoWorkspaceView | null; current: OkoWorkflowView | null; loading: boolean; busy: boolean; error: string; job: JobSnapshot | null; refresh(): Promise<void>; open(id?: string, title?: string): Promise<void>; run(name: string, payload: Record<string, unknown>): Promise<unknown>; select(id: string): Promise<void>; clearError(): void };
const Context = createContext<Workspace | null>(null);
const defaultClient = new OkoClient();
const pendingKey = 'uor.oko.pending-job.v1';
type PendingJob = { personId: string | null; workflowId: string; jobId: string; kind: 'marker' | 'replay' };
const ownJobKey = (value: Pick<PendingJob, 'personId' | 'workflowId'>) => `${pendingKey}:${value.personId ?? 'unassigned'}:${value.workflowId}`;
function readPending(): PendingJob | null { try { const pointer = JSON.parse(sessionStorage.getItem(pendingKey) ?? 'null'); if (!pointer || typeof pointer.workflowId !== 'string' || !(typeof pointer.personId === 'string' || pointer.personId === null)) return null; const value = JSON.parse(sessionStorage.getItem(ownJobKey(pointer)) ?? 'null'); return value && value.workflowId === pointer.workflowId && value.personId === pointer.personId && typeof value.jobId === 'string' && ['marker', 'replay'].includes(value.kind) ? value : null; } catch { return null; } }
function rememberPending(value: PendingJob | null) { try { if (value) { sessionStorage.setItem(ownJobKey(value), JSON.stringify(value)); sessionStorage.setItem(pendingKey, JSON.stringify({ personId: value.personId, workflowId: value.workflowId })); } else { const previous = readPending(); if (previous) sessionStorage.removeItem(ownJobKey(previous)); sessionStorage.removeItem(pendingKey); } } catch { /* Browser storage can be disabled; live server ownership still applies. */ } }
export function WorkbenchProvider({ children, client = defaultClient }: { children: React.ReactNode; client?: OkoClient }) {
  const [session, setSession] = useState<SessionView | null>(null), [workspace, setWorkspace] = useState<OkoWorkspaceView | null>(null);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState(''), [job, setJob] = useState<JobSnapshot | null>(null);
  const selected = useRef<string | undefined>(undefined), mounted = useRef(true), generation = useRef(0), pollGeneration = useRef(0), ownPerson = useRef<string | null>(null);
  const refresh = useCallback(async () => { const ticket = ++generation.current; const own = await client.session(); ownPerson.current = own.personId; const pending = readPending(); if (!selected.current && pending?.personId === own.personId) selected.current = pending.workflowId; const value = await client.workspace(selected.current); if (mounted.current && ticket === generation.current) { setSession(own); setWorkspace(value); if (value.current) selected.current = value.current.workflowId; } }, [client]);
  const apply = (value: unknown) => { if (value && typeof value === 'object' && 'workflowId' in value) { const current = value as OkoWorkflowView; selected.current = current.workflowId; ++generation.current; setWorkspace(previous => previous ? { ...previous, current, workflows: [...previous.workflows.filter(w => w.workflowId !== current.workflowId), { workflowId: current.workflowId, title: current.title, revision: current.revision }] } : null); } };
  const poll = useCallback(async (id: string) => {
    const ticket = ++pollGeneration.current; setBusy(true);
    const forget = () => { if (readPending()?.jobId === id) rememberPending(null); };
    try {
      for (;;) {
        const snapshot = await client.job(id); if (!mounted.current || ticket !== pollGeneration.current) return null; setJob(snapshot);
        if (snapshot.status === 'succeeded' || snapshot.status === 'partial') { forget(); let value: unknown = snapshot.result; if (value && typeof value === 'object' && 'result' in value) value = value.result; return value; }
        if (['failed', 'cancelled', 'interrupted'].includes(snapshot.status)) { forget(); throw new OkoClientError(snapshot.error?.code ?? snapshot.status, snapshot.error?.message ?? (snapshot.status === 'cancelled' ? 'Операция отменена. Предыдущий результат сохранён.' : 'Операция прервана. Повторите действие.')); }
        if (snapshot.status === 'waiting_user') { setError(snapshot.nextAction?.label ?? 'Завершите ручной вход в открытом браузере.'); return null; }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    } catch (failure) { if (mounted.current && ticket === pollGeneration.current) { if ((failure as OkoClientError).code === 'JOB_NOT_FOUND') forget(); setError((failure as Error).message); } throw failure; }
    finally { if (mounted.current && ticket === pollGeneration.current) setBusy(false); }
  }, [client]);
  useEffect(() => { mounted.current = true; const bootstrap = ++generation.current; void (async () => { try { await refresh(); if (!mounted.current || bootstrap + 1 !== generation.current) return; setLoading(false); const pending = readPending(); if (pending?.personId === ownPerson.current) { selected.current = pending.workflowId; const value = await poll(pending.jobId); if (mounted.current) { apply(value); await refresh(); } } } catch (failure) { if (mounted.current) setError((failure as Error).message); } finally { if (mounted.current) setLoading(false); } })(); return () => { mounted.current = false; ++pollGeneration.current; ++generation.current; }; }, [client, refresh, poll]);
  const run = useCallback(async (name: string, payload: Record<string, unknown>) => {
    setBusy(true); setError('');
    try {
      let value: unknown = await client.command(name, payload);
      if (value && typeof value === 'object' && 'jobId' in value) {
        const id = String(value.jobId);
        rememberPending({ jobId: id, workflowId: typeof payload.workflowId === 'string' ? payload.workflowId : selected.current ?? '', personId: ownPerson.current, kind: name === 'source.browser.marker.select' ? 'marker' : 'replay' });
        value = await poll(id);
      }
      if (mounted.current) { apply(value); await refresh(); }
      return value;
    } catch (failure) { if (mounted.current) setError((failure as Error).message); throw failure; }
    finally { if (mounted.current) setBusy(false); }
  }, [client, refresh, poll]);
  const select = async (id: string) => { selected.current = id; setError(''); try { await refresh(); } catch (failure) { setError((failure as Error).message); } };
  const open = async (workflowId?: string, title?: string) => { await run('source.browser.workflow.open', { ...(workflowId ? { workflowId } : {}), ...(title ? { title } : {}) }); };
  // Polling only reads status. Completion is persisted by the explicit finish command in the wizard.
  useEffect(() => { if (workspace?.current?.recording.state !== 'recording') return; const timer = setInterval(() => { void refresh().catch(failure => setError((failure as Error).message)); }, 1200); return () => clearInterval(timer); }, [workspace?.current?.recording.state, refresh]);
  return <Context.Provider value={{ client, session, workspace, current: workspace?.current ?? null, loading, busy, error, job, refresh, open, run, select, clearError: () => setError('') }}>{children}</Context.Provider>;
}
export function useWorkbench() { const context = useContext(Context); if (!context) throw new Error('WorkbenchProvider is required'); return context; }
