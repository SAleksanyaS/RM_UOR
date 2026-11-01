import { createHash } from 'node:crypto';
import type { QueryContext } from '../../server/workbench/query-registry';
import type { BrowserResultArtifact } from '../../server/workbench/routes';
import { WorkbenchHttpError } from '../../server/workbench/protocol';
import { canUseCapability } from '../identity/workbench-access-policy';
import type { SourceStore } from './workbench-source-store';
import { serializeOkoEnrichedCsv, type OkoPreviewRow } from './workbench-workflow-enrichment';

/** Read immutable accepted capture bytes/rows only; no replay, current directory or recalculation. */
export function createSharedBrowserResultReader({ sources }: { sources: Pick<SourceStore, 'readOwnCaptureArtifact'> }) {
  return { async read(context: QueryContext, captureId: string, kind: 'original' | 'enriched'): Promise<BrowserResultArtifact> {
    if (!canUseCapability(context.ownAccess, 'business.read')) throw new WorkbenchHttpError(403, 'ACCESS_DENIED', 'Own result access is unavailable');
    const result = sources.readOwnCaptureArtifact({ installationId: context.installationId, profilePersonId: context.ownAccess.personId }, captureId);
    if (!result) throw new WorkbenchHttpError(404, 'RESULT_NOT_FOUND', 'Own completed capture result not found');
    const { view } = result;
    let bytes: Uint8Array = Buffer.from(result.bytes), mimeType = view.artifact!.mimeType;
    let name = `source-${captureId}.${mimeType === 'text/csv' ? 'csv' : 'xlsx'}`;
    if (kind === 'enriched') {
      const factsByRow = new Map<string, typeof view.facts>();
      for (const fact of view.facts) for (const key of fact.lineage.sourceRowKeys) { const facts = factsByRow.get(key) ?? []; facts.push(fact); factsByRow.set(key, facts); }
      const rows: OkoPreviewRow[] = view.capture.canonicalRows.map(row => {
        const facts = factsByRow.get(row.rowKey) ?? [];
        return { rowKey: row.rowKey, ...Object.fromEntries(Object.entries(row.dimensions).map(([key, value]) => ['dimension:' + key, value])), ...Object.fromEntries(Object.entries(row.numbers).map(([key, value]) => ['number:' + key, value])), businessTime: JSON.stringify(row.businessTime), unitCode: row.unitCode, scopes: [...new Set(facts.map(fact => fact.scope.kind + ':' + fact.scope.id))].join(';'), factIds: facts.map(fact => fact.id).join(';') };
      });
      bytes = serializeOkoEnrichedCsv(rows, [...new Set(rows.flatMap(row => Object.keys(row)))]);
      mimeType = 'text/csv; charset=utf-8'; name = `enriched-${captureId}.csv`;
    }
    return { bytes, name, mimeType, sha256: createHash('sha256').update(bytes).digest('hex') };
  } };
}
