import { z } from 'zod';
import type { Header } from '../../../domain/workbench/primitives';
import { entitySchemas, publicationAnchorSchema } from '../../../domain/workbench/schemas';
import type { WorkspaceCoreRecord } from '../../../server/storage/workbench-repository';
import { WorkbenchHttpError } from '../../../server/workbench/protocol';
import type { WorkspaceArchiveCodec, WorkspaceArchiveRecord } from './contracts';

/** Typed complete core snapshot, supplied by the repository owner. No SQL dump or private policy. */
export type WorkspaceCoreArchiveRecord = WorkspaceCoreRecord;
const unavailable = () => new WorkbenchHttpError(422, 'SCHEMA_UNSUPPORTED', 'Complete typed core archive ports are unavailable');
export function createCoreWorkspaceArchiveCodec(schemas: ReadonlyMap<string, z.ZodType<Header>> = entitySchemas): WorkspaceArchiveCodec {
  const decode = (record: WorkspaceArchiveRecord): WorkspaceCoreArchiveRecord => {
    if (record.moduleId !== 'core' || record.schemaVersion !== 1 || !/^core\.[a-z][a-z0-9_]*$/.test(record.schemaId)) throw unavailable();
    const entityType = record.schemaId.slice(5); const schema = entityType === 'publication_anchor' ? publicationAnchorSchema : schemas.get(entityType); if (!schema) throw unavailable(); const value = schema.parse(record.value);
    const prefix = `${entityType}/${value.id}/`; if (!record.key.startsWith(prefix)) throw unavailable(); const suffix = record.key.slice(prefix.length); const version = Number(suffix);
    if (!/^[1-9]\d*$/.test(suffix) || !Number.isSafeInteger(version) || (entityType !== 'publication_anchor' && value.revision !== version)) throw unavailable();
    return { entityType, version, value };
  };
  return {
    moduleId: 'core',
    exportRecords(repository) {
      if (typeof repository.exportWorkspaceCore !== 'function') throw unavailable();
      return repository.exportWorkspaceCore().map(r => { const record = { moduleId: 'core', schemaId: 'core.' + r.entityType, schemaVersion: 1, key: `${r.entityType}/${r.value.id}/${r.version}`, value: structuredClone(r.value) }; decode(record); return record; });
    },
    validate(record) { decode(record); },
    restoreRecords(repository, records) { if (typeof repository.restoreWorkspaceCore !== 'function') throw unavailable(); repository.restoreWorkspaceCore(records.map(decode)); },
    isUserData: () => true,
  };
}
