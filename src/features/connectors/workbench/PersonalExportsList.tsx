import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownToLine, CheckCircle2, CircleAlert, EyeOff, FileSpreadsheet, FolderOpen } from 'lucide-react';
import type { OkoExport } from '../workbench-workflow-contracts';
import { useWorkbench } from './WorkbenchProvider';

const saved = (at: string) => new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' }).format(new Date(at)) + ' МСК';
const size = (bytes: number) => bytes < 1024 ? `${bytes} Б` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(0)} КБ` : `${(bytes / 1024 / 1024).toFixed(1)} МБ`;

/** Raw saved report files. Nothing here depends on column mapping or the directory. */
export function PersonalExportsList() {
  const { session, client } = useWorkbench();
  return <OwnedExportsList key={(client.storageScope ?? '') + ':' + (session?.personId ?? 'unassigned')} />;
}
function OwnedExportsList() {
  const { exports, session, client, busy, run, refreshExports } = useWorkbench();
  const [error, setError] = useState('');
  const canHide = !!session?.personId && (session.allowedCommands.includes('source.browser.export.delete') ?? false);
  const items = exports?.items ?? [];
  // Confirm only a file saved in this tab session; a reload must not replay an old confirmation.
  const scope = `${client.storageScope ?? ''}:${session?.personId ?? 'unassigned'}`;
  const seenKey = 'uor.oko.exports.seen.v1:' + scope, seen = useRef<string | null>(null);
  if (seen.current === null) { try { seen.current = sessionStorage.getItem(seenKey) ?? ''; } catch { seen.current = ''; } }
  const latest = items[0];
  const [confirmation, setConfirmation] = useState<OkoExport | null>(null);
  useEffect(() => {
    if (!latest || latest.exportId === seen.current) return;
    seen.current = latest.exportId;
    try { sessionStorage.setItem(seenKey, latest.exportId); } catch { /* The list itself stays authoritative. */ }
    setConfirmation(latest);
  }, [latest, seenKey]);
  const total = useMemo(() => items.reduce((sum, item) => sum + item.bytes, 0), [items]);
  const hiddenCount = exports?.hiddenCount ?? 0;
  const hide = async (exportId: string) => {
    setError('');
    try { await run('source.browser.export.delete', { exportId }); await refreshExports(); }
    catch (failure) { setError((failure as Error).message); }
  };
  return <section className="wb-personal-exports" aria-labelledby="wb-personal-exports-heading">
    <header className="wb-section-header"><div><h2 id="wb-personal-exports-heading">Мои выгрузки</h2><p>Скачанные файлы отчётов лежат на этом компьютере, в общий каталог не попадают.</p></div><span className="wb-badge">{items.length ? `Файлов: ${items.length} · ${size(total)}` : 'Пока пусто'}</span></header>
    {confirmation && <div role="status" className="wb-export-confirmation"><CheckCircle2 size={18} aria-hidden="true" /><div><strong>Файл сохранён</strong><p>{confirmation.fileName} · {size(confirmation.bytes)} · {saved(confirmation.capturedAt)}</p></div><a href={confirmation.downloadUrl} download={confirmation.fileName} className="wb-download-link"><ArrowDownToLine size={16} aria-hidden="true" />Скачать</a></div>}
    {error && <div role="alert" className="wb-inline-feedback"><CircleAlert size={18} aria-hidden="true" /><div><strong>Не удалось скрыть файл</strong><p>{error}</p></div></div>}
    {items.length === 0 ? <div className="wb-content-empty"><FolderOpen size={36} aria-hidden="true" /><h3>Здесь появятся ваши выгрузки</h3><p>Откройте вкладку «Сценарий», запишите путь к отчёту и скачайте файл — он сразу появится в этом списке.</p></div>
      : <div className="wb-table-scroll" role="region" aria-label="Мои выгрузки" tabIndex={0}><table className="wb-personal-table"><caption className="wb-visually-hidden">Сохранённые файлы выгрузок</caption><thead><tr><th scope="col">Файл</th><th scope="col">Отчёт</th><th scope="col">Сохранён</th><th scope="col">Размер</th><th scope="col">Строк</th><th scope="col"><span className="wb-visually-hidden">Действия</span></th></tr></thead><tbody>
        {items.map(item => <tr key={item.exportId}>
          <td><a href={item.downloadUrl} download={item.fileName} className="wb-download-link"><FileSpreadsheet size={16} aria-hidden="true" />{item.fileName}</a></td>
          <td>{item.title}</td>
          <td>{saved(item.capturedAt)}</td>
          <td>{size(item.bytes)}</td>
          <td>{item.rowCount === null ? <span className="wb-cell-empty">—</span> : item.rowCount.toLocaleString('ru-RU')}</td>
          <td>{canHide && <button type="button" className="wb-quiet-button" disabled={busy} onClick={() => void hide(item.exportId)}><EyeOff size={14} aria-hidden="true" />Скрыть</button>}</td>
        </tr>)}
      </tbody></table></div>}
    <p className="wb-result-footnote">{hiddenCount > 0 ? `Скрытых файлов: ${hiddenCount}. Файлы не удалены и остаются на компьютере.` : 'Кнопка «Скрыть» убирает файл из списка и сохраняет его байты на компьютере.'}</p>
  </section>;
}
