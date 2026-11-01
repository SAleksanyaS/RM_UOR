import { useEffect, useState } from 'react';
import { useGlobalContext, useWorkbenchQuery } from '../../../app/workbench/context';
import { routeUrl } from '../../../app/workbench/route-state';
import { workbenchErrorMessage } from '../../../app/workbench/WorkbenchShell';
import type { GlobalContext, QueryRequest } from '../../../server/workbench/protocol';
import type { ExactNumber } from '../../../domain/workbench/primitives';
import type { WorkbenchReadModels } from '../../catalog/workbench-read-models';
import type { AgreedSnapshot } from '../../../domain/workbench/entities';
import './goal-views.css';

export const goalRequest = (context: GlobalContext, filter: Record<string, unknown> = {}, cursor: string | null = null): QueryRequest => ({ context, filter, sort: [], page: { limit: 50, cursor } });
/** Formatting only: preserve exact server fractions instead of rounding a result. */
export function displayExact(value: ExactNumber | null | undefined): string {
  if (value === null || value === undefined) return 'Нет данных';
  return typeof value === 'string' ? value : value.denominator === '1' ? value.numerator : `${value.numerator}/${value.denominator}`;
}
export function QueryFeedback({ loading, error, operation = 'read' }: { loading: boolean; error: unknown; operation?: 'read' | 'mutation' }) {
  return <>{loading && <p role="status">Загружаем данные…</p>}{error !== null && <p role="alert">{workbenchErrorMessage(error, operation)}</p>}</>;
}
export function ContextLink({ path, label }: { path: string; label: string }) {
  const { context, navigate } = useGlobalContext();
  return <a href={routeUrl(path, context)} onClick={event => { if (event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) { event.preventDefault(); navigate(path); } }}>{label}</a>;
}
export function GoalOpenButton({ goalId, title }: { goalId: string; title: string }) {
  const { navigate, setContext } = useGlobalContext();
  return <button type="button" onClick={() => { void setContext({ goalId }).catch(() => undefined); navigate('/goals/' + goalId); }}>Открыть цель: {title}</button>;
}
export function ResultModeSelector({ goalId, selectedSnapshot }: { goalId?: string; selectedSnapshot?: AgreedSnapshot | null }) {
  const { context, setContext } = useGlobalContext();
  const [error, setError] = useState<unknown>(null);
  type SnapshotItem = WorkbenchReadModels['snapshots.list']['items'][number];
  const selection = JSON.stringify([context?.scopePath, goalId ?? context?.goalId, context?.time]);
  const [pages, setPages] = useState<{ selection: string; cursor: string | null; items: SnapshotItem[]; nextCursor: string | null }>({ selection: '', cursor: null, items: [], nextCursor: null });
  const snapshots = useWorkbenchQuery<WorkbenchReadModels['snapshots.list']>('snapshots.list', context?.resultMode === 'agreed' ? goalRequest({ ...context, goalId: goalId ?? context.goalId, snapshotId: null }, {}, pages.selection === selection ? pages.cursor : null) : null);
  useEffect(() => {
    if (!snapshots.data) return;
    const response = snapshots.data;
    setPages(previous => ({ selection, cursor: previous.selection === selection ? previous.cursor : null, items: [...new Map([...(previous.selection === selection ? previous.items : []), ...response.items].map(item => [item.snapshot.id, item])).values()], nextCursor: response.page.nextCursor }));
  }, [selection, snapshots.data]);
  if (!context) return null;
  const items = pages.selection === selection ? pages.items : snapshots.data?.items ?? [];
  const selectedMissing = context.snapshotId !== null && !items.some(item => item.snapshot.id === context.snapshotId);
  const label = (snapshot: AgreedSnapshot) => `${snapshot.recordedAt} · редакция ${snapshot.revision}`;
  const change = (patch: Parameters<typeof setContext>[0]) => { setError(null); void setContext(patch).catch(setError); };
  return <section aria-label="Вид результата">
    <button type="button" aria-pressed={context.resultMode === 'current'} onClick={() => change({ resultMode: 'current', snapshotId: null })}>Текущий результат</button>
    <button type="button" aria-pressed={context.resultMode === 'agreed'} onClick={() => change({ resultMode: 'agreed', snapshotId: null })}>Согласованный результат</button>
    {context.resultMode === 'agreed' && <><QueryFeedback loading={snapshots.loading} error={snapshots.error} /><label>Согласованный срез<select value={context.snapshotId ?? ''} onChange={event => change({ goalId: goalId ?? context.goalId, snapshotId: event.target.value || null })}><option value="">Выберите опубликованный срез</option>{selectedMissing && <option value={context.snapshotId!}>{selectedSnapshot?.id === context.snapshotId ? label(selectedSnapshot) : `Выбранный срез ${context.snapshotId}`}</option>}{items.map(item => <option key={item.snapshot.id} value={item.snapshot.id}>{label(item.snapshot)}</option>)}</select></label>{pages.selection === selection && pages.nextCursor && <button type="button" disabled={snapshots.loading} onClick={() => setPages(previous => ({ ...previous, cursor: previous.nextCursor }))}>Показать ещё срезы</button>}{!context.snapshotId && <p>Согласованный срез не опубликован или не выбран</p>}</>}
    {error !== null && <p role="alert">{workbenchErrorMessage(error)}</p>}
  </section>;
}
