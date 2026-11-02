import { z } from 'zod';
import { createHash } from 'node:crypto';
import { stableJson } from '../../server/workbench/command-store';
import { uuidSchema, type VersionRef } from '../../domain/workbench/primitives';
import type { SourceDefinition } from '../../domain/workbench/entities';
import type { QueryContext } from '../../server/workbench/query-registry';
import { revisionTokenSchema, WorkbenchHttpError } from '../../server/workbench/protocol';
import type { DraftService } from '../catalog/workbench-drafts';
import { canUseCapability } from '../identity/workbench-access-policy';

/** Exact private source form, never an arbitrary package inventory or reader fallback. */
export const browserOwnDraftSchema = z.strictObject({ packageId: uuidSchema, sourceDraftId: uuidSchema, editToken: revisionTokenSchema });
export type BrowserOwnDraft = z.infer<typeof browserOwnDraftSchema>;
export type BrowserSourceBinding = { sourceRef: VersionRef; ownDraft?: BrowserOwnDraft };
/** Exact non-secret source/private-profile revision attached to an in-memory login. */
export function browserPreparationRevision(input: BrowserSourceBinding, profileRevision: string | null): string {
  return createHash('sha256').update(stableJson({ sourceRef: input.sourceRef, ownDraft: input.ownDraft ?? null, profileRevision })).digest('hex');
}
export function resolveBrowserSource(context: QueryContext, input: BrowserSourceBinding, drafts?: DraftService): Pick<SourceDefinition, 'id' | 'revision' | 'kind'> {
  if (input.sourceRef.entityType !== 'source_definition') throw new WorkbenchHttpError(404, 'SOURCE_NOT_FOUND', 'Source not found');
  if (input.ownDraft) {
    if (!canUseCapability(context.ownAccess, 'uor.prepare')) throw new WorkbenchHttpError(403, 'ACCESS_DENIED', 'Own source preparation requires curator access');
    if (!drafts) throw new WorkbenchHttpError(404, 'SOURCE_NOT_FOUND', 'Own source preparation is unavailable');
    const pkg = drafts.readOwnPackage(context, input.ownDraft.packageId);
    if (`draft:${pkg.packageId}:${pkg.revision}` !== input.ownDraft.editToken) throw new WorkbenchHttpError(409, 'REVISION_CONFLICT', 'The source package changed');
    const entry = pkg.entries.find(value => value.draftId === input.ownDraft!.sourceDraftId && value.entityRef.entityType === 'source_definition' && value.entityRef.id === input.sourceRef.id && value.versionRef.revision === input.sourceRef.revision);
    if (!entry || entry.definition.kind !== 'qlik') throw new WorkbenchHttpError(409, 'SOURCE_CHANGED', 'Choose the exact current own OKO source');
    return { id: entry.entityRef.id, revision: entry.versionRef.revision, kind: 'qlik' };
  }
  const source = context.repository.readPublishedHead<SourceDefinition>({ entityType: 'source_definition', id: input.sourceRef.id });
  if (!source || source.revision !== input.sourceRef.revision || source.kind !== 'qlik') throw new WorkbenchHttpError(409, 'SOURCE_CHANGED', 'Choose the current published OKO source');
  return source;
}
