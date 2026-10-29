import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { Evidence, FileArtifactRef } from '../../domain/workbench/entities';
import { newUuid, uuidSchema, type Clock } from '../../domain/workbench/primitives';
import { evidenceSchema } from '../../domain/workbench/schemas';
import type { WorkbenchRepository } from '../../server/storage/workbench-repository';
import type { CommandContext } from '../../server/workbench/command-registry';
import type { QueryContext } from '../../server/workbench/query-registry';
import { assertFileName, assertPhysicalPath, defaultFileLimits, type FileStore } from '../../server/workbench/files';
import { WorkbenchHttpError } from '../../server/workbench/protocol';
import type { DraftStore } from '../catalog/workbench-draft-store';

export type ArtifactReadResult = { stream: Readable; name: string; mimeType: string; bytes: number; sha256: string };
type Artifact = { artifact_id: string; evidence_id: string; installation_id: string; owner_person_id: string; name: string; mime_type: string; bytes: number; sha256: string };
const missing = (): never => { throw new WorkbenchHttpError(404, 'ARTIFACT_NOT_FOUND', 'Evidence artifact not found'); };
const integrity = (): never => { throw new WorkbenchHttpError(422, 'INTEGRITY_MISMATCH', 'Evidence bytes failed integrity verification'); };
export function createEvidenceService({ repository, store, files, clock }: { repository: WorkbenchRepository; store: DraftStore; files: FileStore; clock: Clock }) {
  const sql = repository.sqlForModule('evidence');
  sql.execMigration('v1', 'CREATE TABLE wb_evidence_artifacts(artifact_id TEXT PRIMARY KEY,evidence_id TEXT NOT NULL,installation_id TEXT NOT NULL,owner_person_id TEXT NOT NULL,name TEXT NOT NULL,mime_type TEXT NOT NULL,bytes INTEGER NOT NULL,sha256 TEXT NOT NULL); CREATE INDEX wb_evidence_by_entity ON wb_evidence_artifacts(evidence_id);');
  const prepared = new Map<string, Artifact>();
  return {
    async fromHandle(context: CommandContext, { draftId, fileHandle }: { draftId: string; fileHandle: string }): Promise<Evidence> {
      const entry = store.getEntry(draftId), pkg = entry ? store.getPackage(entry.packageId) : null;
      if (!entry || entry.entityRef.entityType !== 'evidence' || !pkg || pkg.installationId !== context.installationId || pkg.ownerPersonId !== context.ownAccess.personId) return missing();
      const staged = await files.read(fileHandle, context.installationId, 'evidence', context.ownAccess.personId);
      const artifactId = newUuid();
      await mkdir(store.artifactDirectory, { recursive: true, mode: 0o700 }); await assertPhysicalPath(store.artifactDirectory, true);
      const handle = await open(path.join(store.artifactDirectory, artifactId), 'wx', 0o400);
      try { await handle.writeFile(staged.bytesValue); await handle.sync(); } finally { await handle.close(); }
      const file: FileArtifactRef = { artifactId, hash: `sha256:${staged.sha256}`, mimeType: staged.mediaType, bytes: staged.bytes };
      prepared.set(artifactId, { artifact_id: artifactId, evidence_id: entry.entityRef.id, installation_id: context.installationId, owner_person_id: pkg.ownerPersonId, name: staged.name, mime_type: staged.mediaType, bytes: staged.bytes, sha256: staged.sha256 });
      return evidenceSchema.parse({ ...entry.header, recordedAt: clock.now(), actor: context.actor, kind: 'file', file });
    },
    commitPrepared(context: CommandContext, value: Evidence) {
      if (value.kind !== 'file') return;
      const metadata = prepared.get(value.file.artifactId);
      if (!metadata || metadata.evidence_id !== value.id || metadata.installation_id !== context.installationId || metadata.owner_person_id !== context.ownAccess.personId) return missing();
      sql.run('INSERT INTO wb_evidence_artifacts VALUES(?,?,?,?,?,?,?,?)', [metadata.artifact_id, metadata.evidence_id, metadata.installation_id, metadata.owner_person_id, metadata.name, metadata.mime_type, metadata.bytes, metadata.sha256]);
      prepared.delete(metadata.artifact_id);
    },
    async readArtifactForContext(context: QueryContext, artifactId: string): Promise<ArtifactReadResult> {
      if (!uuidSchema.safeParse(artifactId).success) return missing();
      const metadata = sql.get<Artifact>('SELECT * FROM wb_evidence_artifacts WHERE artifact_id=?', [artifactId]);
      if (!metadata) return missing();
      const matches = (value: unknown) => { const parsed = evidenceSchema.safeParse(value); return parsed.success && parsed.data.kind === 'file' && parsed.data.file.artifactId === artifactId && parsed.data.file.hash === `sha256:${metadata.sha256}` && parsed.data.file.bytes === metadata.bytes && parsed.data.file.mimeType === metadata.mime_type; };
      const published = repository.readPublishedEvidenceForArtifact(artifactId);
      const anchor = published?.publicationAnchorId ? repository.readPublicationAnchor({ entityType: 'publication_anchor', id: published.publicationAnchorId }) : null;
      const publicMatch = anchor?.publicationState === 'confirmed' && matches(published);
      const ownMatch = metadata.installation_id === context.installationId && metadata.owner_person_id === context.ownAccess.personId && store.findOwn(context.installationId, context.ownAccess.personId, { entityType: 'evidence', id: metadata.evidence_id }).some(entry => store.history(entry.draftId).some(version => matches({ ...version.header, ...version.definition })));
      if (!publicMatch && !ownMatch) return missing();
      const filename = path.join(store.artifactDirectory, artifactId);
      try {
        await assertPhysicalPath(filename, false);
        const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        // Bounded verified bytes come from this one opened handle. Streaming this buffer
        // prevents a second path lookup/read and any later mutation from changing the response.
        let bytes: Buffer;
        try { const info = await handle.stat(); if (!info.isFile() || info.nlink !== 1 || info.size !== metadata.bytes || info.size > defaultFileLimits.evidenceBytes) return integrity(); bytes = await handle.readFile(); }
        finally { await handle.close(); }
        if (bytes.length !== metadata.bytes || createHash('sha256').update(bytes).digest('hex') !== metadata.sha256) return integrity();
        assertFileName(metadata.name); if (!/^[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+(?:; charset=[a-zA-Z0-9-]+)?$/.test(metadata.mime_type)) return integrity();
        return { stream: Readable.from([bytes]), name: metadata.name, mimeType: metadata.mime_type, bytes: metadata.bytes, sha256: metadata.sha256 };
      } catch (error) { if (error instanceof WorkbenchHttpError) throw error; if ((error as NodeJS.ErrnoException).code === 'ENOENT') return missing(); return integrity(); }
    },
  };
}
export type EvidenceService = ReturnType<typeof createEvidenceService>;
