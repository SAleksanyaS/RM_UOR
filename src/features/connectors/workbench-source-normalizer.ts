import type { CanonicalSourceRow, RawSourceRow, SourceFieldMapping } from '../../domain/workbench/entities/sources';
import { businessTimeSchema } from '../../domain/workbench/primitives';
import { sourceFieldMappingSchema } from '../../domain/workbench/schemas/sources';
import { WorkbenchHttpError } from '../../server/workbench/protocol';
import { parseWorkbenchDate, parseWorkbenchNumber, parseXlsxNumber, type ParsedSourceTable } from '../tabular-import/workbench-parser';
import type { SourceIssue } from './workbench-source-contracts';

const invalidMapping = () => new WorkbenchHttpError(422, 'SOURCE_INVALID_CONFIGURATION', 'The saved source mapping is invalid or ambiguous');

/** Pure mapping of an inert parsed table. No row identity, business date or population is inferred. */
export function normalizeParsedWorkbenchTable({ table, mapping: unparsedMapping }: { table: ParsedSourceTable; mapping: SourceFieldMapping }): { rawRows: RawSourceRow[]; canonicalRows: CanonicalSourceRow[]; issues: SourceIssue[] } {
  const parsed = sourceFieldMappingSchema.safeParse(unparsedMapping); if (!parsed.success) throw invalidMapping();
  const mapping = parsed.data, profile = mapping.parsingProfile;
  if (mapping.dateField !== null && (mapping.periodStartField !== null || mapping.periodEndField !== null) || (mapping.periodStartField === null) !== (mapping.periodEndField === null)) throw invalidMapping();
  const numericColumns = new Map<string, string>();
  for (const metric of mapping.metricFields) for (const [field, column] of Object.entries(metric.fields)) {
    if (numericColumns.has(field) && numericColumns.get(field) !== column) throw invalidMapping(); numericColumns.set(field, column);
  }
  const required = new Set([...mapping.rowKeyFields, ...Object.values(mapping.dimensionFields), ...numericColumns.values(),
    ...[mapping.productKeyField, mapping.dateField, mapping.periodStartField, mapping.periodEndField, mapping.unitField].filter((column): column is string => column !== null)]);
  if ([...required].some(column => !table.columns.includes(column) || table.rows.some(row => !Object.hasOwn(row.cells, column)))) throw new WorkbenchHttpError(422, 'SOURCE_SCHEMA_CHANGED', 'A saved mapped column is absent from the source table');
  const read = (cells: RawSourceRow['cells'], column: string | null): string | null => {
    if (column === null) return null; const cell = cells[column];
    return !cell || cell.kind === 'blank' || cell.original === '' ? null : cell.original;
  };
  const issues: SourceIssue[] = [], rawRows: RawSourceRow[] = [], canonicalRows: CanonicalSourceRow[] = [], keys = new Set<string>();
  const issue = (code: string, rowKey: string, message: string) => issues.push({ code, stage: 'normalize', retryable: false, message, rowKeys: [rowKey], refs: [{ entityType: 'source_field_mapping', id: mapping.id }] });
  for (const sourceRow of table.rows) {
    const parts = mapping.rowKeyFields.map(column => read(sourceRow.cells, column));
    if (parts.some(value => value === null || !value.trim())) throw new WorkbenchHttpError(422, 'SOURCE_ROW_KEY_MISSING', 'Every saved row-key field must contain a source value');
    const rowKey = JSON.stringify(parts);
    if (keys.has(rowKey)) throw new WorkbenchHttpError(422, 'SOURCE_DUPLICATE_ROW_KEY', 'The saved row-key fields do not uniquely identify source rows'); keys.add(rowKey);
    const cells = structuredClone(sourceRow.cells); rawRows.push({ rowKey, cells });
    const numbers = Object.fromEntries([...numericColumns].map(([field, column]) => {
      const value = read(cells, column); if (value === null) return [field, null];
      try {
        if (cells[column].kind === 'boolean') throw Error('Boolean is not a declared decimal');
        return [field, table.format === 'xlsx' && cells[column].kind === 'number' ? parseXlsxNumber(value) : parseWorkbenchNumber(value, profile)];
      } catch { issue('INVALID_NUMBER', rowKey, `The mapped numeric field ${field} is invalid`); return [field, null]; }
    }));
    let businessTime: CanonicalSourceRow['businessTime'] = { kind: 'unknown' };
    const date = read(cells, mapping.dateField), start = read(cells, mapping.periodStartField), end = read(cells, mapping.periodEndField);
    try {
      if (date !== null) businessTime = { kind: 'as_of', date: parseWorkbenchDate(date, profile.dateFormat, table.dateSystem) };
      else if (start !== null || end !== null) {
        if (start === null || end === null) throw Error('A period requires both source bounds');
        businessTime = businessTimeSchema.parse({ kind: 'period', startInclusive: parseWorkbenchDate(start, profile.dateFormat, table.dateSystem), endExclusive: parseWorkbenchDate(end, profile.dateFormat, table.dateSystem) });
      }
    } catch { businessTime = { kind: 'unknown' }; issue('INVALID_BUSINESS_DATE', rowKey, 'The mapped business date or period is invalid'); }
    const unit = mapping.fixedUnitCode ?? read(cells, mapping.unitField);
    canonicalRows.push({ rowKey, dimensions: Object.fromEntries(Object.entries(mapping.dimensionFields).map(([field, column]) => [field, read(cells, column)])), numbers, businessTime, unitCode: unit?.trim() ? unit : null });
  }
  return { rawRows, canonicalRows, issues };
}
