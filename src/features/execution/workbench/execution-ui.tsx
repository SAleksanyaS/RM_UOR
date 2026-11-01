import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { useGlobalContext, useWorkbench, useWorkbenchQuery } from '../../../app/workbench/context';
import { WorkbenchApiError, type WorkbenchClient } from '../../../app/workbench/api-client';
import { workbenchErrorMessage } from '../../../app/workbench/WorkbenchShell';
import type { ApiSuccess, CommandRequest, CommandResult, GlobalContext } from '../../../server/workbench/protocol';
import type { EntityRef } from '../../../domain/workbench/primitives';
import type { DraftEntry } from '../../catalog/workbench-drafts';
import type { WorkbenchReadModels } from '../../catalog/workbench-read-models';

export const executionRequest = (context: GlobalContext, filter: Record<string, unknown> = {}, cursor: string | null = null) => ({ context, filter, sort: [], page: { limit: 100, cursor } });
const clientIds = new WeakMap<WorkbenchClient, number>(); let nextClient = 0;
export function executionOwner(client: WorkbenchClient): number { if (!clientIds.has(client)) clientIds.set(client, ++nextClient); return clientIds.get(client)!; }
export function formatExecutionDate(value: string | null | undefined): string { return value ? value.slice(0, 10).split('-').reverse().join('.') : 'Не задан'; }
export const workStateLabels = { planned: 'Запланирована', in_progress: 'В работе', paused: 'Приостановлена', completed: 'Завершена', cancelled: 'Отменена' };
export function businessFields(value: Record<string, unknown>): Record<string, unknown> { return Object.fromEntries(Object.entries(value).filter(([key]) => !['schemaVersion', 'id', 'revision', 'recordedAt', 'actor', 'publicationAnchorId'].includes(key))); }
class ExecutionReadbackConflict extends Error {}
const comparableDefinition = (value: unknown) => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
export function ExecutionError({ error, operation = 'mutation' }: { error: unknown; operation?: 'read' | 'mutation' }) {
  if (error === null) return null;
  if (error instanceof ExecutionReadbackConflict) return <div role="alert"><p>Пакет изменён в другом окне. Введённые значения остаются в этой форме; сохранение заблокировано до явной загрузки актуального черновика.</p></div>;
  return <div role="alert"><p>{workbenchErrorMessage(error, operation)}</p>{error instanceof WorkbenchApiError && error.problem.details.map((problem, index) => <p key={index}>{problem.path}: {problem.message}</p>)}</div>;
}
export function ExecutionDialog({ title, onClose, children }: { title: string; onClose(): void; children: ReactNode }) {
  const element = useRef<HTMLElement>(null), closer = useRef<HTMLButtonElement>(null);
  const close = useRef(onClose); close.current = onClose;
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null, previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden'; closer.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close.current(); return; }
      if (event.key !== 'Tab') return;
      const items = [...element.current!.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href]')];
      const first = items[0], last = items.at(-1), outside = !element.current?.contains(document.activeElement);
      if (outside || event.shiftKey && document.activeElement === first) { event.preventDefault(); (event.shiftKey ? last : first)?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    const onFocus = (event: FocusEvent) => { if (event.target instanceof Node && !element.current?.contains(event.target)) closer.current?.focus(); };
    document.addEventListener('keydown', onKey); document.addEventListener('focusin', onFocus);
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('focusin', onFocus); document.body.style.overflow = previousOverflow; if (opener?.isConnected) opener.focus(); };
  }, []);
  return <div className="wb-execution-backdrop"><section className="wb-execution-dialog" ref={element} role="dialog" aria-modal="true" aria-label={title}><header><h2>{title}</h2><button ref={closer} type="button" onClick={onClose}>Закрыть редактор</button></header>{children}</section></div>;
}
type PackageRead = WorkbenchReadModels['uor.package'];
type Opened = { draftId: string; objectId: string; entityRef: EntityRef; editToken: string };
type Saved = { draftId: string; entityRef: EntityRef; versionRef: DraftEntry['versionRef']; complete: boolean; problems: DraftEntry['problems'] };
type Pending = { signature: string; request: CommandRequest; response?: CommandResult; inFlight?: Promise<CommandResult> };
function definiteRejection(error: unknown): boolean {
  return error instanceof WorkbenchApiError && (error.status === 422 || error.status === 403 || error.status === 409 && ['REVISION_CONFLICT', 'COMMAND_ID_REUSED'].includes(error.problem.code));
}
export type ExecutionEditorApi = {
  entry: DraftEntry; entries: DraftEntry[]; packageId: string; disabled: boolean; unknown: boolean;
  run<T>(step: string, name: string, payload: Record<string, unknown>): Promise<T>;
  perform(name: string, action: () => Promise<void>, onSaved?: () => void): void;
};
/** All edits go through the real draft owner. Unknown steps keep their exact request identity. */
export function ExecutionDraftEditor({ reference, entityType = reference?.entityType, commandName, children }: { reference: EntityRef | null; entityType?: string; commandName: string; children(api: ExecutionEditorApi): ReactNode }) {
  const { client, session, loading: checking } = useWorkbench(); const { context } = useGlobalContext();
  const [queueCursor, setQueueCursor] = useState<string | null>(null), [queueItems, setQueueItems] = useState<WorkbenchReadModels['uor.queue']['items']>([]);
  const queue = useWorkbenchQuery<WorkbenchReadModels['uor.queue']>('uor.queue', context ? executionRequest(context, {}, queueCursor) : null);
  useEffect(() => { if (queue.data) setQueueItems(previous => queueCursor === null ? queue.data!.items : [...new Map([...previous, ...queue.data!.items].map(item => [item.packageRef.id, item])).values()]); }, [queue.data, queueCursor]);
  const [selection, setSelection] = useState(''), [view, setView] = useState<{ pkg: PackageRead; draftId: string } | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(null), [unknown, setUnknown] = useState(false), [saved, setSaved] = useState(false), [conflict, setConflict] = useState(false), [formRevision, setFormRevision] = useState(0);
  const expectedEntries = useRef(new Map<string, { versionRef: DraftEntry['versionRef']; definition?: Record<string, unknown> }>()), openedDraftId = useRef<string | null>(null);
  const openingChoice = useRef<string | null>(null);
  const live = useRef<object | null>(null), access = useRef(false), token = useRef<string | null>(null), packageId = useRef<string | null>(null), requests = useRef(new Map<string, Pending>()), actionName = useRef<string | null>(null), locked = useRef(false);
  access.current = !checking && !!session?.allowedCommands.includes(commandName);
  const current = (owner: object) => live.current === owner;
  const call = async <T,>(owner: object, step: string, name: string, payload: Record<string, unknown>, baseRevision = token.current): Promise<T> => {
    if (!current(owner) || !access.current) throw Error('Дождитесь завершения проверки доступа');
    const signature = JSON.stringify([name, payload]); let pending = requests.current.get(step);
    if (pending && pending.signature !== signature) { if (!pending.response) throw Error('Сначала проверьте результат незавершённого сохранения'); requests.current.delete(step); pending = undefined; }
    if (!pending) { pending = { signature, request: { commandId: crypto.randomUUID(), name, payload: structuredClone(payload), baseRevision } }; requests.current.set(step, pending); }
    if (!pending.response) {
      pending.inFlight ??= client.command<CommandResult>(pending.request).then(response => { if ('jobId' in response.data) throw Error('Ожидается синхронный ответ редактора'); return response.data; });
      try { pending.response = await pending.inFlight; } catch (failure) { pending.inFlight = undefined; if (definiteRejection(failure)) requests.current.delete(step); throw failure; }
      if (!current(owner)) throw Error('Редактор закрыт');
      token.current = pending.response.editToken;
      const result = pending.response.result as Partial<Saved>;
      if (result.draftId && result.versionRef) expectedEntries.current.set(result.draftId, { versionRef: result.versionRef, ...(payload.definition && typeof payload.definition === 'object' ? { definition: structuredClone(payload.definition as Record<string, unknown>) } : {}) });
    }
    return pending.response.result as T;
  };
  const readPackage = async (owner: object, id: string) => { const response = await client.query<PackageRead>('uor.package', executionRequest(context!, { packageRef: { entityType: 'publication_package', id } })); if (!current(owner)) throw Error('Редактор закрыт'); return response.data; };
  const assertReadback = (pkg: PackageRead) => {
    if (pkg.summary.editToken !== token.current) throw new ExecutionReadbackConflict();
    for (const [draftId, expected] of expectedEntries.current) {
      const entry = pkg.entries.find(entry => entry.draftId === draftId);
      if (!entry || comparableDefinition(entry.versionRef) !== comparableDefinition(expected.versionRef)) throw new ExecutionReadbackConflict();
      if (expected.definition) {
        const observed = { ...entry.definition };
        if (entry.entityRef.entityType === 'decision' && !Object.hasOwn(expected.definition, 'answeredAt')) delete observed.answeredAt;
        if (comparableDefinition(observed) !== comparableDefinition(expected.definition)) throw new ExecutionReadbackConflict();
      }
    }
  };
  const allPackages = async (owner: object) => {
    const items: WorkbenchReadModels['uor.queue']['items'] = []; let cursor: string | null = null;
    do { const response: ApiSuccess<WorkbenchReadModels['uor.queue']> = await client.query<WorkbenchReadModels['uor.queue']>('uor.queue', executionRequest(context!, {}, cursor)); if (!current(owner)) throw Error('Редактор закрыт'); items.push(...response.data.items); cursor = response.data.page.nextCursor; } while (cursor);
    return items;
  };
  const load = async (owner: object, chosen: string) => {
    if (!current(owner) || locked.current || !context || !access.current) return;
    locked.current = true; setBusy(true); setError(null);
    try {
      const choice = unknown ? openingChoice.current ?? chosen : chosen;
      openingChoice.current = choice;
      const requestedId = choice && choice !== 'new' ? choice : null;
      let base: string | null = null;
      if (requestedId) base = (await readPackage(owner, requestedId)).summary.editToken;
      const opened = await call<Opened>(owner, 'editor.open', 'draft.open', { entityType, ref: reference, packageId: requestedId }, base);
      openedDraftId.current = opened.draftId;
      const packages = await allPackages(owner); let pkg: PackageRead | null = null;
      for (const item of packages) { const candidate = await readPackage(owner, item.packageRef.id); if (candidate.entries.some(entry => entry.draftId === opened.draftId)) { pkg = candidate; break; } }
      if (!pkg) throw Error('Не удалось найти открытый черновик. Проверьте пакет изменений');
      packageId.current = pkg.summary.packageRef.id; assertReadback(pkg);
      if (current(owner)) { setView({ pkg, draftId: opened.draftId }); setUnknown(false); }
    } catch (failure) { if (current(owner)) { setError(failure); setConflict(failure instanceof ExecutionReadbackConflict); setUnknown(!(failure instanceof ExecutionReadbackConflict) && !definiteRejection(failure)); } }
    finally { if (current(owner)) { locked.current = false; setBusy(false); } }
  };
  useEffect(() => { const owner = {}; live.current = owner; locked.current = false; return () => { if (live.current === owner) live.current = null; }; }, []);
  useEffect(() => { const owner = live.current; if (owner && !view && !unknown && !conflict && queue.data && (queueCursor === null && queue.data.items.length <= 1 && !queue.data.page.nextCursor)) void load(owner, selection || queue.data.items[0]?.packageRef.id || 'new'); }, [queue.data, view, checking, selection, queueCursor, unknown, conflict]);
  const perform = (name: string, action: () => Promise<void>, onSaved?: () => void) => {
    const owner = live.current; if (!owner || locked.current || !access.current || conflict) return;
    if (unknown && actionName.current !== name) return;
    if (actionName.current !== name || saved) { for (const step of [...requests.current.keys()]) if (step !== 'editor.open') requests.current.delete(step); }
    actionName.current = name; locked.current = true; setBusy(true); setSaved(false); setError(null);
    void action().then(async () => { if (!current(owner)) return; const pkg = await readPackage(owner, packageId.current!); assertReadback(pkg); if (current(owner)) { setView(previous => previous ? { pkg, draftId: previous.draftId } : null); setUnknown(false); setSaved(true); onSaved?.(); } }, failure => {
      if (current(owner)) { setError(failure); setUnknown(!definiteRejection(failure)); }
    }).catch(failure => { if (current(owner)) { setError(failure); setConflict(failure instanceof ExecutionReadbackConflict); setUnknown(!(failure instanceof ExecutionReadbackConflict)); } }).finally(() => { if (current(owner)) { locked.current = false; setBusy(false); } });
  };
  const reconcile = async () => {
    const owner = live.current; if (!owner || locked.current || !access.current || !conflict || !packageId.current || !openedDraftId.current) return;
    locked.current = true; setBusy(true);
    try {
      const pkg = await readPackage(owner, packageId.current);
      if (!current(owner) || !access.current) return;
      token.current = pkg.summary.editToken; expectedEntries.current.clear(); requests.current.clear(); actionName.current = null;
      setView({ pkg, draftId: openedDraftId.current }); setFormRevision(previous => previous + 1); setConflict(false); setUnknown(false); setSaved(false); setError(null);
    } catch (failure) { if (current(owner)) setError(failure); }
    finally { if (current(owner)) { locked.current = false; setBusy(false); } }
  };
  const entry = view?.pkg.entries.find(item => item.draftId === view.draftId);
  return <><p className="wb-status-note">Изменения сохраняются в личном пакете и станут общими после принятия.</p>{checking && <p role="status">Проверяем доступ…</p>}<ExecutionError error={error} />{queue.error !== null && !view && <ExecutionError error={queue.error} operation="read" />}{busy && <p role="status">Сохраняем черновик…</p>}{saved && <p role="status">Черновик сохранён</p>}{unknown && <p role="status">Результат последнего действия не подтверждён. Поля заблокированы; повторите это же действие для проверки.</p>}
    {!entry && <><label className="wb-field"><span>Пакет изменений</span><select aria-label="Пакет изменений" value={selection} disabled={busy || checking || unknown || conflict} onChange={event => setSelection(event.target.value)}><option value="">Выберите пакет</option><option value="new">Создать новый пакет</option>{queueItems.map((item, index) => <option key={item.packageRef.id} value={item.packageRef.id}>Пакет {index + 1} · редакция {item.revision} · незавершённых: {item.incomplete}</option>)}</select></label><button disabled={busy || checking || conflict || !queue.data || ((queueItems.length > 1 || !!queue.data.page.nextCursor) && !selection)} onClick={() => { if (live.current) void load(live.current, selection || 'new'); }}>Повторить открытие черновика</button>{queue.data?.page.nextCursor && <button disabled={busy || checking || queue.loading} onClick={() => setQueueCursor(queue.data!.page.nextCursor)}>Показать ещё пакеты</button>}</>}
    {conflict && <button type="button" disabled={busy || checking || !access.current} onClick={() => { void reconcile(); }}>Загрузить актуальный черновик вместо введённых данных</button>}
    {entry && <Fragment key={formRevision}>{children({ entry, entries: view!.pkg.entries, packageId: view!.pkg.summary.packageRef.id, disabled: busy || checking || !access.current || unknown || conflict, unknown, run: (step, name, payload) => { const owner = live.current; if (!owner) return Promise.reject(Error('Редактор закрыт')); return call(owner, step, name, payload); }, perform })}</Fragment>}
  </>;
}
