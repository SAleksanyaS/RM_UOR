import { useWorkbenchQuery } from '../../../app/workbench/context';
import type { z } from 'zod';
import type { rawDetailSchema, rawRowsSchema } from '../../connectors/workbench-raw-contracts';
import { DataTable, QueryState } from '../../../app/workbench/ui';
import { workbenchErrorMessage } from '../../../app/workbench/WorkbenchShell';
const request = (filter: Record<string, unknown>) => ({ context: null, filter, sort: [], page: { limit: 50, cursor: null } });
export function RawProcessingSource({ id }: {
    id: string;
}) { const detail = useWorkbenchQuery<z.infer<typeof rawDetailSchema>>('raw.files.detail', request({ id })); const rows = useWorkbenchQuery<z.infer<typeof rawRowsSchema>>('raw.files.rows', detail.data?.parseState === 'parsed' ? request({ id, limit: 20 }) : null); return <section className="wb-surface wb-object-content" aria-label="Исходные столбцы обработки"><h2>{detail.data?.filename ?? 'Выбранный исходник'}</h2><QueryState loading={detail.loading} error={detail.error ? workbenchErrorMessage(detail.error, 'read') : null}/><p>Исходные значения сохранены без изменений. Ниже проверяются производные значения, единицы, даты и версия сопоставления.</p>{rows.data && <details open><summary>Исходные строки · первые {rows.data.rows.length} из {rows.data.page.total}</summary><DataTable label="Исходные столбцы обработки"><thead><tr><th>Строка</th>{rows.data.columns.map(c => <th key={c.key}>{c.label}</th>)}</tr></thead><tbody>{rows.data.rows.map(r => <tr key={r.rowNumber}><td>{r.rowNumber}</td>{rows.data!.columns.map(c => <td key={c.key}>{r.values[c.key] ?? 'Пусто'}</td>)}</tr>)}</tbody></DataTable></details>}{rows.error !== null && <p role="alert">{workbenchErrorMessage(rows.error, 'read')}</p>}</section>; }
