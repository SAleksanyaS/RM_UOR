import { SharedBrowserScenarioWizard, type SharedBrowserScenarioProps } from './SharedBrowserScenarioWizard';
import React, { useEffect, useRef, useState } from 'react';
import type { SourceParsingProfile } from '../../../domain/workbench/entities/sources';
import type { OkoDictionaryMapping, OkoMapping } from '../workbench-workflow-contracts';
import { useWorkbench } from './WorkbenchProvider';
import { WorkbenchBrowserProfileForm } from './BrowserProfileForm';
import { defaultParsingProfile, ParsingProfileForm } from './ParsingProfileForm';
import { useUnsavedChanges } from '../../../app/workbench/use-unsaved-changes';
import { PersonalOperationStatus } from './PersonalOperationStatus';

const dictionaryFields: Array<[keyof OkoDictionaryMapping, string, boolean?]> = [ ['key', 'Ключ продукта в ОКО'], ['productId', 'ID продукта (UUID)'], ['productName', 'Название продукта'], ['clusterId', 'ID кластера (UUID)'], ['clusterName', 'Название кластера'], ['ditId', 'ID ДИТ (UUID)'], ['ditName', 'Название ДИТ'], ['clusterLeaderId', 'ID руководителя кластера (UUID)'], ['clusterLeaderName', 'Руководитель кластера'], ['productLeaderId', 'ID руководителя продукта (UUID)'], ['productLeaderName', 'Руководитель продукта'], ['teamId', 'ID команды (UUID)', true], ['teamName', 'Название команды', true] ];
type ColumnPair = { name: string; column: string };
const pairs = (value: Record<string, string>) => Object.entries(value).map(([name, column]) => ({ name, column }));
const record = (value: ColumnPair[]) => Object.fromEntries(value.filter(pair => pair.name.trim() && pair.column).map(pair => [pair.name.trim(), pair.column]));
export function ColumnSelect({ label, value, columns, onChange, required = false }: { label: string; value: string | null; columns: string[]; onChange(value: string): void; required?: boolean }) {
  const id = React.useId(); return <div className="oko-field"><label htmlFor={id}>{label}</label><select id={id} value={value ?? ''} onChange={event => onChange(event.target.value)} required={required}><option value="">{required ? 'Выберите столбец' : 'Не используется'}</option>{columns.map(column => <option key={column} value={column}>{column}</option>)}</select></div>;
}
export function PreviewTable({ rows, columns, label }: { rows: Record<string, string | null>[]; columns?: string[]; label: string }) {
  const keys = columns ?? [...new Set(rows.flatMap(row => Object.keys(row)))];
  if (!rows.length) return <p className="oko-muted">Пока нет строк для предпросмотра.</p>;
  return <div className="oko-table-scroll" role="region" aria-label={label} tabIndex={0}><table><caption>{label} · показано {rows.length} строк</caption><thead><tr>{keys.map(key => <th scope="col" key={key}>{key}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={index}>{keys.map(key => <td key={key}>{row[key] ?? '—'}</td>)}</tr>)}</tbody></table></div>;
}
function PairEditor({ label, value, onChange, columns }: { label: string; value: ColumnPair[]; onChange(value: ColumnPair[]): void; columns: string[] }) {
  return <fieldset className="oko-pairs"><legend>{label}</legend>{value.map((pair, index) => <div className="oko-pair" key={index}><div className="oko-field"><label htmlFor={label+index}>Имя поля {index + 1}</label><input id={label+index} value={pair.name} onChange={event => onChange(value.map((item, i) => i === index ? { ...item, name: event.target.value } : item))}/></div><ColumnSelect label={`Столбец «${pair.name || index + 1}»`} value={pair.column} columns={columns} onChange={column => onChange(value.map((item, i) => i === index ? { ...item, column } : item))}/><button type="button" className="oko-quiet" aria-label={`Удалить поле ${pair.name || index + 1}`} onClick={() => onChange(value.filter((_, i) => i !== index))}>Удалить</button></div>)}<button type="button" className="oko-quiet" onClick={() => onChange([...value, { name: '', column: '' }])}>Добавить поле</button></fieldset>;
}
function PersonalBrowserScenarioWizard({ setupOnly = false, onDirtyChange }: { setupOnly?: boolean; onDirtyChange?(dirty: boolean): void } = {}) {
  const { current: workflow, session, run, client, busy, job } = useWorkbench();
  if (!workflow) return null;
  return <WorkflowForm setupOnly={setupOnly} key={workflow.workflowId} personId={session?.personId ?? null} workflow={workflow} prepare={session?.allowedCommands.includes('source.browser.record.start') ?? false} run={run} client={client} busy={busy} job={job} onDirtyChange={onDirtyChange}/>;
}
function WorkflowForm({ workflow: w, personId, prepare, run, client, busy, job, setupOnly, onDirtyChange }: { setupOnly: boolean; workflow: NonNullable<ReturnType<typeof useWorkbench>['current']>; personId: string | null; prepare: boolean; run: ReturnType<typeof useWorkbench>['run']; client: ReturnType<typeof useWorkbench>['client']; busy: boolean; job: ReturnType<typeof useWorkbench>['job']; onDirtyChange?(dirty: boolean): void }) {
  const [url, setUrl] = useState(w.reportUrl), [parsing, setParsing] = useState<SourceParsingProfile>(w.parsingProfile);
  const [parameters, setParameters] = useState(w.parameters), [rowKeys, setRowKeys] = useState(w.mapping?.rowKeyColumns ?? []);
  const [product, setProduct] = useState(w.mapping?.productKeyColumn ?? ''), [date, setDate] = useState(w.mapping?.dateColumn ?? ''), [unit, setUnit] = useState(w.mapping?.unitColumn ?? ''), [fixedUnit, setFixedUnit] = useState(w.mapping?.fixedUnitCode ?? '');
  const [numbers, setNumbers] = useState<ColumnPair[]>(w.mapping ? pairs(w.mapping.numberColumns) : [{ name: 'value', column: '' }]), [dimensions, setDimensions] = useState<ColumnPair[]>(pairs(w.mapping?.dimensionColumns ?? {}));
  const [dictionary, setDictionary] = useState<Partial<OkoDictionaryMapping>>(w.dictionary.mapping ?? {}), [dictionaryParsing, setDictionaryParsing] = useState<SourceParsingProfile>(defaultParsingProfile), [file, setFile] = useState<File | null>(null);
  const [profileDirty, setProfileDirty] = useState(false), savedDictionaryParsing = useRef(JSON.stringify(defaultParsingProfile));
  const dirty = profileDirty || url !== w.reportUrl || JSON.stringify(parsing) !== JSON.stringify(w.parsingProfile)
    || JSON.stringify(w.recording.parameterNames.map(name => parameters[name] ?? '')) !== JSON.stringify(w.recording.parameterNames.map(name => w.parameters[name] ?? ''))
    || JSON.stringify({ rowKeys, product, date, unit, fixedUnit: unit ? '' : fixedUnit, numbers, dimensions }) !== JSON.stringify({ rowKeys: w.mapping?.rowKeyColumns ?? [], product: w.mapping?.productKeyColumn ?? '', date: w.mapping?.dateColumn ?? '', unit: w.mapping?.unitColumn ?? '', fixedUnit: w.mapping?.unitColumn ? '' : w.mapping?.fixedUnitCode ?? '', numbers: w.mapping ? pairs(w.mapping.numberColumns) : [{ name: 'value', column: '' }], dimensions: pairs(w.mapping?.dimensionColumns ?? {}) })
    || dictionaryFields.some(([key]) => (dictionary[key] ?? '') !== (w.dictionary.mapping?.[key] ?? '')) || file !== null || JSON.stringify(dictionaryParsing) !== savedDictionaryParsing.current;
  useUnsavedChanges(dirty);
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  const loginKey = `uor.oko.login.v1${client.storageScope ?? ''}:${personId ?? 'unassigned'}:${w.workflowId}`;
  const [login, updateLogin] = useState<string | null>(() => { try { return sessionStorage.getItem(loginKey); } catch { return null; } }), [localError, setLocalError] = useState(''), [notice, setNotice] = useState('');
  const setLogin = (id: string | null) => { updateLogin(id); try { if (id) sessionStorage.setItem(loginKey, id); else sessionStorage.removeItem(loginKey); } catch { /* Own close-browser recovery remains available without browser storage. */ } };
  const finished = useRef(new Set<string>()), [uploading, setUploading] = useState(false), [ownRecordingId, setOwnRecordingId] = useState<string | null>(null);
  const execute = async (name: string, payload: Record<string, unknown>) => {
    setLocalError(''); setNotice('');
    if (name === 'source.browser.record.start' || name === 'source.browser.record.cancel') setOwnRecordingId(null);
    try {
      const value = await run(name, name.startsWith('job.') ? payload : { workflowId: w.workflowId, ...payload });
      if (name === 'source.browser.record.start') {
        const recordingId = (value as { recording?: { recordingId?: unknown } } | null)?.recording?.recordingId;
        if (typeof recordingId === 'string') setOwnRecordingId(recordingId);
      }
      return value;
    } catch (failure) { setLocalError((failure as Error).message); return null; }
  };
  // Reading a pending recording in another tab must never finish it. Only this
  // form's confirmed start arms auto-finish; an explicit finish recovers reloads.
  useEffect(() => { const id = w.recording.recordingId; if (prepare && !busy && w.recording.state === 'completed' && !w.recording.steps.length && id && id === ownRecordingId && !finished.current.has(id)) { finished.current.add(id); void execute('source.browser.record.finish', { recordingId: id }); } }, [w.recording.state, w.recording.recordingId, w.recording.steps.length, ownRecordingId, prepare, busy]);
  const revision = { expectedRevision: w.revision };
  const disabled = busy || uploading;
  const mapping: OkoMapping = { rowKeyColumns: rowKeys, productKeyColumn: product || null, numberColumns: record(numbers), dimensionColumns: record(dimensions), dateColumn: date || null, unitColumn: unit || null, fixedUnitCode: unit ? null : fixedUnit || null };
  const saveMapping = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!rowKeys.length || !Object.keys(mapping.numberColumns).length) { setLocalError('Выберите ключ строки и хотя бы один числовой столбец.'); return; }
    if (new Set(numbers.map(item => item.name.trim())).size !== numbers.length || new Set(dimensions.map(item => item.name.trim())).size !== dimensions.length) { setLocalError('Имена полей не должны повторяться.'); return; }
    const value = await execute('source.browser.mapping.save', { ...revision, mapping, parameters: Object.fromEntries(w.recording.parameterNames.map(name => [name, parameters[name] ?? ''])), parsingProfile: parsing });
    if (value) setNotice('Сопоставление и значения фильтров сохранены. Можно проверить сценарий.');
  };
  const importDirectory = async () => {
    if (!file) return; setUploading(true); setLocalError('');
    try { const fileHandle = await client.upload(file); const value = await execute('source.browser.directory.preview', { fileHandle, parsingProfile: dictionaryParsing }); if (value) { savedDictionaryParsing.current = JSON.stringify(dictionaryParsing); setFile(null); } }
    catch (failure) { setLocalError((failure as Error).message); } finally { setUploading(false); }
  };
  const stepLabel = (step: typeof w.recording.steps[number]) => ({ goto: 'Открыть отчёт', click: 'Нажать', fill: 'Заполнить фильтр', select: 'Выбрать фильтр', check: 'Изменить отметку', wait: 'Дождаться готовности', download: 'Скачать выгрузку' })[step.action];
  return <div className="oko-workflow">
    {!setupOnly && <div className="oko-workflow-heading"><div><span className="oko-eyebrow">Личный сценарий</span><h1>{w.title}</h1><p>Отчёт → запись → сопоставление → справочник → проверенный файл</p></div><span className="oko-badge">Локальный предпросмотр</span></div>}
    {!setupOnly && <p className="oko-note">Результат сохраняется на этом рабочем месте. Проверка сценария не публикует данные и не подтверждает цель.</p>}
    {busy && <p className="oko-note" role="status" aria-live="polite">Выполняем действие. Если открылось окно браузера, завершите ручной шаг в нём; затем вернитесь сюда. Можно просматривать настройки, пока идёт операция.</p>}
    {localError && <div role="alert" className="oko-error">{localError}</div>}{notice && <p role="status" className="oko-success">{notice}</p>}
    {w.warnings.length > 0 && <ul className="oko-warning">{w.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
    <section className="oko-card" aria-labelledby="oko-profile-title"><div className="oko-section-title"><span>1</span><h2 id="oko-profile-title">Браузер и ручной вход</h2></div>
      <div className="oko-field"><label htmlFor="report-url">Адрес отчёта</label><input id="report-url" type="url" value={url} onChange={event => setUrl(event.target.value)} readOnly={!prepare} placeholder="https://…" autoComplete="url"/></div>
      <details open={!w.profile.configured}><summary>{w.profile.configured ? 'Личный профиль настроен · изменить' : 'Настроить личный профиль браузера'}</summary><WorkbenchBrowserProfileForm workflow={w} reportUrl={url} busy={disabled} onDirtyChange={setProfileDirty} onSave={profile => run('source.browser.profile.set', { workflowId: w.workflowId, ...revision, reportUrl: url, profile })}/></details>
      <p className="oko-muted">Войдите в открытом браузере обычным способом. Пароли и коды вводятся только на странице входа; запись в этот момент выключена.</p>
      <div className="oko-actions"><button disabled={disabled || !w.profile.configured} onClick={() => void execute('source.browser.login.open', {}).then(value => { if (value && typeof value === 'object' && 'loginId' in value) setLogin(String(value.loginId)); })}>Открыть браузер для входа</button>{login && <button disabled={disabled} onClick={() => void execute('source.browser.login.finish', { loginId: login }).then(value => { if (value) { setLogin(null); setNotice('Ручной этап завершён. Выберите признак открытого отчёта.'); } })}>Завершить ручной вход</button>}</div>
      {login && <p role="status">Окно входа открыто. После входа вернитесь сюда и завершите ручной этап.</p>}
      <details><summary>Окно осталось открытым или профиль занят</summary><p className="oko-muted">Если вы обновили страницу или потеряли окно ручного входа, закройте собственные окна автоматизации и повторите нужный шаг. Сохранённый сценарий и последний результат останутся.</p><button className="oko-quiet" disabled={uploading} onClick={() => void execute('source.browser.record.cancel', {}).then(value => { if (value) { setLogin(null); setNotice('Собственные окна автоматизации закрыты. Профиль освобождён.'); } })}>Закрыть окна браузера и освободить профиль</button></details>
      {prepare && <div className="oko-marker"><h3>Признак открытого отчёта</h3><p>{w.marker ? `Выбрано: ${w.marker.label}` : 'Выберите в браузере заголовок или другой однозначный элемент отчёта после входа.'}</p><button disabled={disabled || !w.profile.configured || !url} onClick={() => void execute('source.browser.marker.select', { reportUrl: url })}>{w.marker ? 'Выбрать другой элемент отчёта' : 'Выбрать элемент отчёта в браузере'}</button></div>}
    </section>
    {prepare && <><section className="oko-card" aria-labelledby="oko-record-title"><div className="oko-section-title"><span>2</span><h2 id="oko-record-title">Запись действий</h2></div><p>Настройте формат выгрузки. Затем в браузере примените фильтры и скачайте CSV или XLSX. Запись завершится автоматически, когда файл будет полностью получен.</p><details><summary>Как читать файл CSV / XLSX</summary><ParsingProfileForm value={parsing} onChange={setParsing}/></details>
      <div className="oko-actions"><button className="oko-primary" disabled={disabled || !w.marker || !w.profile.configured || w.recording.state === 'recording'} onClick={() => void execute('source.browser.record.start', { ...revision, reportUrl: url, parsingProfile: parsing })}>Начать запись действий</button>{w.recording.recordingId && <button disabled={disabled} onClick={() => void execute('source.browser.record.finish', { recordingId: w.recording.recordingId })}>Получить записанные шаги</button>}{['recording', 'completed'].includes(w.recording.state) && <button className="oko-quiet" disabled={uploading} onClick={() => void execute('source.browser.record.cancel', {})}>Отменить запись</button>}</div>
      <p role="status" aria-live="polite" className="oko-status">{({ idle: 'Готово к записи', recording: 'Идёт запись в браузере. Завершите её скачиванием файла.', completed: w.columns.length ? 'Запись завершена. Шаги и образец файла получены.' : 'Скачивание завершено. Получаем шаги и столбцы…', failed: 'Запись остановлена с ошибкой', interrupted: 'Запись прервана перезапуском. Начните новую запись.' })[w.recording.state]}</p>
      {w.recording.problem && <details className="wb-operation-details"><summary>Сведения о прерванной записи</summary><p>{w.recording.problem.message}</p><code>{w.recording.problem.code}</code></details>}
      {!!w.recording.steps.length && <ol className="oko-recorded-steps">{w.recording.steps.map((step, index) => <li key={index}>{stepLabel(step)}{'parameter' in step ? ` «${step.parameter}»` : ''}</li>)}</ol>}
      {!!w.sampleRows.length && <PreviewTable rows={w.sampleRows} columns={w.columns} label="Образец скачанного отчёта"/>}
    </section>
    {!!w.columns.length && <section className="oko-card" aria-labelledby="oko-map-title"><div className="oko-section-title"><span>3</span><h2 id="oko-map-title">Сопоставление столбцов</h2></div><form onSubmit={event => void saveMapping(event)}>
      {!!w.recording.parameterNames.length && <fieldset><legend>Подтвердите безопасные значения фильтров</legend>{w.recording.parameterNames.map(name => <div className="oko-field" key={name}><label htmlFor={'parameter-'+name}>Значение фильтра «{name}»</label><input id={'parameter-'+name} value={parameters[name] ?? ''} onChange={event => setParameters(previous => ({ ...previous, [name]: event.target.value }))} autoComplete="off" required/></div>)}<small>Значения не записываются из браузера. Укажите их один раз для повторения сценария.</small></fieldset>}
      <fieldset><legend>Уникальный ключ строки</legend><div className="oko-checkboxes">{w.columns.map(column => <label key={column}><input type="checkbox" checked={rowKeys.includes(column)} onChange={event => setRowKeys(previous => event.target.checked ? [...previous, column] : previous.filter(value => value !== column))}/>{column}</label>)}</div></fieldset>
      <div className="oko-form-grid"><ColumnSelect label="Ключ продукта для справочника" value={product} columns={w.columns} onChange={setProduct}/><ColumnSelect label="Дата данных" value={date} columns={w.columns} onChange={setDate}/><ColumnSelect label="Единица измерения — столбец" value={unit} columns={w.columns} onChange={setUnit}/><div className="oko-field"><label htmlFor="fixed-unit">Единица измерения — постоянная</label><input id="fixed-unit" value={fixedUnit} onChange={event => setFixedUnit(event.target.value)} disabled={!!unit} placeholder="Например, %"/></div></div>
      <PairEditor label="Числовые значения" value={numbers} onChange={setNumbers} columns={w.columns}/><PairEditor label="Дополнительные признаки" value={dimensions} onChange={setDimensions} columns={w.columns}/>
      <details><summary>Формат чисел и дат</summary><ParsingProfileForm value={parsing} onChange={setParsing} prefix="mapping"/></details><button className="oko-primary" disabled={disabled} type="submit">Сохранить сопоставление и фильтры</button>
    </form></section>}
    <section className="oko-card" aria-labelledby="oko-directory-title"><div className="oko-section-title"><span>4</span><h2 id="oko-directory-title">Обогащение из справочника</h2></div><p>Загрузите CSV или XLSX со связями продукта, кластера, руководителей и команды. Идентификаторы UUID должны быть в файле; названия не заменяют идентификаторы.</p>
      <div className="oko-field"><label htmlFor="directory-file">Файл справочника</label><input id="directory-file" type="file" accept=".csv,.xlsx" onChange={event => setFile(event.target.files?.[0] ?? null)} disabled={disabled}/></div><details><summary>Формат файла справочника</summary><ParsingProfileForm value={dictionaryParsing} onChange={setDictionaryParsing} prefix="directory"/></details><button disabled={disabled || !file} onClick={() => void importDirectory()}>{uploading ? 'Загружаем…' : 'Прочитать столбцы справочника'}</button>
      {!!w.dictionary.columns.length && <form onSubmit={event => { event.preventDefault(); const missing = dictionaryFields.filter(([key, , optional]) => !optional && !dictionary[key]); if (missing.length) { setLocalError('Сопоставьте обязательные столбцы справочника: ' + missing.map(([, label]) => label).join(', ')); return; } void execute('source.browser.directory.apply', { ...revision, mapping: Object.fromEntries(dictionaryFields.map(([key, , optional]) => [key, dictionary[key] || (optional ? null : '')])) }); }}><div className="oko-form-grid">{dictionaryFields.map(([key, label, optional]) => <ColumnSelect key={key} label={label + (optional ? ' · необязательно' : '')} required={!optional} value={dictionary[key] ?? ''} columns={w.dictionary.columns} onChange={value => setDictionary(previous => ({ ...previous, [key]: value || null }))}/>)}</div><button disabled={disabled} type="submit">Применить справочник к предпросмотру</button></form>}
      {!!w.dictionary.sampleRows.length && <details><summary>Строки справочника</summary><PreviewTable rows={w.dictionary.sampleRows} columns={w.dictionary.columns} label="Справочник"/></details>}
      <p className="oko-muted">{w.dictionary.origin === 'none' ? 'Справочник пока не применён. Несопоставленные продукты будут показаны явно.' : w.dictionary.origin === 'published' ? 'Используется опубликованный справочник.' : 'Используется личный справочник для предпросмотра.'}</p>
      {!!w.dictionary.issues.length && <ul className="oko-warning">{w.dictionary.issues.map((issue, index) => <li key={index}>{issue.message} <small>{issue.code}</small></li>)}</ul>}
    </section>
    <section className="oko-card" aria-labelledby="oko-test-title"><div className="oko-section-title"><span>5</span><h2 id="oko-test-title">Повторить и получить результат</h2></div><p>Повторяем сохранённые действия, скачиваем новый файл и применяем сопоставление со справочником. Предыдущий успешный результат сохраняется при ошибке.</p><button className="oko-primary" disabled={disabled || !w.mapping || !w.recording.steps.length} onClick={() => void execute('source.browser.record.test', revision)}>Проверить сценарий и получить данные</button>
      {!setupOnly && job && <PersonalOperationStatus job={job} busy={disabled} hasResult={!!w.result} execute={(name, payload) => { void execute(name, payload); }} />}
    </section></>}
    {!setupOnly && <section className="oko-card oko-result" aria-labelledby="oko-result-title"><div className="oko-section-title"><span>✓</span><h2 id="oko-result-title">Последний результат</h2></div>{w.result ? <><div className="oko-result-stats"><div><strong>{w.result.rowCount.toLocaleString('ru-RU')}</strong><span>строк в файле</span></div><div><strong>{w.result.unresolvedRows.toLocaleString('ru-RU')}</strong><span>требуют сопоставления</span></div><div><strong>{w.result.sourceDate ?? 'Не указана'}</strong><span>дата источника</span></div></div><p className="oko-muted">Получено {new Date(w.result.capturedAt).toLocaleString('ru-RU')}. Наличие файла само по себе не подтверждает полноту охвата.</p><div className="oko-actions"><a className="oko-button" href={`/api/v1/browser/results/${encodeURIComponent(w.result.resultId)}/original`} download>Скачать исходный файл</a><a className="oko-button oko-primary" href={`/api/v1/browser/results/${encodeURIComponent(w.result.resultId)}/enriched`} download>Скачать обогащённый CSV</a></div>{!!w.result.issues.length && <details open><summary>Замечания к данным ({w.result.issues.length})</summary><ul className="oko-warning">{w.result.issues.map((issue, index) => <li key={index}>{issue.message} <small>{issue.code} {issue.path}</small></li>)}</ul></details>}<PreviewTable rows={w.result.previewRows} label="Результат обогащения"/></> : <p className="oko-muted">После проверки здесь появятся строки, замечания и ссылки на исходный и обогащённый файлы.</p>}</section>}
  </div>;
}

export function WorkbenchBrowserScenarioWizard(props: SharedBrowserScenarioProps | Record<string, never>) { return 'sourceRef' in props ? <SharedBrowserScenarioWizard {...props as SharedBrowserScenarioProps} /> : <PersonalBrowserScenarioWizard />; }

/** Reuses the workflow controller and forms; stays mounted while its parent hides settings. */
export function PersonalBrowserSetup({ onDirtyChange }: { onDirtyChange?(dirty: boolean): void } = {}) { return <PersonalBrowserScenarioWizard setupOnly onDirtyChange={onDirtyChange} />; }
