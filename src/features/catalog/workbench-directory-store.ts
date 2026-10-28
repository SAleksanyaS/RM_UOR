import { createHash } from 'node:crypto';
import type { DirectoryEntity, DirectoryLink } from '../../domain/workbench/entities';
import type { Header, UtcInstant, VersionRef } from '../../domain/workbench/primitives';
import { utcInstantSchema, versionRefSchema } from '../../domain/workbench/primitives';
import { WorkbenchError } from '../../domain/workbench/errors';
import type { WorkbenchRepository } from '../../server/storage/workbench-repository';
import { stableJson } from '../../server/workbench/command-store';

export type DirectorySnapshotRefs = { entityRefs: VersionRef[]; linkRefs: VersionRef[] };
export type DirectoryReadMode = { kind: 'current' } | { kind: 'snapshot' } | { kind: 'at'; effectiveAt: UtcInstant };
export type DirectorySnapshot = { directoryEntities: DirectoryEntity[]; directoryLinks: DirectoryLink[]; refs: DirectorySnapshotRefs; revision: string };
export interface DirectoryStore { read(input: { refs: DirectorySnapshotRefs; mode: DirectoryReadMode }): DirectorySnapshot }

/** Explicit inventory reads use the repository's indexed entity/version keys, never core-table SQL or
 * broad enumeration. The trusted apply caller supplies inventory IDs; no unpublished ID becomes active.
 * Current main tolerates unknown publication time. Exact saved basis reads keep their original refs.
 * Only wall-clock mode delegates to readPublishedAt's EFFECTIVE_TIME_UNVERIFIED guard. */
export function createDirectoryStore({ repository }: { repository: WorkbenchRepository }): DirectoryStore {
  return {
    read({ refs, mode }) {
      if (mode.kind === 'at') utcInstantSchema.parse(mode.effectiveAt);
      const anchors = new Map<string, unknown>();
      const load = <T extends Header>(values: VersionRef[], type: string): T[] => {
        const seen = new Set<string>();
        return values.map(ref => {
          versionRefSchema.parse(ref);
          if (ref.entityType !== type || seen.has(ref.id)) throw new WorkbenchError('DIRECTORY_REFERENCE_INVALID', { ref }); seen.add(ref.id);
          const entityRef = { entityType: type, id: ref.id };
          const value = mode.kind === 'snapshot' ? repository.readVersion<T>(ref) : mode.kind === 'current' ? repository.readPublishedHead<T>(entityRef) : repository.readPublishedAt<T>(entityRef, mode.effectiveAt);
          if (!value) throw new WorkbenchError('DIRECTORY_REFERENCE_MISSING', { ref });
          const anchor = value.publicationAnchorId ? repository.readPublicationAnchor({ entityType: 'publication_anchor', id: value.publicationAnchorId }) : null;
          if (!anchor || anchor.publicationState !== 'confirmed') throw new WorkbenchError('DIRECTORY_REFERENCE_UNPUBLISHED', { ref });
          anchors.set(anchor.id, anchor); return value;
        });
      };
      const directoryEntities = load<DirectoryEntity>(refs.entityRefs, 'directory_entity'), directoryLinks = load<DirectoryLink>(refs.linkRefs, 'directory_link');
      const selected = { entityRefs: directoryEntities.map(e => ({ entityType: 'directory_entity', id: e.id, revision: e.revision })), linkRefs: directoryLinks.map(l => ({ entityType: 'directory_link', id: l.id, revision: l.revision })) };
      const ordered = { entityRefs: [...selected.entityRefs].sort((a, b) => a.id.localeCompare(b.id)), linkRefs: [...selected.linkRefs].sort((a, b) => a.id.localeCompare(b.id)) };
      return { directoryEntities, directoryLinks, refs: selected, revision: createHash('sha256').update(stableJson({ refs: ordered, anchors: [...anchors].sort(([a], [b]) => a.localeCompare(b)) })).digest('hex') };
    },
  };
}
