import path from 'node:path';
import type { ActorRef, EntityRef, Header, VersionRef } from '../../domain/workbench/primitives';
import type { WorkbenchRepository } from '../../server/storage/workbench-repository';
import type { FieldProblem } from '../../server/workbench/protocol';
import { WorkbenchHttpError } from '../../server/workbench/protocol';
import type { DraftEntry, DraftPackageView } from './workbench-drafts';
import { schemaForEntity } from '../../domain/workbench/schemas';
import type { EvaluationMaterializationStore } from '../evaluation/workbench/prepare-evaluation';
import { stableJson } from '../../server/workbench/command-store';

export type StoredDraft = DraftEntry & { packageId: string; header: Header; localRevision: number };
export type StoredPackage = Omit<DraftPackageView,'entries'> & { installationId: string; entries: StoredDraft[] };
export function createDraftStore({ repository, artifactDirectory }: { repository: WorkbenchRepository; artifactDirectory: string }) {
  const sql = repository.sqlForModule('drafts');
  sql.execMigration('v1', `CREATE TABLE wb_drafts_packages(package_id TEXT PRIMARY KEY,installation_id TEXT NOT NULL,owner_person_id TEXT NOT NULL,revision INTEGER NOT NULL,base_commit TEXT);
    CREATE TABLE wb_drafts_entries(draft_id TEXT PRIMARY KEY,package_id TEXT NOT NULL,entity_type TEXT NOT NULL,object_id TEXT NOT NULL,base_ref TEXT,definition_json TEXT NOT NULL,complete INTEGER NOT NULL,problems_json TEXT NOT NULL,header_json TEXT NOT NULL,local_revision INTEGER NOT NULL,UNIQUE(package_id,entity_type,object_id));
    CREATE INDEX wb_drafts_object ON wb_drafts_entries(entity_type,object_id,package_id);
    CREATE TABLE wb_drafts_revisions(draft_id TEXT NOT NULL,revision INTEGER NOT NULL,definition_json TEXT NOT NULL,complete INTEGER NOT NULL,problems_json TEXT NOT NULL,header_json TEXT NOT NULL,PRIMARY KEY(draft_id,revision));`);
  sql.execMigration('v2-evaluation', `CREATE TABLE wb_drafts_derived(entity_type TEXT NOT NULL,object_id TEXT NOT NULL,revision INTEGER NOT NULL,package_id TEXT NOT NULL,payload_json TEXT NOT NULL,PRIMARY KEY(entity_type,object_id,revision));
    CREATE TABLE wb_drafts_evaluation_digest(package_id TEXT NOT NULL,digest TEXT NOT NULL,refs_json TEXT NOT NULL,PRIMARY KEY(package_id,digest));`);
  sql.execMigration('v3-proofs', 'CREATE TABLE wb_drafts_proofs(draft_id TEXT NOT NULL,kind TEXT NOT NULL,payload_json TEXT NOT NULL,PRIMARY KEY(draft_id,kind));');
  sql.execMigration('v4-frozen', 'CREATE TABLE wb_drafts_frozen(package_id TEXT NOT NULL,entity_type TEXT NOT NULL,object_id TEXT NOT NULL,revision INTEGER NOT NULL,payload_json TEXT NOT NULL,PRIMARY KEY(package_id,entity_type,object_id,revision));');
  type Row = { draft_id: string; package_id: string; entity_type: string; object_id: string; base_ref: string | null; definition_json: string; complete: number; problems_json: string; header_json: string; local_revision: number };
  const entry = (row: Row): StoredDraft => { const header = JSON.parse(row.header_json) as Header; return { draftId: row.draft_id, packageId: row.package_id, entityRef: { entityType: row.entity_type, id: row.object_id }, versionRef: { entityType: row.entity_type, id: row.object_id, revision: header.revision }, baseRef: row.base_ref ? JSON.parse(row.base_ref) : null, definition: JSON.parse(row.definition_json), complete: !!row.complete, problems: JSON.parse(row.problems_json), header, localRevision: row.local_revision }; };
  const getEntry = (draftId: string): StoredDraft | null => { const row = sql.get<Row>('SELECT * FROM wb_drafts_entries WHERE draft_id=?', [draftId]); return row ? entry(row) : null; };
  const getPackage = (packageId: string): StoredPackage | null => {
    const row = sql.get<{ package_id: string; installation_id: string; owner_person_id: string; revision: number; base_commit: string | null }>('SELECT * FROM wb_drafts_packages WHERE package_id=?', [packageId]);
    if (!row) return null;
    return { packageId, installationId: row.installation_id, ownerPersonId: row.owner_person_id, revision: row.revision, baseCommit: row.base_commit, entries: sql.all<Row>('SELECT * FROM wb_drafts_entries WHERE package_id=? ORDER BY draft_id', [packageId]).map(entry) };
  };
  const token = (value: Pick<StoredPackage, 'packageId' | 'revision'>) => `draft:${value.packageId}:${value.revision}`;
  const bump = (packageId: string) => { sql.run('UPDATE wb_drafts_packages SET revision=revision+1 WHERE package_id=?', [packageId]); return token(getPackage(packageId)!); };
  const readDraftVersion = (packageId: string, ref: VersionRef): Header | null => {
    const row = sql.get<{ payload_json: string }>('SELECT payload_json FROM wb_drafts_frozen WHERE package_id=? AND entity_type=? AND object_id=? AND revision=?', [packageId, ref.entityType, ref.id, ref.revision]);
    return row ? JSON.parse(row.payload_json) : null;
  };
  return {
    listOwnPackages(installationId:string,personId:string):StoredPackage[] {
      return sql.all<{package_id:string}>('SELECT package_id FROM wb_drafts_packages WHERE installation_id=? AND owner_person_id=? ORDER BY package_id',[installationId,personId]).map(row=>getPackage(row.package_id)!);
    },
    artifactDirectory: path.resolve(artifactDirectory), getEntry, getPackage, token,
    setProof(draftId: string, kind: string, value: object) { const updated = sql.run('UPDATE wb_drafts_proofs SET payload_json=? WHERE draft_id=? AND kind=?', [JSON.stringify(value), draftId, kind]); if (!updated.changes) sql.run('INSERT INTO wb_drafts_proofs VALUES(?,?,?)', [draftId, kind, JSON.stringify(value)]); },
    readProof<T>(draftId: string, kind: string): T | null { const row = sql.get<{ payload_json: string }>('SELECT payload_json FROM wb_drafts_proofs WHERE draft_id=? AND kind=?', [draftId, kind]); return row ? JSON.parse(row.payload_json) as T : null; },
    readDraftVersion,
    freeze(packageId: string, entityType: string, value: Header) {
      const ref = { entityType, id: value.id, revision: value.revision }; const previous = readDraftVersion(packageId, ref);
      if (previous) { if (stableJson(previous) !== stableJson(value)) throw new WorkbenchHttpError(409, 'REVISION_CONFLICT', 'Frozen draft version changed'); return; }
      schemaForEntity(entityType).parse(value);
      sql.run('INSERT INTO wb_drafts_frozen VALUES(?,?,?,?,?)', [packageId, entityType, value.id, value.revision, JSON.stringify(value)]);
    },
    frozenVersions(packageId: string) { return sql.all<{ entity_type: string; object_id: string; payload_json: string }>('SELECT entity_type,object_id,payload_json FROM wb_drafts_frozen WHERE package_id=? ORDER BY entity_type,object_id,revision', [packageId]).map(row => ({ entityRef: { entityType: row.entity_type, id: row.object_id }, value: JSON.parse(row.payload_json) as Header })); },
    readDerived(ref: VersionRef): { packageId: string; value: Header } | null {
      const row = sql.get<{ package_id: string; payload_json: string }>('SELECT package_id,payload_json FROM wb_drafts_derived WHERE entity_type=? AND object_id=? AND revision=?', [ref.entityType, ref.id, ref.revision]);
      return row ? { packageId: row.package_id, value: JSON.parse(row.payload_json) } : null;
    },
    readBasisContexts(packageId: string) {
      return sql.all<{payload_json:string}>('SELECT payload_json FROM wb_drafts_derived WHERE package_id=? AND entity_type=? ORDER BY object_id,revision',[packageId,'evaluation_basis']).map(row=>JSON.parse(row.payload_json) as import('../../domain/workbench/entities').EvaluationBasis);
    },
    evaluationStore(packageId: string): EvaluationMaterializationStore {
      return { transaction: repository.transaction,
        findEvaluationByDigest(digest) { const row = sql.get<{ refs_json: string }>('SELECT refs_json FROM wb_drafts_evaluation_digest WHERE package_id=? AND digest=?', [packageId, digest]); return row ? JSON.parse(row.refs_json) : null; },
        append(type, value) { if (!['evaluation_basis','calculation_result'].includes(type)) throw Error('Unsupported draft-derived entity'); schemaForEntity(type).parse(value); sql.run('INSERT INTO wb_drafts_derived VALUES(?,?,?,?,?)', [type, value.id, value.revision, packageId, JSON.stringify(value)]); return { entityType: type, id: value.id, revision: value.revision }; },
        remember(digest, refs) { sql.run('INSERT INTO wb_drafts_evaluation_digest VALUES(?,?,?)', [packageId, digest, JSON.stringify(refs)]); },
      };
    },
    createPackage(input: { packageId: string; installationId: string; ownerPersonId: string; baseCommit: string | null }) { sql.run('INSERT INTO wb_drafts_packages VALUES(?,?,?,0,?)', [input.packageId, input.installationId, input.ownerPersonId, input.baseCommit]); },
    find(packageId: string, ref: EntityRef) { const row = sql.get<Row>('SELECT * FROM wb_drafts_entries WHERE package_id=? AND entity_type=? AND object_id=?', [packageId, ref.entityType, ref.id]); return row ? entry(row) : null; },
    findOwn(installationId: string, personId: string | null, ref: EntityRef) {
      return sql.all<Row>('SELECT e.* FROM wb_drafts_entries e JOIN wb_drafts_packages p ON p.package_id=e.package_id WHERE p.installation_id=? AND p.owner_person_id=? AND e.entity_type=? AND e.object_id=? ORDER BY e.draft_id', [installationId, personId, ref.entityType, ref.id]).map(entry);
    },
    assertToken(packageId: string, expected: string | null) { const value = getPackage(packageId); if (!value || expected !== token(value)) throw new WorkbenchHttpError(409, 'REVISION_CONFLICT', 'The draft package changed; reload before saving'); },
    add(input: { draftId: string; packageId: string; entityRef: EntityRef; baseRef: VersionRef | null; definition: Record<string, unknown>; complete: boolean; problems: FieldProblem[]; header: Header }) {
      sql.run('INSERT INTO wb_drafts_entries VALUES(?,?,?,?,?,?,?,?,?,1)', [input.draftId, input.packageId, input.entityRef.entityType, input.entityRef.id, input.baseRef ? JSON.stringify(input.baseRef) : null, JSON.stringify(input.definition), input.complete ? 1 : 0, JSON.stringify(input.problems), JSON.stringify(input.header)]);
      sql.run('INSERT INTO wb_drafts_revisions VALUES(?,1,?,?,?,?)', [input.draftId, JSON.stringify(input.definition), input.complete ? 1 : 0, JSON.stringify(input.problems), JSON.stringify(input.header)]);
      return bump(input.packageId);
    },
    save(draftId: string, definition: Record<string, unknown>, complete: boolean, problems: FieldProblem[], actor: ActorRef, recordedAt: string) {
      const previous = getEntry(draftId)!; const changed = stableJson(previous.definition) !== stableJson(definition);
      const header = changed ? { ...previous.header, revision: previous.header.revision + (readDraftVersion(previous.packageId, previous.versionRef) ? 1 : 0), actor, recordedAt } : previous.header;
      sql.run('UPDATE wb_drafts_entries SET definition_json=?,complete=?,problems_json=?,header_json=?,local_revision=local_revision+1 WHERE draft_id=?', [JSON.stringify(definition), complete ? 1 : 0, JSON.stringify(problems), JSON.stringify(header), draftId]);
      sql.run('INSERT INTO wb_drafts_revisions VALUES(?,?,?,?,?,?)', [draftId, previous.localRevision + 1, JSON.stringify(definition), complete ? 1 : 0, JSON.stringify(problems), JSON.stringify(header)]);
      return bump(previous.packageId);
    },
    history(draftId: string) { return sql.all<{ definition_json: string; header_json: string }>('SELECT definition_json,header_json FROM wb_drafts_revisions WHERE draft_id=? ORDER BY revision', [draftId]).map(row => ({ definition: JSON.parse(row.definition_json) as Record<string, unknown>, header: JSON.parse(row.header_json) as Header })); },
  };
}
export type DraftStore = ReturnType<typeof createDraftStore>;
