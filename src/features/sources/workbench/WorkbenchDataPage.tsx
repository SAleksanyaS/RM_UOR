import { useEffect, useRef, useState } from 'react';
import { RefreshCw, Database } from 'lucide-react';
import type { EntityRef, VersionRef } from '../../../domain/workbench/primitives';
import type { SourceDefinition } from '../../../domain/workbench/entities';
import type { FormDescription } from '../../knowledge/workbench-fields';
import type { WorkbenchReadModels } from '../../catalog/workbench-read-models';
import type { ImportApplyResult, ImportPreviewResult } from '../../tabular-import/workbench-import';
import type { CommandRequest, CommandResult, JobSnapshot } from '../../../server/workbench/protocol';
import { useGlobalContext, useWorkbench, useWorkbenchQuery } from '../../../app/workbench/context';
import { dataError, dataIssueLabel, dataPageRequest, formatDataTime, runDataCommand, observeDataJob, DataJobError, definitiveDataRejection, useRetainedDataQuery } from './data-client';
import { ImportPreview } from './ImportPreview';
import { LineagePanel } from './LineagePanel';
import { WorkbenchSourceSetupWizard } from './SourceSetupWizard';
import './data-views.css';

export function WorkbenchDataPage({processing=false,rawFileId}:{processing?:boolean;rawFileId?:string}={}) {
  const { context } = useGlobalContext();
  const { client, session, loading } = useWorkbench();
  const lifetime = useRef({ client, generation: 0 });
  if (lifetime.current.client !== client) lifetime.current = { client, generation: lifetime.current.generation + 1 };
  const [revision, setRevision] = useState(0);

  return <div className="wb-data"><div className="wb-page-toolbar"><div><h2>{processing?'Обработка сохранённого файла':'Общие данные целей'}</h2><p className="wb-status-note">Получения и факты для расчёта цели. Личные отчёты ОКО доступны в отдельной вкладке.</p></div><div className="wb-toolbar-actions"><button type="button" onClick={() => setRevision(v => v + 1)}><RefreshCw size={16} aria-hidden="true" />Обновить список данных</button></div></div><DataWorkspace rawFileId={rawFileId} refreshRevision={revision} key={JSON.stringify([context, window.location.search, session?.personId, session?.role, session?.allowedCommands, lifetime.current.generation])} /></div>;
}
function DataWorkspace({ refreshRevision,rawFileId }: { refreshRevision: number;rawFileId?:string }) {
  const { context, setContext } = useGlobalContext();
  const { session } = useWorkbench();
  const goals = useRetainedDataQuery<WorkbenchReadModels['goals.list']>('goals.list', context ? { ...dataPageRequest, context } : null, refreshRevision);
  const goal = goals.data?.items.find(item => item.goal.id === context?.goalId)?.goal;
  const sourceRef: EntityRef | null = goal ? { entityType: 'source_definition', id: goal.sourceId } : null;
  const source = useRetainedDataQuery<FormDescription>('forms.describe', context && sourceRef ? { ...dataPageRequest, context, filter: { formKind: 'source_definition', ref: sourceRef } } : null, refreshRevision);
  const definition = source.data?.values as Pick<SourceDefinition, 'kind' | 'mappingRef'> | null;
  const [setupOpen, setSetupOpen] = useState(false), [selectedCapture, setSelectedCapture] = useState<VersionRef | null>(null), [dataRevision, setDataRevision] = useState(0);
  const [lineage, setLineage] = useState<{ factRef: VersionRef } | { resultRef: VersionRef } | null>(() => {
    // Only server validation grants access; the URL keeps the goal/scope/time.
    const params = new URLSearchParams(window.location.search);
    if (params.has('fact') && params.has('result')) return null;
    const kind = params.has('result') ? 'result' : 'fact', id = params.get(kind), revision = Number(params.get(kind + 'Revision'));
    if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) || !Number.isSafeInteger(revision) || revision < 1) return null;
    return kind === 'result' ? { resultRef: { entityType: 'calculation_result', id, revision } } : { factRef: { entityType: 'observed_fact', id, revision } };
  });
  const applied = (result: ImportApplyResult) => { setSelectedCapture(result.captureRef); setDataRevision(v => v + 1); };
  return <>
    {goals.error !== null && <p role="alert">{dataError(goals.error, 'read')}</p>}
    {goals.loading && !goals.data && <p role="status">Загружаем цели…</p>}{!context?.goalId && <section className="wb-panel"><h2>Выберите цель</h2>{goals.data?.items.map(row => <button type="button" key={row.ref.id} onClick={() => { void setContext({ goalId: row.goal.id }).catch(() => undefined); }}>{row.goal.title}</button>)}</section>}
    {goal && <div className="wb-source-heading"><Database size={20} aria-hidden="true" /><h3>{goal.title}</h3></div>}
    {source.error !== null && <p role="alert">{dataError(source.error, 'read')}</p>}
    {definition && <><p>Штатный источник: {definition.kind === 'qlik' ? 'ОКО' : definition.kind === 'file' ? 'файл' : definition.kind === 'manual_status' ? 'ручной статус' : `Неизвестный тип: ${definition.kind}`}</p>
      {definition.kind === 'qlik' && <p>Выгрузка Excel/CSV, скачанная сценарием СберБраузера, относится к ОКО.</p>}
      {sourceRef && session?.allowedCommands.includes('source.draft.save') && <div className="wb-form-actions"><button type="button" onClick={() => setSetupOpen(true)}>Настроить источник</button></div>}
      {definition.kind === 'file' && context?.goalId && session?.allowedCommands.includes('import.preview') && session.allowedCommands.includes('import.apply') && <FileImport rawFileId={rawFileId} goalId={context.goalId} onApplied={applied} />}
      {definition.kind === 'qlik' && context?.goalId && <CaptureSource goalId={context.goalId} onCaptured={ref => { setSelectedCapture(ref); setDataRevision(v => v + 1); }} />}
    </>}
    {context && <CaptureList key={dataRevision + '/' + refreshRevision} selected={selectedCapture} onSelect={setSelectedCapture} onLineage={ref => setLineage({ factRef: ref })} />}
    {lineage && <LineagePanel {...lineage} onClose={() => setLineage(null)} />}
    {setupOpen && sourceRef && goal && <WorkbenchSourceSetupWizard rechecking={goals.loading || source.loading} sourceRef={sourceRef} goalRef={{ entityType: 'core_goal_definition', id: goal.id }} onClose={() => setSetupOpen(false)} />}
  </>;
}
export function FileImport({ goalId, onApplied,rawFileId }: { goalId: string;rawFileId?:string; onApplied(result: ImportApplyResult): void }) {
  const { client, loading } = useWorkbench();
  const [file, setFile] = useState<File | null>(null), [preview, setPreview] = useState<ImportPreviewResult | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(null), [stage, setStage] = useState('');
  const owner = useRef<AbortController | null>(null), operation = useRef<CommandRequest | null>(null),stageRequest=useRef<CommandRequest|null>(null);
  useEffect(() => { const controller = new AbortController(); owner.current = controller; return () => controller.abort(); }, []);
  const inspect = async () => {
    const current = owner.current; if ((!file&&!rawFileId) || !current || busy || loading) return;
    setBusy(true); setError(null); setPreview(null);
    try {
      if (!operation.current) {
        const handle = rawFileId ? {data:await runDataCommand<{fileHandle:string}>(client,stageRequest.current??=( {commandId:crypto.randomUUID(),name:'raw.file.stageForImport',baseRevision:null,payload:{id:rawFileId}}),current.signal,setStage)} : await client.upload(file!, 'goal-import');
        if (current.signal.aborted) return;
        operation.current = { commandId: crypto.randomUUID(), name: 'import.preview', baseRevision: null, payload: { goalId, fileHandle: handle.data.fileHandle } };
      }
      const result = await runDataCommand<ImportPreviewResult>(client, operation.current, current.signal, setStage);
      if (!current.signal.aborted) setPreview(result);
    } catch (failure) { if (!current.signal.aborted) setError(failure); }
    finally { if (!current.signal.aborted) setBusy(false); }
  };
  return <section aria-label="Загрузка файла" className="wb-panel"><h2>{rawFileId?'Проверка сохранённого исходника':'Загрузка файла'}</h2>{rawFileId?<p>Исходный файл выбран. Профиль разбора, точные столбцы и преобразования задаются в настройке источника цели. Проверка создаёт отдельный вариант; принятие строк выполняется явно.</p>:<label className="wb-field"><span>Файл данных</span><input type="file" accept=".csv,.tsv,.xlsx" disabled={busy} onChange={e => { operation.current = null; setPreview(null); setError(null); setFile(e.target.files?.[0] ?? null); }} /></label>}
    <div className="wb-form-actions"><button className="wb-primary-button" type="button" disabled={(!file&&!rawFileId) || busy || loading} onClick={() => { void inspect(); }}>Проверить файл</button></div>
    {busy && <p role="status">Проверяем файл: {stage}</p>}{error !== null && <p role="alert">{dataError(error)}</p>}
    {preview&&rawFileId&&<button disabled={busy} onClick={()=>{operation.current=null;setPreview(null);}}>Проверить другой вариант обработки</button>}
    {preview && <ImportPreview key={preview.previewToken} preview={preview} onApplied={onApplied} />}
  </section>;
}
function CaptureSource({ goalId, onCaptured }: { goalId: string; onCaptured(ref: VersionRef): void }) {
  const { client, session, loading } = useWorkbench();
  const { navigate } = useGlobalContext();
  const [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(null), [stage, setStage] = useState('');
  const [job, setJob] = useState<JobSnapshot | null>(null);
  const owner = useRef<AbortController | null>(new AbortController()), request = useRef<CommandRequest | null>(null);
  const controlRequests = useRef(new Map<string, CommandRequest>());
  useEffect(() => { const controller = owner.current && !owner.current.signal.aborted ? owner.current : new AbortController(); owner.current = controller; return () => controller.abort(); }, []);
  const allowed = !loading && session?.allowedCommands.includes('source.capture');
  const capture = async (fresh = false) => {
    const current = owner.current; if (!current || busy || !allowed) return;
    if (fresh) { if (!job || !['failed', 'cancelled'].includes(job.status)) return; request.current = null; setJob(null); controlRequests.current.clear(); }
    request.current ??= { commandId: crypto.randomUUID(), name: 'source.capture', baseRevision: null, payload: { goalId } };
    setBusy(true); setError(null);
    try { const result = await runDataCommand<{ captureRef: VersionRef }>(client, request.current, current.signal, setStage, snapshot => { if (!current.signal.aborted) setJob(snapshot); }); if (!current.signal.aborted) { onCaptured(result.captureRef); request.current = null; setJob(null); } }
    catch (failure) { if (!current.signal.aborted) setError(failure); }
    finally { if (!current.signal.aborted) setBusy(false); }
  };
  const control = async (name: string, payload: Record<string, unknown>) => {
    const current = owner.current; if (!current || !job || busy || loading || !session?.allowedCommands.includes(name)) return;
    setBusy(true); setError(null);
    let command = controlRequests.current.get(name);
    if (!command) { command = { commandId: crypto.randomUUID(), name, baseRevision: null, payload }; controlRequests.current.set(name, command); }
    try {
      const response = await client.command<CommandResult>(command);
      controlRequests.current.delete(name);
      const result = await observeDataJob<{ captureRef: VersionRef }>(client, 'jobId' in response.data ? response.data.jobId : job.jobId, current.signal, setStage, snapshot => { if (!current.signal.aborted) setJob(snapshot); });
      if (!current.signal.aborted) { onCaptured(result.captureRef); request.current = null; setJob(null); }
    } catch (failure) { if (!current.signal.aborted) { if (definitiveDataRejection(failure)) controlRequests.current.delete(name); setError(failure); if (failure instanceof DataJobError) setJob(failure.job); } }
    finally { if (!current.signal.aborted) setBusy(false); }
  };
  const terminal = job && ['failed', 'cancelled'].includes(job.status);
  const actions: Array<{ name: string; label: string; payload: Record<string, unknown> }> = [];
  if (job?.nextAction?.enabled && job.nextAction.commandName && ['job.openAuth', 'job.retry', 'job.cancel'].includes(job.nextAction.commandName) && job.nextAction.payload) actions.push({ name: job.nextAction.commandName, label: job.nextAction.label, payload: job.nextAction.payload });
  if (job?.retryAvailable && !actions.some(a => a.name === 'job.retry')) actions.push({ name: 'job.retry', label: 'Продолжить получение', payload: { jobId: job.jobId } });
  if (job?.cancelAvailable && !actions.some(a => a.name === 'job.cancel')) actions.push({ name: 'job.cancel', label: 'Отменить получение', payload: { jobId: job.jobId } });
  return <section className="wb-panel" aria-label="Получение ОКО"><h3>Штатное получение из ОКО</h3><p className="wb-status-note">Результат появится среди принятых наборов после завершения получения.</p><div className="wb-form-actions">
    {!terminal && <button type="button" disabled={busy || !allowed} onClick={() => { void capture(); }}>{job ? 'Обновить состояние получения' : request.current ? 'Проверить прежнее получение ОКО' : 'Получить данные ОКО'}</button>}
    {terminal && <button type="button" disabled={busy || !allowed} onClick={() => { void capture(true); }}>Начать новое получение ОКО</button>}
    </div>{job && <><p role="status">{({ queued: 'Получение в очереди', running: 'Получаем данные', waiting_user: 'Требуется действие пользователя', retry_wait: 'Ожидается повтор', succeeded: 'Получение завершено', partial: 'Получено с замечаниями', failed: 'Получение остановлено с ошибкой', cancelled: 'Получение отменено', interrupted: 'Получение прервано' } as Record<string, string>)[job.status] ?? `Неизвестное состояние: ${job.status}`}</p><details className="wb-technical-details"><summary>Ссылка на операцию</summary><code>{job.jobId}</code></details></>}
    {actions.filter(action => session?.allowedCommands.includes(action.name)).map(action => <button type="button" key={action.name} disabled={busy || loading} onClick={() => { void control(action.name, action.payload); }}>{action.label}</button>)}
    {job?.nextAction?.enabled && job.nextAction.route && <button type="button" onClick={() => navigate(job.nextAction!.route!)}>{job.nextAction.label}</button>}
    {busy && <p role="status">Получаем данные: {stage}</p>}{error !== null && <p role="alert">{dataError(error)} Последний успешный набор сохранён.</p>}
  </section>;
}
function CaptureList({ selected, onSelect, onLineage }: { selected: VersionRef | null; onSelect(ref: VersionRef): void; onLineage(ref: VersionRef): void }) {
  const { context } = useGlobalContext();
  const [cursor, setCursor] = useState<string | null>(null), [layer, setLayer] = useState<'raw' | 'enriched'>('raw'), [issuesOnly, setIssuesOnly] = useState(false);
  const captures = useWorkbenchQuery<WorkbenchReadModels['data.captures']>('data.captures', context ? { ...dataPageRequest, context, page: { limit: 100, cursor } } : null);
  const capture = selected ?? captures.data?.items[0]?.ref ?? null;
  const selectedIssues = captures.data?.items.find(item => item.ref.id === capture?.id)?.issues ?? [];
  const [rowCursor, setRowCursor] = useState<string | null>(null);
  const rows = useWorkbenchQuery<WorkbenchReadModels['data.rows']>('data.rows', context && capture ? { ...dataPageRequest, context, filter: { captureRef: capture, layer, issuesOnly }, page: { limit: 100, cursor: rowCursor } } : null);
  return <section className="wb-panel"><h2>Принятые наборы</h2>{captures.error !== null && <p role="alert">{dataError(captures.error, 'read')}</p>}{captures.data?.items.length === 0 && <p>Нет данных. Получите штатный источник или загрузите файл для цели с файловым режимом.</p>}
    {captures.loading && !captures.data && <p role="status">Загружаем принятые наборы…</p>}<ul className="wb-capture-list">{captures.data?.items.map(item => <li key={item.ref.id}><div><strong>{new Date(item.capture.capturedAt).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })} МСК</strong><p>{item.obtainedVia === 'git' ? 'Общий набор из Git' : 'Локальный набор'} · принято: {item.capture.acceptedRows} · не принято: {item.capture.rejectedRows}</p>{item.latestAttemptIncomplete && <span className="wb-badge wb-badge-confirmation">Неполный набор</span>}</div><button type="button" aria-pressed={item.ref.id === capture?.id} aria-label={'Открыть набор от ' + item.capture.capturedAt} onClick={() => { onSelect(item.ref); setRowCursor(null); }}>{item.ref.id === capture?.id ? 'Открыт' : 'Открыть строки'}</button></li>)}</ul>
    {captures.data?.page.nextCursor && <button type="button" onClick={() => { setCursor(captures.data!.page.nextCursor); }}>Следующая страница наборов</button>}
    {selectedIssues.length > 0 && <section aria-label="Проблемы набора"><h3>Проблемы набора</h3><ul>{selectedIssues.map((issue, index) => <li key={index}>{dataIssueLabel(issue.code, issue.message)}</li>)}</ul></section>}
    {capture && <><div className="wb-data-layer-toolbar"><button type="button" aria-pressed={layer === 'raw'} onClick={() => { setLayer('raw'); setRowCursor(null); }}>Исходные строки</button><button type="button" aria-pressed={layer === 'enriched'} onClick={() => { setLayer('enriched'); setRowCursor(null); }}>Обогащённые строки</button><label><input type="checkbox" checked={issuesOnly} onChange={e => { setIssuesOnly(e.target.checked); setRowCursor(null); }} />Только строки с проблемами</label></div>
      {rows.error !== null && <p role="alert">{dataError(rows.error, 'read')}</p>}{rows.loading && <p role="status">Загружаем строки…</p>}
      {rows.data && <section role="region" tabIndex={0} aria-label={layer === 'raw' ? 'Исходные строки' : 'Обогащённые строки'}><p>{layer === 'raw' ? 'Исходные значения сохранены без изменения.' : 'Обогащённые строки отделены от исходного файла и расчёта.'}</p><table className="wb-data-table"><thead><tr><th>Ключ строки</th><th>Значения</th><th>Дата / период</th><th>Происхождение и проблемы</th></tr></thead><tbody>{rows.data.items.map(item => <tr key={item.row.rowKey}><td>{item.row.rowKey}</td><td>{item.layer === 'raw' ? Object.entries(item.row.cells).map(([name, cell]) => `${name}: ${cell.original ?? 'пусто'}`).join('; ') : Object.entries({ ...item.row.dimensions, ...item.row.numbers }).map(([name, value]) => `${name}: ${value ?? 'Нет данных'}`).join('; ')}</td><td>{item.layer === 'raw' ? 'Как в исходном файле' : formatDataTime(item.row.businessTime)}</td><td>{item.issues.map(issue => dataIssueLabel(issue.code, issue.message)).join('; ')}{item.layer === 'enriched' && item.factRefs.map(ref => <button key={ref.id + '/' + ref.revision} type="button" onClick={() => onLineage(ref)}>Происхождение</button>)}</td></tr>)}</tbody></table>{rows.data.page.nextCursor && <button type="button" onClick={() => setRowCursor(rows.data!.page.nextCursor)}>Следующая страница строк</button>}</section>}
    </>}
  </section>;
}
