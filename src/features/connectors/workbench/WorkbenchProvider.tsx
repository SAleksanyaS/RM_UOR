import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { JobSnapshot, SessionView } from '../../../server/workbench/protocol';
import type { OkoWorkspaceView, OkoWorkflowView } from '../workbench-workflow-contracts';
import { OkoClient, OkoClientError } from './client';

type Workspace = { client: OkoClient; session: SessionView | null; workspace: OkoWorkspaceView | null; current: OkoWorkflowView | null; loading: boolean; busy: boolean; error: string; job: JobSnapshot | null; refresh(): Promise<void>; open(id?: string, title?: string): Promise<void>; run(name: string, payload: Record<string, unknown>): Promise<unknown>; select(id: string): Promise<void>; clearError(): void };
const Context = createContext<Workspace | null>(null);
const defaultClient = new OkoClient();
const pendingKey = 'uor.oko.pending-job.v1', commandKey = 'uor.oko.pending-command.v1', releaseKey = 'uor.oko.pending-release.v1';
const releaseCommand = 'source.browser.record.cancel';
type PendingJob = { personId: string | null; workflowId: string; jobId: string; kind: 'marker' | 'replay' };
// Deliberately contains no payload, URL, title or filter values. Receipts are read from the own server.
type PendingCommand = { personId: string | null; commandId: string; name: string; workflowId: string | null };
const ownJobKey = (value: Pick<PendingJob, 'personId' | 'workflowId'>) => `${pendingKey}:${value.personId ?? 'unassigned'}:${value.workflowId}`;
function readPending(): PendingJob | null { try { const pointer = JSON.parse(sessionStorage.getItem(pendingKey) ?? 'null'); if (!pointer || typeof pointer.workflowId !== 'string' || !(typeof pointer.personId === 'string' || pointer.personId === null)) return null; const value = JSON.parse(sessionStorage.getItem(ownJobKey(pointer)) ?? 'null'); return value && value.workflowId === pointer.workflowId && value.personId === pointer.personId && typeof value.jobId === 'string' && ['marker', 'replay'].includes(value.kind) ? value : null; } catch { return null; } }
function rememberPending(value: PendingJob | null) { try { if (value) { sessionStorage.setItem(ownJobKey(value), JSON.stringify(value)); sessionStorage.setItem(pendingKey, JSON.stringify({ personId: value.personId, workflowId: value.workflowId })); } else { const previous = readPending(); if (previous) sessionStorage.removeItem(ownJobKey(previous)); sessionStorage.removeItem(pendingKey); } } catch { /* Live ownership still applies if browser storage is unavailable. */ } }
function readCommand(key = commandKey): PendingCommand | null { try { const v = JSON.parse(sessionStorage.getItem(key) ?? 'null'); return v && (v.personId === null || typeof v.personId === 'string') && typeof v.commandId === 'string' && typeof v.name === 'string' && (v.workflowId === null || typeof v.workflowId === 'string') ? v : null; } catch { return null; } }
function clearForeignMetadata(personId: string | null) { try { const own = personId ?? 'unassigned'; for (const key of Object.keys(sessionStorage)) { if ((key.startsWith(pendingKey + ':') && !key.startsWith(`${pendingKey}:${own}:`)) || (key.startsWith('uor.oko.login.v1:') && !key.startsWith(`uor.oko.login.v1:${own}:`))) sessionStorage.removeItem(key); } if (readPending()?.personId !== personId) sessionStorage.removeItem(pendingKey); if (readCommand()?.personId !== personId) sessionStorage.removeItem(commandKey); } catch { /* The server remains authoritative. */ } }
export function WorkbenchProvider({ children, client = defaultClient }: { children: React.ReactNode; client?: OkoClient }) {
  const [session, setSession] = useState<SessionView | null>(null), [workspace, setWorkspace] = useState<OkoWorkspaceView | null>(null);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState(''), [job, setJob] = useState<JobSnapshot | null>(null);
  const selected = useRef<string | undefined>(undefined), mounted = useRef(true), generation = useRef(0), pollGeneration = useRef(0), ownPerson = useRef<string | null | undefined>(undefined);
  const pendingCommand = useRef<PendingCommand | null>(readCommand());
  // Release must remain recoverable without replacing the operation it is cancelling.
  const pendingRelease = useRef<PendingCommand | null>(readCommand(releaseKey));
  const active = useRef<{ name: string; workflowId: string | null; promise: Promise<unknown> } | null>(null);
  const activeRelease = useRef<typeof active.current>(null);
  const rememberCommand = (value: PendingCommand | null, release = value?.name === releaseCommand) => { const pending = release ? pendingRelease : pendingCommand, key = release ? releaseKey : commandKey; pending.current = value; try { if (value) sessionStorage.setItem(key, JSON.stringify(value)); else sessionStorage.removeItem(key); } catch { /* Retain the same command in memory while storage is disabled. */ } };
  const forgetCommand = (command: PendingCommand) => { if (pendingCommand.current?.commandId === command.commandId) rememberCommand(null); if (pendingRelease.current?.commandId === command.commandId) rememberCommand(null, true); };
  const acceptSession = useCallback((own: SessionView) => {
    const changed = ownPerson.current !== undefined && ownPerson.current !== own.personId;
    clearForeignMetadata(own.personId);
    if (pendingCommand.current?.personId !== own.personId) pendingCommand.current = null;
    if (pendingRelease.current?.personId !== own.personId) rememberCommand(null, true);
    if (changed) { selected.current = undefined; ++pollGeneration.current; setJob(null); setWorkspace(null); }
    ownPerson.current = own.personId; setSession(own);
    return changed;
  }, []);
  const refresh = useCallback(async () => { const ticket = ++generation.current; const own = await client.session(); if (!mounted.current || ticket !== generation.current) return; acceptSession(own); const pending = readPending(); if (!selected.current && pending?.personId === own.personId) selected.current = pending.workflowId; if (!selected.current && pendingCommand.current?.workflowId) selected.current = pendingCommand.current.workflowId; const value = await client.workspace(selected.current); if (mounted.current && ticket === generation.current) { setWorkspace(value); if (value.current) selected.current = value.current.workflowId; } }, [client, acceptSession]);
  const poll = useCallback(async (id: string) => {
    const ticket = ++pollGeneration.current, personId = ownPerson.current; setBusy(true);
    const forget = () => { if (readPending()?.jobId === id) rememberPending(null); };
    try {
      for (;;) {
        const own = await client.session(); if (!mounted.current || ticket !== pollGeneration.current) return null;
        if (acceptSession(own) || personId !== own.personId) throw new OkoClientError('OWN_PERSON_CHANGED', 'Личность рабочего места изменилась. Выберите собственный сценарий.');
        const snapshot = await client.job(id); if (!mounted.current || ticket !== pollGeneration.current) return null; setJob(snapshot);
        if (snapshot.status === 'succeeded' || snapshot.status === 'partial') { forget(); let value: unknown = snapshot.result; if (value && typeof value === 'object' && 'result' in value) value = value.result; return value; }
        if (['failed', 'cancelled', 'interrupted'].includes(snapshot.status)) { forget(); throw new OkoClientError(snapshot.error?.code ?? snapshot.status, snapshot.error?.message ?? (snapshot.status === 'cancelled' ? 'Операция отменена. Предыдущий результат сохранён.' : 'Операция прервана. Повторите действие.')); }
        if (snapshot.status === 'waiting_user') { setError(snapshot.nextAction?.label ?? 'Завершите ручной вход в открытом браузере.'); return null; }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    } catch (failure) { if (mounted.current && ticket === pollGeneration.current) { if ((failure as OkoClientError).code === 'JOB_NOT_FOUND') forget(); setError((failure as Error).message); } throw failure; }
    finally { if (mounted.current && ticket === pollGeneration.current) setBusy(Boolean(active.current || activeRelease.current)); }
  }, [client, acceptSession]);
  const finish = useCallback(async (value: unknown, command: PendingCommand, preserveSelection = false) => {
    const own = await client.session(); if (!mounted.current) return value;
    if (acceptSession(own) || own.personId !== command.personId) throw new OkoClientError('OWN_PERSON_CHANGED', 'Личность рабочего места изменилась. Выберите собственный сценарий.');
    if (!preserveSelection && value && typeof value === 'object' && 'workflowId' in value) selected.current = String(value.workflowId);
    if (value && typeof value === 'object' && 'jobId' in value) {
      const id = String(value.jobId);
      rememberPending({ jobId: id, workflowId: command.workflowId ?? selected.current ?? '', personId: command.personId, kind: command.name === 'source.browser.marker.select' ? 'marker' : 'replay' });
      // Keep recovery metadata until the accepted job or receipt has been reflected in the workspace.
      try { value = await poll(id); } catch (failure) { if (failure instanceof OkoClientError && !failure.uncertain) forgetCommand(command); throw failure; }
    }
    if (mounted.current) { await refresh(); forgetCommand(command); }
    return value;
  }, [client, acceptSession, poll, refresh]);
  const reconcile = useCallback(async (command: PendingCommand, preserveSelection = false) => {
    const outcome = await client.reconcileCommand(command.commandId);
    if (outcome.name !== null && outcome.name !== command.name) throw new OkoClientError('INVALID_RESPONSE', 'Ответ восстановления не соответствует команде.');
    if (outcome.status === 'completed') return { recovered: true, value: await finish(outcome.result, command, preserveSelection) };
    if (outcome.status === 'accepted' && outcome.job) return { recovered: true, value: await finish(outcome.job, command, preserveSelection) };
    if (outcome.status === 'interrupted') { forgetCommand(command); throw new OkoClientError('COMMAND_INTERRUPTED', 'Предыдущее действие прервано. Проверьте сохранённый результат перед повтором.'); }
    if (outcome.status === 'pending') throw new OkoClientError('COMMAND_PENDING', 'Предыдущее действие ещё выполняется. Повторите проверку через несколько секунд.');
    return { recovered: false, value: null };
  }, [client, finish]);
  useEffect(() => { mounted.current = true; const bootstrap = ++generation.current; void (async () => { try { await refresh(); if (!mounted.current || bootstrap + 1 !== generation.current) return; setLoading(false); const release = pendingRelease.current; if (release && release.personId === ownPerson.current) { setBusy(true); await reconcile(release, true); } const command = pendingCommand.current; if (command) setBusy(true); if (command && command.personId === ownPerson.current) { const result = await reconcile(command); if (!result.recovered) setError('Ответ предыдущего действия не найден. Повторите то же действие; его идентификатор сохранён.'); } else { const pending = readPending(); if (pending && pending.personId === ownPerson.current) { selected.current = pending.workflowId; await poll(pending.jobId); if (mounted.current) await refresh(); } } } catch (failure) { if (mounted.current) setError((failure as Error).message); } finally { if (mounted.current) { setLoading(false); if (!active.current && !activeRelease.current) setBusy(false); } } })(); return () => { mounted.current = false; ++pollGeneration.current; ++generation.current; }; }, [client, refresh, poll, reconcile]);
  const run = useCallback((name: string, payload: Record<string, unknown>): Promise<unknown> => {
    const workflowId = typeof payload.workflowId === 'string' ? payload.workflowId : null;
    const controlsOwnJob = name.startsWith('job.') && readPending()?.jobId === payload.jobId;
    const releasesBrowser = name === releaseCommand && workflowId !== null;
    const lane = releasesBrowser ? activeRelease : active;
    const blocking = activeRelease.current ?? (!releasesBrowser && !controlsOwnJob ? active.current : null);
    if (blocking) return blocking.name === name && blocking.workflowId === workflowId ? blocking.promise : Promise.reject(new OkoClientError('COMMAND_BUSY', 'Дождитесь завершения предыдущего действия.'));
    // The synchronous promise guard also covers duplicate clicks before busy is rendered.
    const promise = Promise.resolve().then(async () => {
      setBusy(true); setError('');
      let command: PendingCommand | null = null, received = false;
      try {
        const own = await client.session(); acceptSession(own);
        if (!releasesBrowser && pendingRelease.current) {
          await reconcile(pendingRelease.current, true);
          throw new OkoClientError('COMMAND_RECOVERED', 'Проверьте результат освобождения браузера и повторите текущее действие.');
        }
        const previous = releasesBrowser ? pendingRelease.current : controlsOwnJob && pendingCommand.current && !pendingCommand.current.name.startsWith('job.') ? null : pendingCommand.current;
        if (previous) {
          const sameAction = previous.name === name && previous.workflowId === workflowId;
          const result = await reconcile(previous, releasesBrowser || !sameAction);
          // An old receipt proves the earlier submission only; current form values may have changed.
          if (!sameAction || result.recovered && !releasesBrowser) throw new OkoClientError(result.recovered ? 'COMMAND_RECOVERED' : 'COMMAND_UNCERTAIN', result.recovered ? 'Предыдущее действие восстановлено. Изменения текущей формы ещё не сохранены. Проверьте результат перед повтором текущего действия.' : 'Сначала повторите предыдущее действие для восстановления его ответа.');
          if (result.recovered) return result.value;
          command = previous;
        } else command = { personId: own.personId, commandId: crypto.randomUUID(), name, workflowId };
        rememberCommand(command);
        const value = await client.command(name, payload, command.commandId); received = true;
        return await finish(value, command, releasesBrowser);
      } catch (failure) {
        if (command && !received && !(failure instanceof OkoClientError && (failure.uncertain || ['COMMAND_PENDING', 'COMMAND_UNCERTAIN'].includes(failure.code)))) forgetCommand(command);
        if (mounted.current) setError((failure as Error).message); throw failure;
      } finally { if (lane.current?.promise === promise) lane.current = null; if (mounted.current) setBusy(Boolean(active.current || activeRelease.current)); }
    });
    lane.current = { name, workflowId, promise }; return promise;
  }, [client, acceptSession, reconcile, finish]);
  const select = async (id: string) => { selected.current = id; setError(''); try { await refresh(); } catch (failure) { setError((failure as Error).message); } };
  const open = async (workflowId?: string, title?: string) => { await run('source.browser.workflow.open', { ...(workflowId ? { workflowId } : {}), ...(title ? { title } : {}) }); };
  useEffect(() => { if (workspace?.current?.recording.state !== 'recording') return; const timer = setInterval(() => { void refresh().catch(failure => setError((failure as Error).message)); }, 1200); return () => clearInterval(timer); }, [workspace?.current?.recording.state, refresh]);
  return <Context.Provider value={{ client, session, workspace, current: workspace?.current ?? null, loading, busy, error, job, refresh, open, run, select, clearError: () => setError('') }}>{children}</Context.Provider>;
}
export function useWorkbench() { const context = useContext(Context); if (!context) throw new Error('WorkbenchProvider is required'); return context; }
