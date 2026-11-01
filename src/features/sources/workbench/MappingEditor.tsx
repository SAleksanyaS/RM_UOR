import type { SourceFieldMapping, SourceParsingProfile } from '../../../domain/workbench/entities';
import type { Header } from '../../../domain/workbench/primitives';
import { defaultParsingProfile } from '../../connectors/workbench/ParsingProfileForm';

type FullMapping = Omit<SourceFieldMapping, keyof Header>;
export type MappingDefinition = Omit<Partial<FullMapping>, 'metricFields' | 'parsingProfile'> & {
  metricFields?: Array<{ metricId?: string; fields?: Record<string, string> }>;
  parsingProfile?: Partial<SourceParsingProfile>;
};
export type MappingMetricHint = { metricId: string; fields: string[] };
export function MappingEditor({ value, onChange, disabled = false, metricHints = [] }: { value: MappingDefinition; onChange(value: MappingDefinition): void; disabled?: boolean; metricHints?: MappingMetricHint[] }) {
  const field = <K extends keyof MappingDefinition>(key: K, next: MappingDefinition[K]) => onChange({ ...value, [key]: next });
  const profile = value.parsingProfile ?? {};
  const parsing = <K extends keyof SourceParsingProfile>(key: K, next: SourceParsingProfile[K]) => field('parsingProfile', { ...profile, [key]: next });
  const selects: Array<{ key: Exclude<keyof SourceParsingProfile, 'sheetName'>; label: string; options: Array<[string, string]> }> = [
    { key: 'csvDelimiter', label: 'Разделитель CSV', options: [[';', 'Точка с запятой'], [',', 'Запятая'], ['\t', 'Табуляция']] },
    { key: 'csvEncoding', label: 'Кодировка CSV', options: [['utf8', 'UTF-8'], ['windows1251', 'Windows-1251']] },
    { key: 'dateFormat', label: 'Формат даты', options: [['iso', 'ГГГГ-ММ-ДД (ISO)'], ['dd.mm.yyyy', 'ДД.ММ.ГГГГ'], ['excel-serial', 'Число Excel']] },
    { key: 'decimalSeparator', label: 'Десятичный знак', options: [['.', 'Точка'], [',', 'Запятая']] },
    { key: 'groupSeparator', label: 'Разделитель тысяч', options: [['none', 'Отсутствует'], ['space', 'Пробел'], ['nbsp', 'Неразрывный пробел'], ['comma', 'Запятая'], ['dot', 'Точка']] },
  ];
  const textFields: Array<[keyof Pick<FullMapping, 'productKeyField' | 'dateField' | 'periodStartField' | 'periodEndField' | 'unitField' | 'fixedUnitCode'>, string]> = [['productKeyField', 'Столбец ключа продукта'], ['dateField', 'Столбец даты наблюдения'], ['periodStartField', 'Столбец начала периода'], ['periodEndField', 'Столбец конца периода (не включая)'], ['unitField', 'Столбец единицы'], ['fixedUnitCode', 'Фиксированная единица']];
  const metricIds = [...new Set([...metricHints.map(h => h.metricId), ...(value.metricFields ?? []).flatMap(m => m.metricId ? [m.metricId] : [])])];
  return <fieldset className="wb-form-section" disabled={disabled}><legend>Лист и соответствие столбцов</legend><p className="wb-status-note">Укажите названия столбцов исходного файла. Настройка действует для будущего получения; сохранённые факты останутся в своих редакциях.</p><div className="wb-form-grid">
    <label>Лист XLSX<input value={profile.sheetName ?? ''} placeholder={profile.sheetName === undefined ? 'Не задан' : 'Первый лист'} onChange={e => parsing('sheetName', e.target.value || null)} /></label>
    {selects.map(({ key, label, options }) => <label key={key}>{label}<select value={profile[key] ?? ''} onChange={e => parsing(key, e.target.value as SourceParsingProfile[typeof key])}><option value="" disabled>Не задан</option>{options.map(([code, text]) => <option key={code} value={code}>{text}</option>)}</select></label>)}
    </div><div className="wb-form-actions"><button type="button" onClick={() => field('parsingProfile', { ...defaultParsingProfile })}>Задать профиль ISO / UTF-8</button></div>
    <label>Столбцы ключа строки (через запятую)<input value={(value.rowKeyFields ?? []).join(', ')} onChange={e => field('rowKeyFields', e.target.value.split(',').map(v => v.trim()).filter(Boolean))} /></label>
    <div className="wb-form-grid">{textFields.map(([key, label]) => <label key={key}>{label}<input value={value[key] ?? ''} placeholder={value[key] === undefined ? 'Не задан' : ''} onChange={e => field(key, e.target.value || null)} /></label>)}
    </div><div className="wb-form-actions"><button type="button" onClick={() => onChange({ ...value, dimensionFields: value.dimensionFields ?? {}, fixedScope: value.fixedScope ?? null, ...Object.fromEntries(textFields.filter(([key]) => value[key] === undefined).map(([key]) => [key, null])) })}>Оставить необязательные соответствия пустыми</button></div>
    {value.fixedScope && <p>Фиксированная область: {value.fixedScope.kind} / {value.fixedScope.id}</p>}
    {Object.entries(value.dimensionFields ?? {}).map(([name, column]) => <label key={name}>Столбец измерения {name}<input value={column} onChange={e => field('dimensionFields', { ...value.dimensionFields, [name]: e.target.value })} /></label>)}
    {metricIds.map((metricId, index) => {
      const metric = value.metricFields?.find(m => m.metricId === metricId);
      const fields = [...new Set([...(metricHints.find(h => h.metricId === metricId)?.fields ?? []), ...Object.keys(metric?.fields ?? {})])];
      return <fieldset key={metricId}><legend>Показатель {index + 1}</legend><details className="wb-technical-details"><summary>Ссылка на показатель</summary><code>{metricId}</code></details><div className="wb-form-grid">{fields.map(name => <label key={name}>Столбец значения {name}<input value={metric?.fields?.[name] ?? ''} onChange={e => {
        const metrics = (value.metricFields ?? []).filter(m => m.metricId !== metricId && m.metricId !== undefined);
        field('metricFields', [...metrics, { ...metric, metricId, fields: { ...metric?.fields, [name]: e.target.value } }]);
      }} /></label>)}</div></fieldset>;
    })}
    <p className="wb-status-note">Незаполненные поля остаются отсутствующими в черновике до явного ввода. Укажите формат даты явно.</p>
  </fieldset>;
}
