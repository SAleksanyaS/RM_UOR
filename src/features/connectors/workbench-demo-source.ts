import { canonicalDecimal } from '../../domain/workbench/exact-number';
import { businessTimeSchema } from '../../domain/workbench/primitives';
import type { Clock } from '../../domain/workbench/primitives';
import type { CanonicalSourceRow } from '../../domain/workbench/entities';
import { sourcePayloadHash, type SourceAdapter, type NormalizerPort, type SourceIssue } from './workbench-source-contracts';

/** Explicitly synthetic, opt-in adapter. Never installed as a production fallback. */
export function createSyntheticDemoSource({ clock }: { clock: Clock }): SourceAdapter {
  return {
    async check() { return { status: 'ready', issues: [] }; },
    async collect(request, signal) {
      signal.throwIfAborted();
      const rawRows = ['a', 'b'].map((suffix, i) => ({ rowKey: 'demo-' + suffix, cells: { demo_row_key: { kind: 'text' as const, original: 'demo-' + suffix }, demo_scope_id: { kind: 'text' as const, original: i ? 'demo-product-b' : 'demo-product-a' }, demo_value: { kind: 'number' as const, original: '92.00' }, demo_date: { kind: 'text' as const, original: '2026-10-27' } } }));
      return { operationId: request.operationId, sourceRef: request.sourceRef, mappingRef: request.mappingRef, capturedAt: clock.now(), sourceUpdatedAt: '2026-10-27T09:00:00Z', rawRows, artifact: null, payloadHash: sourcePayloadHash(rawRows), coverage: { complete: true, expectedRows: 2, receivedRows: 2, evidence: ['synthetic-demo:complete-two-product-inventory'] }, issues: [] };
    },
  };
}
/** Deterministic ISO/dot-decimal synthetic fixture; T15 supplies general published-profile parsing. */
export const syntheticDemoNormalizer: NormalizerPort = {
  normalize({ raw, mapping }) {
    const issues: SourceIssue[] = [];
    const profile = mapping.parsingProfile;
    if (profile && (profile.dateFormat !== 'iso' || profile.decimalSeparator !== '.' || profile.groupSeparator !== 'none')) throw Error('Synthetic normalizer only supports ISO/dot-decimal fixtures');
    const rows: CanonicalSourceRow[] = raw.rawRows.map(row => {
      const read = (key: string | null) => key === null ? null : row.cells[key]?.original ?? null;
      const numbers: CanonicalSourceRow['numbers'] = {};
      for (const entry of mapping.metricFields) for (const [field, column] of Object.entries(entry.fields)) {
        const value = read(column);
        try { numbers[field] = value === null ? null : canonicalDecimal(value); }
        catch { numbers[field] = null; issues.push({ code: 'INVALID_DECIMAL', stage: 'normalize', retryable: false, message: 'Synthetic field is not an exact decimal', rowKeys: [row.rowKey], refs: [] }); }
      }
      let businessTime: CanonicalSourceRow['businessTime'] = { kind: 'unknown' };
      const date = read(mapping.dateField), start = read(mapping.periodStartField), end = read(mapping.periodEndField);
      const candidate = date !== null ? { kind: 'as_of', date } : start !== null && end !== null ? { kind: 'period', startInclusive: start, endExclusive: end } : { kind: 'unknown' };
      const parsed = businessTimeSchema.safeParse(candidate); if (parsed.success) businessTime = parsed.data;
      else issues.push({ code: 'INVALID_BUSINESS_DATE', stage: 'normalize', retryable: false, message: 'Source date is invalid', rowKeys: [row.rowKey], refs: [] });
      return { rowKey: row.rowKey, numbers, dimensions: Object.fromEntries(Object.entries(mapping.dimensionFields).map(([field, column]) => [field, read(column)])), businessTime, unitCode: mapping.fixedUnitCode ?? read(mapping.unitField) };
    });
    return { rows, issues };
  },
};
