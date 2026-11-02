import { CommandRecoveryError } from '../../../app/workbench/command-recovery';
import type { z } from 'zod';
import { useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowRight, FileSpreadsheet, Upload, X } from 'lucide-react';
import { rawListSchema, rawRowsSchema, rawDetailSchema } from '../../connectors/workbench-raw-contracts';
import { defaultSourceParsingProfile } from '../../../domain/workbench/schemas/sources';
import type { SourceParsingProfile } from '../../../domain/workbench/entities/sources';
import { useUnsavedChanges } from '../../../app/workbench/use-unsaved-changes';
import { useGlobalContext, useWorkbench, useWorkbenchQuery } from '../../../app/workbench/context';
import { workbenchErrorMessage } from '../../../app/workbench/WorkbenchShell';
import { DataTable, EmptyState, QueryState, StatusBadge } from '../../../app/workbench/ui';
import type { CommandRequest, CommandResult, CommandReconciliation } from '../../../server/workbench/protocol';
import { WorkbenchApiError } from '../../../app/workbench/api-client';
import { RawProcessAction } from './RawProcessAction';
import { RawTableArrangement } from './RawTableArrangement';

type Files = z.infer<typeof rawListSchema>;
type Rows = z.infer<typeof rawRowsSchema>;
type Detail = z.infer<typeof rawDetailSchema>;
const request = (filter: Record<string, unknown>) => ({ context: null, filter, sort: [], page: { limit: 50, cursor: null } });
const states: Record<string, string> = { raw: 'Исходник сохранён', parsed: 'Готов к просмотру', failed: 'Ошибка обработки', unsupported: 'Просмотр недоступен', quarantined: 'На проверке' };
const sourceKinds: Record<Detail['sourceKind'], string> = { oko: 'ОКО', confluence: 'Confluence', local_file: 'Файл с компьютера', manual: 'Ручной ввод' };
const size = (value: number) => value < 1024 ? `${value} Б` : value < 1048576 ? `${(value / 1024).toFixed(1)} КБ` : `${(value / 1048576).toFixed(1)} МБ`;
const date = (value: string) => new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Moscow' }).format(new Date(value));

export function RawFilesPage() {
  const { client, session } = useWorkbench(), { navigate } = useGlobalContext();
  const [search, setSearch] = useState(''), [sort, setSort] = useState('captured_desc');
  const [cursor, setCursor] = useState<string | null>(null), [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState<string | null>(() => new URLSearchParams(window.location.search).get('file'));
  const [upload, setUpload] = useState(false), [manual, setManual] = useState(false);
  const [busy, setBusy] = useState(false), [failure, setFailure] = useState<unknown>(null);
  const [title, setTitle] = useState(''), [manualText, setManualText] = useState('');
  const [sourceKind, setSourceKind] = useState<'local_file' | 'confluence'>('local_file');
  const [recovery, setRecovery] = useState<CommandReconciliation['status'] | 'unknown' | null>(null);
  useUnsavedChanges(!!recovery || manual && (!!title || !!manualText));
  const pending = useRef<CommandRequest | null>(null), mounted = useRef(true), inFlight = useRef(false);
  const lifetime = useRef(0);
  const owner = useRef({ client, person: session?.personId });
  owner.current = { client, person: session?.personId };
  useEffect(() => {
    mounted.current = true; lifetime.current++; inFlight.current = false; setBusy(false); pending.current = null; setRecovery(null); setFailure(null);
    return () => { mounted.current = false; };
  }, [client, session?.personId]);
  const input = request({ search, sort, limit: 50, cursor });
  const query = useWorkbenchQuery<Files>('raw.files.list', session ? input : null, revision);
  const data = query.data;
  const urlSelection = new URLSearchParams(window.location.search).get('file');
  useEffect(() => { setSelected(urlSelection); }, [urlSelection]);

  const operate = async (action: (active: () => boolean) => Promise<void>) => {
    if (inFlight.current) return;
    const identity = owner.current, epoch = lifetime.current;
    const active = () => mounted.current && epoch === lifetime.current && owner.current.client === identity.client && owner.current.person === identity.person;
    inFlight.current = true; setBusy(true); setFailure(null);
    try { await action(active); }
    catch (error) { if (active()) setFailure(error); }
    finally { if (epoch === lifetime.current) inFlight.current = false; if (active()) setBusy(false); }
  };
  const readback = async (active: () => boolean) => {
    await client.query<Files>('raw.files.list', input);
    if (!active()) return false;
    setRevision(value => value + 1);
    return true;
  };
  const complete = () => {
    pending.current = null; setRecovery(null);
    setUpload(false); setManual(false); setTitle(''); setManualText('');
  };
  const send = async (command: CommandRequest, active: () => boolean) => {
    pending.current = command; setRecovery('unknown');
    let received = false;
    try {
      const result = await client.command<CommandResult>(command);
      if (!active()) return;
      received = true;
      if ('jobId' in result.data) { setRecovery('accepted'); throw new CommandRecoveryError('Операция принята. Проверьте сохранённое состояние.'); }
      setRecovery('completed');
      // Do not discard the receipt identity when this read fails.
      if (await readback(active)) complete();
    } catch (error) {
      if (active() && !received && error instanceof WorkbenchApiError && [403, 409, 422].includes(error.status)) {
        pending.current = null; setRecovery(null);
      }
      throw error;
    }
  };
  const execute = (name: string, payload: Record<string, unknown>) => operate(async active => {
    if (pending.current) throw new CommandRecoveryError('Сначала проверьте предыдущее сохранение файла. Новые изменения ещё не отправлены.');
    await send({ commandId: crypto.randomUUID(), name, baseRevision: null, payload }, active);
  });
  const recover = (retry = false) => operate(async active => {
    const command = pending.current;
    if (!command) return;
    if (retry) {
      if (recovery !== 'not_found') throw new CommandRecoveryError('Сначала проверьте состояние исходной команды.');
      await send(command, active);
      return;
    }
    const outcome = await client.reconcileCommand(command.commandId);
    if (!active()) return;
    if (outcome.data.name !== null && outcome.data.name !== command.name) throw new CommandRecoveryError('Ответ восстановления не соответствует команде.');
    setRecovery(outcome.data.status);
    switch (outcome.data.status) {
      case 'not_found':
        throw new CommandRecoveryError('Команда не найдена. Можно явно повторить исходное сохранение файла с тем же идентификатором.');
      case 'pending':
      case 'accepted':
        throw new CommandRecoveryError('Сохранение файла ещё выполняется. Повторите проверку состояния.');
      case 'completed':
        if (await readback(active)) complete();
        return;
      case 'interrupted':
        if (await readback(active)) {
          pending.current = null; setRecovery(null);
          throw new CommandRecoveryError('Сохранение файла прервано. Список исходников проверен; введённые данные сохранены в форме. Проверьте список и сохраните снова при необходимости.');
        }
    }
  });
  const importFile = (file: File) => operate(async active => {
    if (pending.current) throw new CommandRecoveryError('Сначала проверьте предыдущее сохранение файла.');
    const response = await client.upload(file, 'raw-file');
    if (active()) await send({ commandId: crypto.randomUUID(), name: 'raw.capture.import', baseRevision: null, payload: { fileHandle: response.data.fileHandle, sourceKind, title: file.name } }, active);
  });

  return <section aria-label="Библиотека исходных файлов">
    <div className="wb-data-journey" aria-label="Путь работы с данными"><span>1. Получите файл</span><span>2. Проверьте строки</span><span>3. Настройте обработку</span></div>
    <div className="wb-page-toolbar">
      <label className="wb-search-field"><span>Найти файл</span><input type="search" value={search} placeholder="Название или источник" onChange={event => { setSearch(event.target.value); setCursor(null); }} /></label>
      <label className="wb-field"><span>Порядок файлов</span>
        <select value={sort} onChange={event => { setSort(event.target.value); setCursor(null); }}>
          <option value="captured_desc">Сначала новые</option><option value="captured_asc">Сначала старые</option><option value="name_asc">По названию</option><option value="size_desc">По размеру</option>
        </select>
      </label>
      <div className="wb-toolbar-actions">
        {session?.allowedCommands.includes('raw.capture.import') && <button onClick={() => setUpload(!upload)}><Upload size={16} />Добавить файл</button>}
        {session?.allowedCommands.includes('raw.capture.manual') && <button onClick={() => setManual(!manual)}>Ввести таблицу</button>}
        <button className="wb-primary-button" onClick={() => navigate('/data#personal-oko')}>Получить файл<ArrowRight size={16} /></button>
      </div>
    </div>
    {upload && <section className="wb-surface wb-object-content">
      <h2>Добавить исходный файл</h2><p>Файл сохраняется отдельно от результатов обработки. Поддержка просмотра зависит от формата.</p>
      <label className="wb-field">Источник файла
        <select value={sourceKind} onChange={event => setSourceKind(event.target.value as typeof sourceKind)} disabled={busy || !!pending.current}>
          <option value="local_file">Файл с компьютера</option><option value="confluence">Файл экспорта Confluence</option>
        </select>
      </label>
      <label className="wb-field">Выберите файл<input type="file" disabled={busy || !!pending.current} onChange={event => { const file = event.target.files?.[0]; if (file) void importFile(file); }} /></label>
    </section>}
    {manual && <form className="wb-surface wb-object-content" onSubmit={event => {
      event.preventDefault();
      const lines = manualText.split(/\r?\n/).filter(Boolean).map(line => line.split('\t'));
      void execute('raw.capture.manual', { title, columns: lines[0] ?? [], rows: lines.slice(1) });
    }}>
      <h2>Новая таблица</h2>
      <label className="wb-field">Название<input required value={title} disabled={busy || !!pending.current} onChange={event => setTitle(event.target.value)} /></label>
      <label className="wb-field">Столбцы и строки<textarea required rows={7} value={manualText} disabled={busy || !!pending.current} onChange={event => setManualText(event.target.value)} placeholder="Вставьте ячейки из таблицы. Первая строка — названия столбцов." /></label>
      <p className="wb-muted">Столбцы разделяются табуляцией, строки — переносом. Сохранение не принимает данные в качестве фактов цели.</p>
      <button className="wb-primary-button" disabled={busy || !!pending.current}>Сохранить исходную таблицу</button>
    </form>}
    {failure !== null && <div className="wb-inline-feedback" role="alert">
      <p>{workbenchErrorMessage(failure)}</p>
      {pending.current && <><p>Идентификатор действия: <code>{pending.current.commandId}</code></p>
        <button disabled={busy} onClick={() => void recover(recovery === 'not_found')}>
          {recovery === 'not_found' ? 'Повторить исходное сохранение файла' : 'Проверить сохранение файла'}
        </button>
      </>}
    </div>}
    <QueryState loading={query.loading || busy} error={query.error ? workbenchErrorMessage(query.error, 'read') : null} onRetry={() => setRevision(value => value + 1)} />
    {data && <>
      <div className="wb-list-summary"><span>Файлов: {data.page.total}</span><span>Исходники сохраняются независимо от обработки</span></div>
      {!data.items.length ? <EmptyState title={search ? 'Файлы не найдены' : 'Ваш первый файл — начало работы'} action={<button className="wb-primary-button" onClick={() => navigate('/data#personal-oko')}>Настроить получение</button>}>
        {search ? 'Измените поиск или порядок просмотра.' : 'Получите отчёт из ОКО или Confluence либо добавьте файл с компьютера. Каталог, цель и сопоставление столбцов для этого не нужны.'}
      </EmptyState> : <div className="wb-surface wb-raw-file-list"><DataTable label="Исходные файлы">
        <thead><tr><th scope="col">Файл</th><th scope="col">Источник</th><th scope="col">Получен, МСК</th><th scope="col">Размер</th><th scope="col">Состояние</th><th scope="col">Действия</th></tr></thead>
        <tbody>{data.items.map(file => <tr key={file.id}>
          <td className="wb-file-name"><button className="wb-row-link" onClick={() => { setSelected(file.id); navigate('/data?file=' + encodeURIComponent(file.id)); }}><FileSpreadsheet size={16} /> {file.filename}</button><small className="wb-cell-note">{file.mimeType}</small></td>
          <td>{file.source}</td><td>{date(file.capturedAt)}</td><td>{size(file.size)}</td>
          <td><StatusBadge tone={file.parseState === 'failed' ? 'warning' : 'neutral'}>{states[file.parseState] ?? file.parseState}</StatusBadge></td>
          <td><a href={file.downloadUrl} download={file.filename}><ArrowDownToLine size={15} /> Скачать исходник</a></td>
        </tr>)}</tbody>
      </DataTable></div>}
      <div className="wb-pagination">{cursor && <button onClick={() => setCursor(null)}>К началу</button>}{data.page.nextCursor && <button onClick={() => setCursor(data.page.nextCursor)}>Следующие файлы</button>}</div>
    </>}
    {selected && <RawFileDetail key={selected} id={selected} onClose={() => { setSelected(null); navigate('/data'); }} />}
  </section>;
}

function RawFileProvenance({ file }: { file: Detail }) {
  const provenance = file.provenance, metadata = provenance.sourceMetadata;
  let pageUrl: string | null = null;
  if (metadata?.pageUrl) {
    try { const url = new URL(metadata.pageUrl); if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) pageUrl = url.href; } catch { /* Render untrusted malformed values as text. */ }
  }
  return <details className="wb-object-content wb-raw-provenance">
    <summary>Происхождение и проверка целостности</summary>
    <dl className="wb-definition-grid">
      <div><dt>Тип источника</dt><dd>{sourceKinds[file.sourceKind]}</dd></div>
      <div><dt>Наименование источника</dt><dd>{provenance.sourceName || 'Не указано'}</dd></div>
      <div><dt>Дата в источнике</dt><dd>{file.sourceDate ?? 'Не указана'}</dd></div>
      <div><dt>Получен на рабочее место</dt><dd>{date(file.capturedAt)} МСК</dd></div>
      <div><dt>Страница источника</dt><dd>{pageUrl ? <a href={pageUrl} target="_blank" rel="noopener noreferrer">{metadata!.pageUrl}</a> : metadata?.pageUrl ?? 'Не указана'}</dd></div>
      <div><dt>Идентификатор вложения</dt><dd>{metadata?.attachmentId ?? 'Не указан'}</dd></div>
      <div><dt>Версия вложения</dt><dd>{metadata?.version ?? 'Не указана'}</dd></div>
      <div><dt>Лист таблицы</dt><dd>{provenance.sheet ?? 'Не указан'}</dd></div>
      <div><dt>Операция получения</dt><dd><code>{provenance.operationId}</code></dd></div>
      <div><dt>Исходник</dt><dd>{provenance.immutable ? 'Неизменяемый' : 'Не подтверждено'}</dd></div>
      <div><dt>SHA-256</dt><dd><code>{file.sha256}</code></dd></div>
    </dl>
    {file.issue && <p className="wb-status-note">{file.issue.message} <code>{file.issue.code}</code></p>}
  </details>;
}

function RawFileDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const [profile, setProfile] = useState<SourceParsingProfile>({ ...defaultSourceParsingProfile });
  const [appliedProfile, setAppliedProfile] = useState<SourceParsingProfile | undefined>();
  const detail = useWorkbenchQuery<Detail>('raw.files.detail', request({ id, ...(appliedProfile ? { parsingProfile: appliedProfile } : {}) }));
  const [search, setSearch] = useState(''), [cursor, setCursor] = useState<string | null>(null);
  const [sortColumn, setSortColumn] = useState(''), [direction, setDirection] = useState<'asc' | 'desc'>('asc');
  const rows = useWorkbenchQuery<Rows>('raw.files.rows', detail.data?.parseState === 'parsed' ? request({ id, ...(appliedProfile ? { parsingProfile: appliedProfile } : {}), search, ...(sortColumn ? { sortColumn, direction } : {}), limit: 50, cursor }) : null);
  const file = detail.data;

  return <section className="wb-file-detail wb-surface" aria-label="Подробности исходного файла">
    <header className="wb-section-header">
      <div><span className="wb-eyebrow">Исходный файл</span><h2>{file?.filename ?? 'Открываем файл…'}</h2></div>
      <button className="wb-icon-button" aria-label="Закрыть подробности файла" onClick={onClose}><X size={18} /></button>
    </header>
    <QueryState loading={detail.loading} error={detail.error ? workbenchErrorMessage(detail.error, 'read') : null} />
    {file && <>
      <dl className="wb-definition-grid">
        <div><dt>Источник</dt><dd>{file.source}</dd></div><div><dt>Строк</dt><dd>{file.rowCount ?? 'Не определено'}</dd></div>
        <div><dt>Получен</dt><dd>{date(file.capturedAt)} МСК</dd></div>
        <div><dt>Исходные байты</dt><dd><a download={file.filename} href={file.downloadUrl}>Скачать · {size(file.size)}</a></dd></div>
      </dl>
      <div className="wb-object-content"><RawProcessAction id={file.id} /></div>
      <details className="wb-object-content">
        <summary>Настройки просмотра таблицы</summary>
        <form className="wb-page-toolbar" onSubmit={event => { event.preventDefault(); setAppliedProfile({ ...profile }); setCursor(null); }}>
          <label className="wb-field">Лист Excel<input value={profile.sheetName ?? ''} placeholder="Первый лист" onChange={event => setProfile(value => ({ ...value, sheetName: event.target.value || null }))} /></label>
          <label className="wb-field">Кодировка CSV<select value={profile.csvEncoding} onChange={event => setProfile(value => ({ ...value, csvEncoding: event.target.value as SourceParsingProfile['csvEncoding'] }))}><option value="utf8">UTF-8</option><option value="windows1251">Windows-1251</option></select></label>
          <label className="wb-field">Разделитель<select value={profile.csvDelimiter} onChange={event => setProfile(value => ({ ...value, csvDelimiter: event.target.value as SourceParsingProfile['csvDelimiter'] }))}><option value=",">Запятая</option><option value=";">Точка с запятой</option><option value={'\t'}>Табуляция</option></select></label>
          <button type="submit">Проверить просмотр</button>
        </form>
        <p className="wb-muted">Эти параметры меняют только просмотр. Исходные байты и принятые факты сохраняются.</p>
      </details>
      {file.parseState === 'parsed' ? <div className="wb-object-content">
        <label className="wb-field">Поиск по строкам<input type="search" value={search} onChange={event => { setSearch(event.target.value); setCursor(null); }} /></label>
        <QueryState loading={rows.loading} error={rows.error ? workbenchErrorMessage(rows.error, 'read') : null} />
        {rows.data && <>
          <p className="wb-list-summary">Показано {rows.data.rows.length} из {rows.data.page.total} строк</p>
          <RawTableArrangement sha256={file.sha256} columns={rows.data.columns} profile={appliedProfile}>{columns => <DataTable label="Строки исходного файла">
            <thead><tr><th scope="col">Строка</th>{columns.map(column => <th key={column.key} scope="col" aria-sort={sortColumn === column.key ? direction === 'asc' ? 'ascending' : 'descending' : 'none'}>
              <button onClick={() => { setSortColumn(column.key); setDirection(sortColumn === column.key && direction === 'asc' ? 'desc' : 'asc'); setCursor(null); }}>{column.label}</button>
            </th>)}</tr></thead>
            <tbody>{rows.data!.rows.map(row => <tr key={row.rowNumber}><td>{row.rowNumber}</td>{columns.map(column => <td key={column.key}>{row.values[column.key] ?? <span className="wb-muted">Нет значения</span>}</td>)}</tr>)}</tbody>
          </DataTable>}</RawTableArrangement>
          <div className="wb-pagination">{cursor && <button onClick={() => setCursor(null)}>Первые строки</button>}{rows.data.page.nextCursor && <button onClick={() => setCursor(rows.data!.page.nextCursor)}>Следующие строки</button>}</div>
        </>}
      </div> : <p className="wb-status-note">{states[file.parseState] ?? 'Обработка не выполнена'}. Исходник доступен для скачивания; отсутствие просмотра не изменяет его байты.</p>}
      <RawFileProvenance file={file} />
    </>}
  </section>;
}
