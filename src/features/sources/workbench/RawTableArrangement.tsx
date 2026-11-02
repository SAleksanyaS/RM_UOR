import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useWorkbench } from '../../../app/workbench/context';
import { useUnsavedChanges } from '../../../app/workbench/use-unsaved-changes';
import { WorkbenchApiError } from '../../../app/workbench/api-client';
import { workbenchErrorMessage } from '../../../app/workbench/WorkbenchShell';
import type { PreferencesRead } from '../../system/workbench-preferences-query';
import type { CommandRequest, CommandResult } from '../../../server/workbench/protocol';
type Column = {
    key: string;
    label: string;
};
const request = { context: null, filter: {}, sort: [], page: { limit: 100, cursor: null } };
/** Keys bind immutable bytes and exact parsed schema; persisted tokens contain no source text. */
export async function rawArrangementKey(sha256: string, columns: Column[], profile: unknown) { const bytes = new TextEncoder().encode(JSON.stringify([sha256, columns.map(c => c.key), profile ?? null])); return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(n => n.toString(16).padStart(2, '0')).join(''); }
export function RawTableArrangement({ sha256, columns, profile, children }: {
    sha256: string;
    columns: Column[];
    profile?: unknown;
    children: (columns: Column[]) => ReactNode;
}) {
    const { client, session, refreshPreferences } = useWorkbench();
    const [key, setKey] = useState(''), [order, setOrder] = useState<string[]>([]), [baseline, setBaseline] = useState(''), [read, setRead] = useState<PreferencesRead | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(null), [pending, setPending] = useState(false), [message, setMessage] = useState(''), [retryAllowed, setRetryAllowed] = useState(false);
    const operation = useRef<CommandRequest | null>(null), active = useRef(true), epoch = useRef(0);
    const identity = JSON.stringify([session?.personId, sha256, columns.map(c => c.key), profile]);
    useUnsavedChanges(pending || !!baseline && JSON.stringify(order) !== baseline);
    useEffect(() => { let live = true; active.current = true; epoch.current++; setKey(''); setRead(null); setOrder([]); setBaseline(''); operation.current = null; setPending(false); void (async () => { const k = await rawArrangementKey(sha256, columns, profile), p = await client.query<PreferencesRead>('preferences.get', request); if (!live)
        return; const fallback = columns.map((_, i) => 'col_' + (i + 1)); const saved = p.data.values.rawTableColumns?.[k]; const next = saved?.filter(t => fallback.includes(t)) ?? fallback; setKey(k); setOrder(next.length ? next : fallback); setBaseline(JSON.stringify(next.length ? next : fallback)); setRead(p.data); })().catch(e => { if (live)
        setError(e); }); return () => { live = false; active.current = false; }; }, [client, identity]);
    const arranged = order.map(t => columns[Number(t.slice(4)) - 1]).filter((c): c is Column => !!c);
    const move = (i: number, by: number) => { const next = [...order]; if (i + by < 0 || i + by >= next.length)
        return; [next[i], next[i + by]] = [next[i + by], next[i]]; setOrder(next); };
    const save = async (retry = false) => {
        if (!read || !key || busy)
            return;
        const generation = epoch.current;
        const current = () => active.current && epoch.current === generation;
        setBusy(true);
        setError(null);
        try {
            if (operation.current && !retry) {
                const state = (await client.reconcileCommand(operation.current.commandId)).data;
                setRetryAllowed(state.status === 'not_found');
                if (state.name !== null && state.name !== 'preferences.set')
                    throw Error('Ответ восстановления не соответствует команде');
                if (state.status === 'not_found')
                    throw Error('Команда не найдена. Повторите исходное сохранение явно.');
                if (state.status === 'pending' || state.status === 'accepted')
                    throw Error('Сохранение ещё выполняется');
                if (state.status === 'interrupted') {
                    operation.current = null;
                    setPending(false);
                    throw Error('Сохранение прервано. Загрузите новую основу и проверьте изменения.');
                }
            }
            else {
                if (retry && !retryAllowed)
                    throw Error('Сначала проверьте сохранение');
                operation.current ??= { commandId: crypto.randomUUID(), name: 'preferences.set', baseRevision: read.editToken, payload: { values: { ...read.values, rawTableColumns: { ...read.values.rawTableColumns, [key]: order } } } };
                setPending(true);
                setRetryAllowed(false);
                const response = await client.command<CommandResult>(operation.current);
                if ('jobId' in response.data)
                    throw Error('Сохранение ещё не подтверждено');
            }
            if (!current())
                return;
            const refreshed = await refreshPreferences();
            if (!current())
                return;
            operation.current = null;
            setPending(false);
            setRetryAllowed(false);
            setBaseline(JSON.stringify(refreshed.values.rawTableColumns?.[key] ?? columns.map((_, i) => 'col_' + (i + 1))));
            setRead(refreshed);
            setMessage('Личный порядок столбцов сохранён');
        }
        catch (e) {
            if (current()) {
                if (e instanceof WorkbenchApiError && [403, 409, 422].includes(e.status)) {
                    operation.current = null;
                    setPending(false);
                }
                setError(e);
            }
        }
        finally {
            if (current())
                setBusy(false);
        }
    };
    return <><details className="wb-object-content"><summary>Личные столбцы и порядок</summary><fieldset disabled={busy || pending || !read}>{columns.map((c, i) => { const token = 'col_' + (i + 1), position = order.indexOf(token); return <div key={c.key} className="wb-page-toolbar"><label><input type="checkbox" checked={position >= 0} disabled={position >= 0 && order.length === 1} onChange={e => setOrder(e.target.checked ? [...order, token] : order.filter(t => t !== token))}/>{c.label}</label>{position >= 0 && <><button aria-label={'Влево: ' + c.label} disabled={position === 0} onClick={() => move(position, -1)}>Влево</button><button aria-label={'Вправо: ' + c.label} disabled={position === order.length - 1} onClick={() => move(position, 1)}>Вправо</button></>}</div>; })}</fieldset><button disabled={busy || !read} onClick={() => void save()}>{pending ? 'Проверить сохранение столбцов' : 'Сохранить личные столбцы'}</button>{retryAllowed && <button disabled={busy} onClick={() => void save(true)}>Повторить исходное сохранение столбцов</button>}{error !== null && <p role="alert">{workbenchErrorMessage(error)}{!pending && <button onClick={() => void client.query<PreferencesRead>('preferences.get', request).then(r => { setRead(r.data); setError(null); })}>Загрузить новую основу для повторного сохранения</button>}</p>}<p role="status">{message}</p></details>{children(key ? arranged : columns)}</>;
}
