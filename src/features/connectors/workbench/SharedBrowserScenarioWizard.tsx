import { SharedBrowserCapture } from './SharedBrowserCapture';
import { useEffect, useRef, useState } from 'react';
import type { VersionRef } from '../../../domain/workbench/primitives';
import type { SourceDefinition } from '../../../domain/workbench/entities';
import type { RecordedBrowserStep } from '../../../domain/workbench/browser-scenario';
import type { FormDescription } from '../../knowledge/workbench-fields';
import type { WorkbenchReadModels } from '../../catalog/workbench-read-models';
import type { DraftOpenResult, DraftSaveResult } from '../../catalog/workbench-drafts';
import type { BrowserOwnDraft } from '../workbench-browser-binding';
import type { BrowserProfileView } from '../workbench-browser-profile';
import type { BrowserRecordingReview } from '../workbench-browser-recorder';
import type { BrowserRecordingStatus } from '../workbench-browser-runtime';
import type { BrowserScenarioTestResult } from '../workbench-browser-scenarios';
import { useGlobalContext, useWorkbench } from '../../../app/workbench/context';
import { useRetainedDataQuery } from '../../sources/workbench/data-client';
import { browserOwnRequest, browserProblem, useBrowserOperation } from './shared-browser-client';
import { SharedBrowserProfileForm } from './SharedBrowserProfileForm';
import '../workbench-browser.css';

export type SharedBrowserScenarioProps = { sourceRef: VersionRef; draftId: string | null; ownDraft?: BrowserOwnDraft; previewAssignmentRef?: VersionRef; onDraftSaved(draftId: string): void };
export function SharedBrowserScenarioWizard(props: SharedBrowserScenarioProps) {
  const { context } = useGlobalContext();
  const { session } = useWorkbench();
  const ownerKey = `${session?.personId ?? 'unassigned'}/${props.sourceRef.id}`;
  const [refresh, setRefresh] = useState(0);
  const form = useRetainedDataQuery<FormDescription>('forms.describe', context ? { ...browserOwnRequest, context, filter: { formKind: 'source_definition', ref: { entityType: 'source_definition', id: props.sourceRef.id }, ...(props.ownDraft ? { packageRef: { entityType: 'publication_package', id: props.ownDraft.packageId } } : {}) } } : null, refresh);
  const retained = useRef<{ id: string; form: FormDescription } | null>(null);
  if (form.data) retained.current = { id: ownerKey, form: form.data };
  const initialForm = retained.current?.id === ownerKey ? retained.current.form : null;
  return <section className="wb-browser-wizard" aria-label="Мастер сценария ОКО"><h2>Сценарий ОКО</h2>
    {form.error !== null && <div role="alert">{browserProblem(form.error)}<button type="button" onClick={() => setRefresh(v => v + 1)}>Повторить загрузку сценария</button></div>}
    {!context ? <p>Нет опубликованного контекста. Сначала создайте цель и собственный черновик источника.</p> : !initialForm ? <p role="status">Загружаем настройку источника…</p> : <ScenarioForm key={ownerKey} {...props} initial={initialForm.values as Partial<SourceDefinition> ?? {}} initialToken={initialForm.editToken} />}
  </section>;
}
function ScenarioForm({ sourceRef, draftId, ownDraft, previewAssignmentRef, onDraftSaved, initial, initialToken }: SharedBrowserScenarioProps & { initial: Partial<SourceDefinition>; initialToken: string | null }) {
  const { client, session, refreshSession } = useWorkbench(), { context } = useGlobalContext();
  const operation = useBrowserOperation();
  const prepare = session?.allowedCommands.includes('source.browser.record.start') ?? false;
  const [url, setUrl] = useState(initial.publicLocator ?? ''), [marker, setMarker] = useState<{ selector: string; label: string } | null>(null);
  const [profileRevision, refreshProfile] = useState(0), [recordingId, setRecordingId] = useState<string | null>(null), [recordingState, setRecordingState] = useState<BrowserRecordingStatus | null>(null);
  const [review, setReview] = useState<BrowserRecordingReview | null>(null), [parameters, setParameters] = useState<Record<string, string>>({}), [format, setFormat] = useState<'csv' | 'xlsx'>('csv'), [columns, setColumns] = useState('');
  const [preview, setPreview] = useState<BrowserScenarioTestResult | null>(null), [tested, setTested] = useState(''), [saved, setSaved] = useState(false), [notice, setNotice] = useState(''), [loginId, setLoginId] = useState<string | null>(null);
  const [binding, setBinding] = useState({ sourceRef, ...(ownDraft ? { ownDraft } : {}) });
  const own = useRetainedDataQuery<BrowserProfileView>('source.browser.own', { ...browserOwnRequest, filter: binding }, profileRevision);
  const captures = useRetainedDataQuery<WorkbenchReadModels['data.captures']>('data.captures', context && initial.goalId ? { ...browserOwnRequest, context: { ...context, goalId: initial.goalId } } : null, profileRevision);
  const accepted = captures.data?.items.filter(item => item.capture.sourceId === sourceRef.id && item.capture.result === 'accepted');
  const previous = accepted?.[0];
  const previousLocal = accepted?.find(item => item.obtainedVia === 'local-cache' && item.capture.rawArtifactId);
  const startButton = useRef<HTMLButtonElement | null>(null), finished = useRef(new Set<string>());
  const token = useRef(initialToken ?? ownDraft?.editToken ?? null), packageId = useRef(ownDraft?.packageId ?? null), sourceDraftId = useRef(ownDraft?.sourceDraftId ?? null), scenarioDraft = useRef(draftId);
  const sourceValue = useRef(initial), currentSourceRef = useRef(sourceRef);
  const staging = useRef<{ fingerprint: string; scenario?: DraftSaveResult; source?: DraftSaveResult } | null>(null);
  const retry = useRef<(() => Promise<void>) | null>(null);
  const perform = (action: () => Promise<void>) => { retry.current = action; void operation.run(action); };
  const definition = () => ({ sourceId: sourceRef.id, startUrl: review?.startUrl ?? url, authenticatedSelector: review?.authenticatedSelector ?? marker?.selector ?? '', steps: review?.steps ?? [], parameters, expectedExport: { format, requiredColumns: columns.split(/[\n,]+/).map(v => v.trim()).filter(Boolean) } });
  const currentDefinition = JSON.stringify(definition());
  const finish = async (id: string) => {
    const value = await operation.command<BrowserRecordingReview>('source.browser.record.finish', { recordingId: id, save: false });
    setReview(value.result); setParameters(Object.fromEntries(value.result.parameterNames.map(name => [name, '']))); setPreview(null); setTested('');
    setNotice(value.result.hasDownload ? 'Выгрузка завершена. Проверьте действия и заполните безопасные значения фильтров.' : 'Запись завершена без файла. Для проверки нужна завершённая выгрузка.');
    await refreshSession();
  };
  useEffect(() => {
    if (!recordingId || review) return;
    let active = true, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const { data } = await client.query<BrowserRecordingStatus>('source.browser.record.status', { ...browserOwnRequest, filter: { recordingId } });
        if (!active) return; setRecordingState(data);
        if (data.state === 'completed' && !finished.current.has(recordingId)) { finished.current.add(recordingId); perform(() => finish(recordingId)); }
      } catch (error) { if (active) setRecordingState({ state: 'interrupted', problem: { code: 'STATUS_UNAVAILABLE', message: browserProblem(error) } }); }
      if (active) timer = setTimeout(() => { void poll(); }, 1000);
    };
    void poll(); return () => { active = false; clearTimeout(timer); };
  }, [recordingId, review, client]);
  const saveCommand = async <T,>(name: string, payload: Record<string, unknown>) => { const receipt = await operation.command<T>(name, payload, token.current); token.current = receipt.editToken ?? token.current; return receipt.result; };
  const ensurePackage = async () => {
    if (sourceDraftId.current) return;
    const opened = await saveCommand<DraftOpenResult>('draft.open', { entityType: 'source_definition', ref: { entityType: 'source_definition', id: sourceRef.id }, packageId: packageId.current });
    sourceDraftId.current = opened.draftId;
    if (!packageId.current) {
      const queue = await client.query<WorkbenchReadModels['uor.queue']>('uor.queue', { ...browserOwnRequest, context: context! });
      packageId.current = queue.data.items.find(item => item.editToken === opened.editToken)?.packageRef.id ?? null;
      if (!packageId.current) throw Error('Пакет изменился. Откройте свой черновик в панели УОР.');
    }
  };
  const test = async () => {
    if (!review?.hasDownload || review.bindingProblem) throw Error('Повторите запись для актуальной настройки источника.');
    const candidate = definition(), fingerprint = JSON.stringify(candidate);
    if (review.parameterNames.some(name => !parameters[name]?.trim())) throw Error('Заполните безопасные значения всех фильтров.');
    if (!candidate.expectedExport.requiredColumns.length) throw Error('Укажите обязательные столбцы проверочной выгрузки.');
    await ensurePackage();
    if (!scenarioDraft.current) {
      const opened = await saveCommand<DraftOpenResult>('draft.open', { entityType: 'browser_scenario', ref: initial.browserScenarioRef ? { entityType: 'browser_scenario', id: initial.browserScenarioRef.id } : null, packageId: packageId.current }); scenarioDraft.current = opened.draftId;
    }
    // The tested definition must exist in the own package; this is local staging, never publication.
    if (staging.current?.fingerprint !== fingerprint) staging.current = { fingerprint };
    const progress = staging.current;
    const staged = progress.scenario ??= await saveCommand<DraftSaveResult>('source.browserScenario.draft.save', { draftId: scenarioDraft.current, definition: candidate });
    const source = progress.source ??= await saveCommand<DraftSaveResult>('source.draft.save', { draftId: sourceDraftId.current, definition: { ...sourceValue.current, browserScenarioRef: staged.versionRef } });
    sourceValue.current = { ...sourceValue.current, browserScenarioRef: staged.versionRef }; currentSourceRef.current = source.versionRef;
    setBinding({ sourceRef: source.versionRef, ownDraft: { packageId: packageId.current!, sourceDraftId: sourceDraftId.current!, editToken: token.current! } });
    setNotice('Проверяемые значения сохранены в собственном черновике; готовность ещё не подтверждена.');
    const result = await operation.command<BrowserScenarioTestResult>('source.browser.record.test', { draftId: scenarioDraft.current, ...(previewAssignmentRef ? { assignmentRef: previewAssignmentRef } : {}) }, token.current);
    setPreview(result.result); setTested(fingerprint); setSaved(false);
  };
  const save = async () => {
    if (!preview || tested !== currentDefinition || !scenarioDraft.current) throw Error('Проверьте текущие значения сценария перед сохранением.');
    const result = await saveCommand<DraftSaveResult>('source.browserScenario.draft.save', { draftId: scenarioDraft.current, definition: definition() });
    setBinding({ sourceRef: currentSourceRef.current, ownDraft: { packageId: packageId.current!, sourceDraftId: sourceDraftId.current!, editToken: token.current! } });
    setSaved(true); onDraftSaved(result.draftId); setNotice(result.complete ? 'Сценарий сохранён в собственном черновике.' : 'Черновик сохранён с замечаниями. Проверьте пакет УОР.');
  };
  const label = (step: RecordedBrowserStep) => step.action === 'goto' ? 'Открыть отчёт' : `${({ click: 'Нажать', fill: 'Заполнить фильтр', select: 'Выбрать фильтр', check: 'Изменить отметку', wait: 'Дождаться', download: 'Скачать выгрузку' })[step.action]}: ${step.locator.kind === 'label' ? step.locator.text : step.locator.kind === 'role' ? step.locator.name : 'выбранный элемент отчёта'}`;
  const filterLabel = (name: string) => { const step = review?.steps.find(s => (s.action === 'fill' || s.action === 'select') && s.parameter === name); return step && step.action !== 'goto' && step.locator.kind === 'label' ? step.locator.text : step && step.action !== 'goto' && step.locator.kind === 'role' ? step.locator.name : name; };
  const urlLocked = !prepare || operation.busy || operation.unknown || !!recordingId && !review;
  const changeUrl = (value: string) => {
    if (urlLocked) return;
    setUrl(value); setMarker(null); setReview(null); setRecordingId(null); setRecordingState(null);
    setPreview(null); setTested(''); setSaved(false); setNotice(''); setParameters({});
    staging.current = null; retry.current = null; operation.setError(null);
    sourceValue.current = { ...sourceValue.current, publicLocator: value };
  };
  return <div aria-busy={operation.busy}>
    <nav aria-label="Шаги сценария"><a href="#wb-browser-profile">1. Профиль</a><a href="#wb-browser-record">2. Запись</a><a href="#wb-browser-review">3. Проверка</a></nav>
    <p>СберБраузер откроется отдельным окном. Войдите обычным способом, выберите признак открытого отчёта, затем примените фильтры и скачайте CSV или XLSX. Завершённая выгрузка автоматически заканчивает запись. Пароли и коды вводятся только в браузере.</p>
    <section id="wb-browser-profile" tabIndex={-1}><h3>Личный браузер и профиль</h3>
      <label>Адрес отчёта<input type="url" value={url} readOnly={urlLocked} onChange={e => changeUrl(e.target.value)} /></label>
      <details open={!own.data?.configured}><summary>Настройка личного профиля</summary><SharedBrowserProfileForm sourceRef={binding.sourceRef} ownDraft={binding.ownDraft} reportUrl={url} onSaved={() => refreshProfile(v => v + 1)} /></details>
      {own.error !== null && <p role="alert">{browserProblem(own.error)}</p>}
      {!ownDraft && <div className="wb-browser-actions"><button type="button" disabled={operation.busy || !own.data?.configured} onClick={() => perform(async () => { const result = await operation.command<{ loginId: string }>('source.browser.login.open', { sourceRef }); setLoginId(result.result.loginId); })}>Открыть браузер для входа</button>
        {loginId && <button type="button" disabled={operation.busy} onClick={() => perform(async () => { const result = await operation.command<{ authenticated: boolean }>('source.browser.login.finish', { loginId }); setNotice(result.result.authenticated ? 'Вход подтверждён по открытому отчёту.' : 'Отчёт ещё не открыт. Завершите вход в браузере.'); if (result.result.authenticated) setLoginId(null); })}>Проверить вход</button>}
        </div>}{!ownDraft && initial.browserScenarioRef && initial.goalId && <SharedBrowserCapture goalId={initial.goalId} configured={!!own.data?.configured} previous={previousLocal ? { captureRef: previousLocal.ref, acceptedRows: previousLocal.capture.acceptedRows, rejectedRows: previousLocal.capture.rejectedRows } : undefined} onCaptured={() => refreshProfile(v => v + 1)} />}
    </section>
    {prepare && <section id="wb-browser-record" tabIndex={-1}><h3>Запись действий</h3>
      <button type="button" disabled={operation.busy || !own.data?.configured || !!recordingId && !review} onClick={() => perform(async () => { const selected = await operation.command<{ selector: string; label: string }>('source.browser.marker.select', { ...binding, startUrl: url }); setMarker(selected.result); })}>Выбрать признак открытого отчёта</button>
      {marker && <p>Признак отчёта: {marker.label}</p>}
      <button ref={startButton} type="button" disabled={operation.busy || !marker || !own.data?.configured || !!recordingId && !review} onClick={() => perform(async () => { const result = await operation.command<{ recordingId: string }>('source.browser.record.start', { ...binding, startUrl: url, authenticatedSelector: marker!.selector }); setReview(null); setPreview(null); setSaved(false); setRecordingId(result.result.recordingId); finished.current.delete(result.result.recordingId); setNotice('Окно браузера открыто. Выполните фильтры и скачайте выгрузку.'); })}>Открыть СберБраузер и записать действия</button>
    </section>}
    {recordingId && !review && <div className="wb-browser-actions"><p role="status">{recordingState?.state === 'completed' ? 'Выгрузка завершена.' : 'Запись в отдельном окне браузера.'}</p>{recordingState?.problem && <p role="alert">{recordingState.problem.message} ({recordingState.problem.code})</p>}<button type="button" disabled={operation.busy} onClick={() => { finished.current.add(recordingId); perform(() => finish(recordingId)); }}>Завершить запись и проверить шаги</button><button type="button" disabled={operation.busy} onClick={() => perform(async () => { await operation.command('source.browser.record.cancel', { recordingId }); setRecordingId(null); setNotice('Запись отменена.'); setTimeout(() => startButton.current?.focus(), 0); })}>Отменить запись</button></div>}
    {review && <section id="wb-browser-review" tabIndex={-1}><h3>Проверка шагов и фильтров</h3><ol>{review.steps.map((step, i) => <li key={i}>{label(step)}</li>)}</ol>{!!review.screenshotHandles.length && <details><summary>Снимки записанных действий</summary>{review.screenshotHandles.map((handle, index) => <img key={handle} className="wb-browser-screenshot" loading="lazy" alt={`Действие ${index + 1}: защищённый снимок отчёта`} src={`/api/v1/browser/recordings/${encodeURIComponent(review.recordingId)}/screenshots/${encodeURIComponent(handle)}`} />)}</details>}
      {review.bindingProblem && <p role="alert">Настройка или права изменились ({review.bindingProblem}). Запись доступна для личного просмотра; повторите запись перед сохранением.</p>}
      {review.parameterNames.map(name => <label key={name}>Значение фильтра «{filterLabel(name)}»<input value={parameters[name] ?? ''} readOnly={!prepare} onChange={e => { setParameters(value => ({ ...value, [name]: e.target.value })); setSaved(false); }} autoComplete="off" /></label>)}
      {prepare && <><label>Формат выгрузки<select value={format} onChange={e => setFormat(e.target.value as 'csv' | 'xlsx')}><option value="csv">CSV</option><option value="xlsx">Excel XLSX</option></select></label><label>Обязательные столбцы<input value={columns} onChange={e => setColumns(e.target.value)} placeholder="Названия через запятую" /></label><p>Для проверки значения сохраняются в собственном рабочем пакете. Факты и публикация от этого не меняются.</p><button type="button" disabled={operation.busy || !review.hasDownload || !!review.bindingProblem} onClick={() => perform(test)}>Проверить сценарий</button></>}
      {preview && <div><p>Принято для предпросмотра: {preview.acceptedPreviewRows}; отклонено: {preview.rejectedPreviewRows}.</p><p>Получено байтов: {preview.downloadedBytes}. {preview.complete ? 'Полнота выгрузки подтверждена.' : 'Полнота выгрузки не подтверждена.'}</p><ul>{preview.problems.map((p, i) => <li key={i}>{p.code}: {p.message}</li>)}</ul>{!!preview.previewRows?.length && <div className="wb-browser-table" tabIndex={0}><table><caption>Строки проверочной выгрузки</caption><thead><tr>{preview.columns?.map(column => <th key={column}>{column}</th>)}</tr></thead><tbody>{preview.previewRows.map((row, index) => <tr key={index}>{preview.columns?.map(column => <td key={column}>{row[column] ?? '—'}</td>)}</tr>)}</tbody></table><p>Показано первых {preview.previewRows.length} строк. Полнота проверяется по всей выгрузке.</p></div>}</div>}
      {prepare && <button type="button" disabled={operation.busy || !preview || tested !== currentDefinition || saved} onClick={() => perform(save)}>Сохранить сценарий в черновик</button>}
      {saved && <a href="/uor">Перейти к пакету УОР</a>}
    </section>}
    {operation.busy && <p role="status">{operation.job ? `Задание: ${operation.job.status} · ${operation.job.stage}` : 'Выполняем действие… Если открылся браузер, завершите ручной шаг и вернитесь сюда.'}</p>}
    {operation.error !== null && <div role="alert">{browserProblem(operation.error)}{operation.unknown && <p>Результат неизвестен. Повтор проверит ту же команду; новые записи не создаются.</p>}<button type="button" disabled={operation.busy} onClick={() => { if (retry.current) void operation.run(retry.current); }}>Повторить действие</button></div>}
    {notice && <p role="status" aria-live="polite">{notice}</p>}
    <p>{previous ? `Последний успешный набор: ${previous.capture.acceptedRows} строк; получен ${previous.capture.capturedAt}.` : 'Предыдущего успешного набора нет.'} При ошибке прежние данные сохраняются.</p>
  </div>;
}
