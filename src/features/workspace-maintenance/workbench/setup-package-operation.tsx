import { useEffect, useRef, useState } from 'react';
import { commandRequestSchema, type CommandRequest, type CommandReconciliation, type JobSnapshot } from '../../../server/workbench/protocol';
import { useWorkbench } from '../../../app/workbench/context';
import { WorkbenchApiError } from '../../../app/workbench/api-client';
import { executionOwner } from '../../execution/workbench/execution-ui';
type Operation = {
    request: CommandRequest;
    status: CommandReconciliation['status'] | 'unknown';
    jobId: string | null;
};
export const operationOwnerKey = (client: Parameters<typeof executionOwner>[0], person: string | null | undefined) => `${location.origin}.${executionOwner(client)}.${person ?? 'installation'}`;
/** A retained immutable request is retried only after the server proves not_found. */
export function useSetupOperation(namespace: string, onReadback: () => Promise<void>) {
    const { client, session } = useWorkbench();
    const key = 'uor.' + namespace + '.' + operationOwnerKey(client, session?.personId);
    const [operation, setOperation] = useState<Operation | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [job, setJob] = useState<JobSnapshot | null>(null);
    const mounted = useRef(false), flight = useRef(false), pending = useRef<Operation | null>(null);
    const persist = (value: Operation | null) => {
        if (mounted.current && (!value || value.jobId !== pending.current?.jobId || value.request.commandId !== pending.current?.request.commandId)) setJob(null);
        pending.current = value; if (mounted.current)
        setOperation(value); try {
        if (value)
            sessionStorage.setItem(key, JSON.stringify(value));
        else
            sessionStorage.removeItem(key);
    }
    catch { /* Current mounted request remains retained. */ } };
    useEffect(() => { mounted.current = true; try {
        const raw = JSON.parse(sessionStorage.getItem(key) ?? 'null');
        if (raw) {
            commandRequestSchema.parse(raw.request);
            persist(raw);
        }
    }
    catch {
        sessionStorage.removeItem(key);
    } return () => { mounted.current = false; }; }, [key]);
    const perform = async <T,>(action: () => Promise<T>): Promise<T | null> => { if (flight.current)
        return null; flight.current = true; setBusy(true); setError(null); try {
        const result = await action();
        return mounted.current ? result : null;
    }
    catch (e) {
        if (mounted.current)
            setError(e instanceof Error ? e.message : String(e));
        return null;
    }
    finally {
        flight.current = false;
        if (mounted.current)
            setBusy(false);
    } };
    const send = async (request: CommandRequest) => { persist({ request, status: 'unknown', jobId: null }); try {
        const response = await client.command<any>(request);
        if (!mounted.current)
            return null;
        if ('jobId' in response.data) {
            persist({ request, status: 'accepted', jobId: response.data.jobId });
            return null;
        }
        await onReadback();
        if (!mounted.current)
            return null;
        persist(null);
        return response.data.result;
    }
    catch (e) {
        if (mounted.current && e instanceof WorkbenchApiError && [403, 409, 422].includes(e.status))
            persist(null);
        throw e;
    } };
    const run = (name: string, payload: Record<string, unknown>) => perform(async () => { if (pending.current)
        throw Error('Сначала проверьте сохранённую операцию.'); return send({ commandId: crypto.randomUUID(), name, baseRevision: null, payload }); });
    const recover = (retry = false) => perform(async () => { const p = pending.current; if (!p)
        return null; if (retry) {
        if (p.status !== 'not_found')
            throw Error('Повтор разрешён только после ответа «команда не найдена».');
        return send(p.request);
    } const response = await client.reconcileCommand(p.request.commandId); if (!mounted.current)
        return null; const state = response.data; if (state.name !== null && state.name !== p.request.name)
        throw Error('Ответ относится к другой операции.'); persist({ ...p, status: state.status, jobId: state.job?.jobId ?? p.jobId }); if (state.status === 'completed' || state.status === 'interrupted') {
        await onReadback();
        if (!mounted.current)
            return null;
        persist(null);
        if (state.status === 'interrupted')
            setError('Операция прервана. Сохранённые данные проверены; проверьте результат перед новым действием.');
        return state.result;
    } if (state.status === 'not_found')
        setError('Команда не найдена. Можно явно повторить исходную команду с тем же идентификатором и содержимым.'); return null; });
    useEffect(() => { if (!operation?.jobId)
        return; let stopped = false, timer: ReturnType<typeof setTimeout>; const tick = async () => { try {
        const result = await client.job(operation.jobId!);
        if (stopped || !mounted.current)
            return;
        if (result.data.jobId !== operation.jobId || result.data.commandId !== operation.request.commandId) throw Error('Job identity mismatch');
        setJob(result.data);
        if (['succeeded', 'partial', 'failed', 'cancelled', 'interrupted'].includes(result.data.status)) {
            await onReadback();
            if (!stopped && mounted.current && result.data.error)
                setError(result.data.error.message);
            return;
        }
        timer = setTimeout(() => void tick(), 1500);
    }
    catch {
        if (!stopped && mounted.current) {
            setError('Ответ временно недоступен. Проверьте сохранённую операцию.');
            timer = setTimeout(() => void tick(), 4000);
        }
    } }; void tick(); return () => { stopped = true; clearTimeout(timer); }; }, [operation?.jobId, operation?.request.commandId, client]);
    const currentJob = operation && job?.jobId === operation.jobId && job.commandId === operation.request.commandId ? job : null;
    const terminal = currentJob && ['succeeded', 'partial', 'failed', 'cancelled', 'interrupted'].includes(currentJob.status);
    return { run, recover, operation, busy, error, setError, job: currentJob, blocked: busy || !!operation, terminal, dismiss: () => { if (terminal && pending.current?.jobId === currentJob?.jobId && pending.current?.request.commandId === currentJob?.commandId)
            persist(null); }, active: () => mounted.current };
}
export function SetupOperationStatus({ value }: {
    value: ReturnType<typeof useSetupOperation>;
}) { return <>{value.error && <p role="alert">{value.error}</p>}{value.operation && <div role="status"><p>Сохранённая операция: <code>{value.operation.request.commandId}</code> · {value.job?.status ?? value.operation.status}</p><button type="button" disabled={value.busy} onClick={() => void value.recover()}>Проверить сохранённую операцию</button>{value.operation.status === 'not_found' && <button type="button" disabled={value.busy} onClick={() => void value.recover(true)}>Повторить исходную команду</button>}{value.terminal && <button type="button" onClick={value.dismiss}>Закрыть результат</button>}</div>}</>; }
