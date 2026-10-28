import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { z } from 'zod';
import type { EntityRef, EvaluationContext, Header, ScopeRef, Sha256, UtcInstant, UUIDv4, VersionRef } from '../../domain/workbench/primitives';
import { entityRefSchema, headerSchema, versionRefSchema } from '../../domain/workbench/primitives';
import { moscowEnd } from '../../domain/workbench/time';
import { WorkbenchError } from '../../domain/workbench/errors';
import type { Applicability, Capture, EvaluationInput, ManualCorrection, ObservedFact, WorkbenchEntity, WorkbenchEntityType } from '../../domain/workbench/entities';
import type { PublicationAnchor } from '../../domain/workbench/publication';
import { entityReferences, entitySchemas, publicationAnchorSchema } from '../../domain/workbench/schemas';
import type { ReferenceRequirement } from '../../domain/workbench/schemas';
import { migrateWorkbench } from './workbench-schema';

export type SqlValue = string | number | bigint | null | Uint8Array;
export interface WorkbenchSql {
  get<T>(sql: string, params?: SqlValue[]): T | null;
  all<T>(sql: string, params?: SqlValue[]): T[];
  run(sql: string, params?: SqlValue[]): { changes: number };
  execMigration(id: string, ddl: string): void;
}
export type EntityRegistration<T extends Header> = { schema: z.ZodType<T>; references: (value: T) => ReferenceRequirement[] };
export type EvaluationCandidateQuery = { sourceId: UUIDv4; assignmentId: UUIDv4; metricIds: UUIDv4[]; scopes: ScopeRef[]; businessTime: EvaluationContext['businessTime']; evaluatedAt: UtcInstant };
export type EvaluationCandidates = Pick<EvaluationInput, 'facts' | 'captures' | 'applicability' | 'corrections'>;
export interface WorkbenchRepository {
  getHead<T extends Header>(ref: EntityRef): T | null;
  readVersion<T extends Header>(ref: VersionRef): T | null;
  append<T extends Header>(entityType: string, value: T, expectedHead: number | null): VersionRef;
  transaction<T>(action: () => T): T;
  getStateRevision(): string;
  close(): void;
  readPublishedHead<T extends Header>(ref: EntityRef): T | null;
  readPublicationAnchor(ref: EntityRef): PublicationAnchor | null;
  appendPublicationAnchor(value: PublicationAnchor, expectedHead: number | null): VersionRef;
  readEvaluationCandidates(query: EvaluationCandidateQuery): EvaluationCandidates;
  findEvaluationByDigest(digest: Sha256): { basisRef: VersionRef; resultRef: VersionRef | null } | null;
  registerEntityType<T extends Header>(type: string, registration: EntityRegistration<T>): void;
  registerProjection(name: string, project: (entityType: string, value: Header) => void): void;
  sqlForModule(moduleId: string): WorkbenchSql;
}
type PayloadRow = { payload_json: string };
type Frame = { dirty: boolean; staged: Array<{ type: string; value: Header }> };
type Lease = { active: boolean; parent?: Lease };

export function createWorkbenchRepository(options: { filename: string; artifactRoot: string }): WorkbenchRepository {
  if (options.filename !== ':memory:') mkdirSync(path.dirname(path.resolve(options.filename)), { recursive: true });
  const artifactRoot = path.resolve(options.artifactRoot);
  mkdirSync(artifactRoot, { recursive: true });
  const db = new DatabaseSync(options.filename);
  migrateWorkbench(db);
  const registrations = new Map<string, EntityRegistration<Header>>();
  const projections = new Map<string, (type: string, value: Header) => void>();
  const frames: Frame[] = [];
  const leases = new AsyncLocalStorage<Lease>();
  let savepoint = 0;
  let closed = false;
  let projecting = false;
  const read = <T>(row: PayloadRow | undefined): T | null => row ? JSON.parse(row.payload_json) as T : null;
  const assertOpen = () => { if (closed) throw new WorkbenchError('REPOSITORY_CLOSED'); };
  const assertWritable = () => {
    assertOpen();
    for (let lease = leases.getStore(); lease; lease = lease.parent) if (!lease.active) throw new WorkbenchError('TRANSACTION_CONTEXT_CLOSED');
  };
  const currentFrame = () => { const frame = frames.at(-1); if (!frame) throw new WorkbenchError('TRANSACTION_REQUIRED'); return frame; };
  const headRevision = (type: string, id: string): number | null => (db.prepare('SELECT revision FROM wb_entity_heads WHERE entity_type=? AND id=?').get(type, id) as { revision: number } | undefined)?.revision ?? null;
  const anchorRow = (id: string) => db.prepare('SELECT revision,payload_json FROM wb_publication_anchors WHERE id=? ORDER BY revision DESC LIMIT 1').get(id) as ({ revision: number } & PayloadRow) | undefined;
  const registration = (type: string) => { const result = registrations.get(type); if (!result) throw new WorkbenchError('UNKNOWN_ENTITY_TYPE', { entityType: type }); return result; };
  const validateStaged = (frame: Frame) => {
    const targets = new Map<string, Header | PublicationAnchor>();
    for (const { type, value } of frame.staged) {
      for (const requirement of registration(type).references(value)) {
        const { ref, expectedEntityTypes, validateTarget } = requirement;
        if (!expectedEntityTypes.includes(ref.entityType)) throw new WorkbenchError('REFERENCE_TYPE_MISMATCH', { ref, expectedEntityTypes });
        const key = `${ref.entityType}/${ref.id}/${'revision' in ref ? ref.revision : 'head'}`;
        let parsed = targets.get(key);
        if (!parsed) {
          let target: unknown;
          if (ref.entityType === 'publication_anchor') {
            // An anchor's wire revision is a package revision, not a metadata-row version.
            if ('revision' in ref) throw new WorkbenchError('ANCHOR_VERSION_REF_FORBIDDEN');
            target = repository.readPublicationAnchor(ref);
          } else target = 'revision' in ref ? repository.readVersion(ref) : repository.getHead(ref);
          if (target === null) throw new WorkbenchError('REFERENCE_NOT_FOUND', { ref });
          parsed = ref.entityType === 'publication_anchor' ? publicationAnchorSchema.parse(target) : registration(ref.entityType).schema.parse(target);
          targets.set(key, parsed);
        }
        if (parsed.id !== ref.id || ('revision' in ref && parsed.revision !== ref.revision)) throw new WorkbenchError('REFERENCE_VERSION_MISMATCH', { ref });
        validateTarget?.(parsed);
      }
    }
  };
  const indexEntity = (type: string, value: Header) => {
    if (type === 'observed_fact') {
      const fact = value as ObservedFact; const time = fact.businessTime;
      db.prepare('INSERT INTO wb_fact_index VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(type, fact.id, fact.revision, fact.sourceId, fact.metricId, fact.scope.kind, fact.scope.id, time.kind, time.kind === 'as_of' ? time.date : time.kind === 'period' ? time.startInclusive : null, time.kind === 'period' ? time.endExclusive : null, fact.captureId, fact.factKey);
    } else if (type === 'capture') {
      const capture = value as Capture; db.prepare('INSERT INTO wb_capture_index VALUES(?,?,?)').run(capture.id, capture.revision, new Date(capture.capturedAt).toISOString());
    } else if (type === 'applicability') {
      const a = value as Applicability; db.prepare('INSERT INTO wb_applicability_index VALUES(?,?,?,?,?,?)').run(a.id, a.revision, a.assignmentId, a.metricId, a.period.startInclusive, a.period.endExclusive);
    } else if (type === 'manual_correction') {
      const correction = value as ManualCorrection; db.prepare('INSERT INTO wb_correction_index VALUES(?,?,?)').run(correction.id, correction.revision, correction.factKey);
    }
  };
  const atomic = <T>(action: () => T): T => frames.length ? action() : repository.transaction(action);

  const repository: WorkbenchRepository = {
    getHead<T extends Header>(ref: EntityRef): T | null {
      assertOpen(); entityRefSchema.parse(ref);
      return read<T>(db.prepare('SELECT v.payload_json FROM wb_entity_versions v JOIN wb_entity_heads h ON h.entity_type=v.entity_type AND h.id=v.id AND h.revision=v.revision WHERE h.entity_type=? AND h.id=?').get(ref.entityType, ref.id) as PayloadRow | undefined);
    },
    readVersion<T extends Header>(ref: VersionRef): T | null {
      assertOpen(); versionRefSchema.parse(ref);
      return read<T>(db.prepare('SELECT payload_json FROM wb_entity_versions WHERE entity_type=? AND id=? AND revision=?').get(ref.entityType, ref.id, ref.revision) as PayloadRow | undefined);
    },
    append<T extends Header>(type: string, value: T, expectedHead: number | null): VersionRef {
      assertWritable(); if (projecting) throw new WorkbenchError('PROJECTION_ENTITY_WRITE_FORBIDDEN');
      return atomic(() => {
        const parsed = registration(type).schema.parse(value);
        const actual = headRevision(type, parsed.id);
        if (type === 'capture' && (actual !== null || parsed.revision !== 1)) throw new WorkbenchError('CAPTURE_IMMUTABLE');
        if (actual !== expectedHead || parsed.revision !== (actual ?? 0) + 1) throw new WorkbenchError('REVISION_CONFLICT', { entityType: type, id: parsed.id, expectedHead, actual });
        db.prepare('INSERT INTO wb_entity_versions VALUES(?,?,?,?,?,?)').run(type, parsed.id, parsed.revision, JSON.stringify(parsed), parsed.recordedAt, parsed.publicationAnchorId);
        db.prepare('INSERT INTO wb_entity_heads VALUES(?,?,?) ON CONFLICT(entity_type,id) DO UPDATE SET revision=excluded.revision').run(type, parsed.id, parsed.revision);
        indexEntity(type, parsed);
        const frame = currentFrame(); frame.dirty = true; frame.staged.push({ type, value: parsed });
        return { entityType: type, id: parsed.id, revision: parsed.revision };
      });
    },
    transaction<T>(action: () => T): T {
      assertWritable();
      if (action.constructor.name === 'AsyncFunction' || action.constructor.name === 'AsyncGeneratorFunction') throw new WorkbenchError('ASYNC_TRANSACTION_FORBIDDEN');
      const outer = frames.length === 0; const point = 'wb_save_' + (++savepoint);
      const frame: Frame = { dirty: false, staged: [] };
      const lease: Lease = { active: true, parent: leases.getStore() };
      db.exec(outer ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${point}`); frames.push(frame);
      try {
        return leases.run(lease, () => {
          const result = action();
          if (result !== null && (typeof result === 'object' || typeof result === 'function') && typeof (result as { then?: unknown }).then === 'function') {
            // Consume rejection to avoid an unhandled Promise; never invoke an arbitrary thenable.
            if (result instanceof Promise) void result.catch(() => undefined);
            throw new WorkbenchError('ASYNC_TRANSACTION_FORBIDDEN');
          }
          if (outer) {
            validateStaged(frame);
            projecting = true;
            try { for (const entity of frame.staged) for (const project of projections.values()) {
              const projected = project(entity.type, entity.value) as unknown;
              if (projected !== null && typeof projected === 'object' && typeof (projected as { then?: unknown }).then === 'function') {
                if (projected instanceof Promise) void projected.catch(() => undefined);
                throw new WorkbenchError('ASYNC_TRANSACTION_FORBIDDEN');
              }
            } } finally { projecting = false; }
            if (frame.dirty) db.prepare("UPDATE wb_meta SET value=? WHERE key='state_revision'").run((BigInt(repository.getStateRevision()) + 1n).toString());
            db.exec('COMMIT');
          } else {
            db.exec(`RELEASE SAVEPOINT ${point}`);
            const parent = frames.at(-2)!; parent.dirty ||= frame.dirty; parent.staged.push(...frame.staged);
          }
          return result;
        });
      } catch (error) {
        db.exec(outer ? 'ROLLBACK' : `ROLLBACK TO SAVEPOINT ${point}; RELEASE SAVEPOINT ${point}`);
        throw error;
      } finally { lease.active = false; frames.pop(); }
    },
    getStateRevision(): string {
      assertOpen(); return (db.prepare("SELECT value FROM wb_meta WHERE key='state_revision'").get() as { value: string }).value;
    },
    close() { if (!closed) { if (frames.length) throw new WorkbenchError('TRANSACTION_ACTIVE'); db.close(); closed = true; } },
    readPublishedHead<T extends Header>(ref: EntityRef): T | null {
      assertOpen(); entityRefSchema.parse(ref);
      return read<T>(db.prepare(`SELECT v.payload_json FROM wb_entity_versions v JOIN wb_publication_anchors a ON a.id=v.publication_anchor_id
        AND a.revision=(SELECT MAX(a2.revision) FROM wb_publication_anchors a2 WHERE a2.id=a.id)
        WHERE v.entity_type=? AND v.id=? AND a.publication_state='confirmed' ORDER BY v.revision DESC LIMIT 1`).get(ref.entityType, ref.id) as PayloadRow | undefined);
    },
    readPublicationAnchor(ref: EntityRef): PublicationAnchor | null {
      assertOpen(); entityRefSchema.parse(ref); return ref.entityType === 'publication_anchor' ? read<PublicationAnchor>(anchorRow(ref.id)) : null;
    },
    appendPublicationAnchor(value: PublicationAnchor, expectedHead: number | null): VersionRef {
      assertWritable(); if (projecting) throw new WorkbenchError('PROJECTION_ENTITY_WRITE_FORBIDDEN');
      return atomic(() => {
        const parsed = publicationAnchorSchema.parse(value); const previous = anchorRow(parsed.id); const actual = previous?.revision ?? null;
        if (actual !== expectedHead) throw new WorkbenchError('REVISION_CONFLICT', { entityType: 'publication_anchor', expectedHead, actual });
        if (previous) {
          const old = JSON.parse(previous.payload_json) as PublicationAnchor;
          if (old.publicationState === 'confirmed' && (['packageId', 'revision', 'contentHash', 'repositoryId', 'targetBranch', 'mainCommit'] as const).some(key => old[key] !== parsed[key])) throw new WorkbenchError('PUBLICATION_CONTENT_IMMUTABLE');
          if (old.publicationState === 'confirmed' && parsed.publicationState !== 'confirmed') throw new WorkbenchError('PUBLICATION_CONTENT_IMMUTABLE');
          if (old.timeVerification === 'verified' && (parsed.timeVerification !== 'verified' || parsed.mergedAt !== old.mergedAt)) throw new WorkbenchError('PUBLICATION_TIME_IMMUTABLE');
        }
        const metadataRevision = (actual ?? 0) + 1;
        db.prepare('INSERT INTO wb_publication_anchors VALUES(?,?,?,?,?)').run(parsed.id, metadataRevision, JSON.stringify(parsed), parsed.publicationState, parsed.mergedAt);
        currentFrame().dirty = true;
        return { entityType: 'publication_anchor', id: parsed.id, revision: metadataRevision };
      });
    },
    readEvaluationCandidates(query: EvaluationCandidateQuery): EvaluationCandidates {
      assertOpen();
      const empty: EvaluationCandidates = { facts: [], captures: [], applicability: [], corrections: [] };
      if (!query.metricIds.length || !query.scopes.length) return empty;
      const metricParams = query.metricIds.map(() => '?').join(',');
      const scopeSql = "(f.scope_kind,f.scope_id) IN (SELECT json_extract(value,'$.kind'),json_extract(value,'$.id') FROM json_each(?))";
      const time = query.businessTime;
      const cutoff = new Date(Math.min(Date.parse(query.evaluatedAt), time.kind === 'as_of' ? Date.parse(moscowEnd(time.date)) : Infinity)).toISOString();
      const timeSql = time.kind === 'as_of' ? "f.business_kind='as_of' AND f.business_start<=?" : "f.business_kind='period' AND f.business_start=? AND f.business_end=?";
      const params: SqlValue[] = [query.sourceId, ...query.metricIds, JSON.stringify(query.scopes), ...(time.kind === 'as_of' ? [time.date] : [time.startInclusive, time.endExclusive]), cutoff];
      const rows = db.prepare(`SELECT v.payload_json FROM wb_fact_index f INDEXED BY wb_fact_scope_time
        JOIN wb_entity_versions v ON v.entity_type=f.entity_type AND v.id=f.id AND v.revision=f.revision
        JOIN wb_capture_index c ON c.id=f.capture_id WHERE f.source_id=? AND f.metric_id IN (${metricParams})
        AND (${scopeSql}) AND ${timeSql} AND c.captured_at<=? ORDER BY f.id,f.revision`).all(...params) as PayloadRow[];
      const factMap = new Map<string, ObservedFact>();
      const captures = new Map<string, Capture>();
      const include = (fact: ObservedFact) => {
        const key = `${fact.id}/${fact.revision}`; if (factMap.has(key)) return; factMap.set(key, fact);
        if (!captures.has(fact.captureId)) {
          const capture = repository.getHead<Capture>({ entityType: 'capture', id: fact.captureId });
          if (capture) captures.set(capture.id, capture);
        }
        for (const ref of fact.lineage.inputFactRefs) { const input = repository.readVersion<ObservedFact>(ref); if (input) include(input); }
      };
      rows.forEach(row => include(JSON.parse(row.payload_json) as ObservedFact));
      const published = <T extends Header>(rows: Array<{ id: string }>, type: string): T[] => [...new Set(rows.map(r => r.id))].flatMap(id => { const entity = repository.readPublishedHead<T>({ entityType: type, id }); return entity ? [entity] : []; });
      const start = time.kind === 'as_of' ? time.date : time.startInclusive;
      const end = time.kind === 'as_of' ? time.date : time.endExclusive;
      const applicabilityRows = db.prepare(`SELECT id FROM wb_applicability_index INDEXED BY wb_applicability_assignment WHERE assignment_id=? AND metric_id IN (${metricParams}) AND start_date${time.kind === 'as_of' ? '<=' : '<'}? AND (end_date IS NULL OR end_date>?)`).all(query.assignmentId, ...query.metricIds, end, start) as Array<{ id: string }>;
      const keys = [...new Set([...factMap.values()].map(f => f.factKey))];
      const correctionRows = keys.length ? db.prepare(`SELECT id FROM wb_correction_index INDEXED BY wb_correction_fact_key WHERE fact_key IN (${keys.map(() => '?').join(',')})`).all(...keys) as Array<{ id: string }> : [];
      return { facts: [...factMap.values()], captures: [...captures.values()], applicability: published<Applicability>(applicabilityRows, 'applicability'), corrections: published<ManualCorrection>(correctionRows, 'manual_correction') };
    },
    findEvaluationByDigest(digest) {
      assertOpen();
      const row = db.prepare('SELECT basis_id,basis_revision,result_id,result_revision FROM wb_evaluation_digest WHERE digest=?').get(digest) as { basis_id: string; basis_revision: number; result_id: string | null; result_revision: number | null } | undefined;
      return row ? { basisRef: { entityType: 'evaluation_basis', id: row.basis_id, revision: row.basis_revision }, resultRef: row.result_id === null ? null : { entityType: 'calculation_result', id: row.result_id, revision: row.result_revision! } } : null;
    },
    registerEntityType<T extends Header>(type: string, config: EntityRegistration<T>) {
      assertOpen(); if (!/^[a-z][a-z0-9_]*$/.test(type) || registrations.has(type)) throw new WorkbenchError('ENTITY_TYPE_ALREADY_REGISTERED', { type });
      // Every registration must still return Header; the generic type is erased only inside this registry.
      registrations.set(type, { schema: config.schema, references: value => config.references(value as T) });
    },
    registerProjection(name, project) {
      assertOpen(); if (!name || projections.has(name)) throw new WorkbenchError('PROJECTION_ALREADY_REGISTERED', { name });
      if (project.constructor.name === 'AsyncFunction') throw new WorkbenchError('ASYNC_TRANSACTION_FORBIDDEN');
      projections.set(name, project);
    },
    sqlForModule(moduleId) {
      assertOpen();
      if (!/^[a-z][a-z0-9_]*$/.test(moduleId) || ['entity', 'publication', 'fact', 'capture', 'applicability', 'correction', 'schema'].includes(moduleId)) throw new WorkbenchError('INVALID_MODULE_ID');
      const prefix = `wb_${moduleId}_`;
      const guard = (sql: string, migration = false) => {
        // A defense for trusted static adapters, never an interpreter for user-supplied SQL.
        // SQLite accepts single-quoted identifiers. Do not erase a possible table name as if it were data.
        const withoutComments = sql.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, ' ');
        if (/\b(?:FROM|JOIN|INTO|UPDATE|TABLE|REFERENCES)\s*(?:IF\s+(?:NOT\s+)?EXISTS\s+)?(?:\(\s*)*'/i.test(withoutComments)
          || (/\bCREATE\s+(?:UNIQUE\s+)?INDEX\b/i.test(withoutComments) && /\bON\s*'/i.test(withoutComments))) throw new WorkbenchError('MODULE_SQL_NAMESPACE_FORBIDDEN', { moduleId });
        const tokens = sql.replace(/'([^']|'')*'/g, "''").replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, ' ');
        if (/\b(?:ATTACH|DETACH|PRAGMA|VACUUM|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|TRIGGER)\b/i.test(tokens)
          || /\bsqlite_\w+/i.test(tokens) || (!migration && /;\s*\S/.test(tokens))) throw new WorkbenchError('MODULE_SQL_FORBIDDEN');
        const names = tokens.match(/\bwb_[a-z0-9_]+\b/gi) ?? [];
        const tablePattern = /\b(?:FROM|JOIN|INTO|UPDATE|TABLE|REFERENCES)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|([a-zA-Z_][\w.]*))/gi;
        const tables = [...tokens.matchAll(tablePattern)].map(match => match[1] ?? match[2] ?? match[3] ?? match[4]);
        if (/\bCREATE\s+(?:UNIQUE\s+)?INDEX\b/i.test(tokens)) {
          const indexTable = /\bON\s+(?:"([^"]+)"|([a-zA-Z_][\w.]*))/i.exec(tokens);
          if (indexTable) tables.push(indexTable[1] ?? indexTable[2]);
        }
        if (!names.length || [...names, ...tables].some(name => !name.toLowerCase().startsWith(prefix))) throw new WorkbenchError('MODULE_SQL_NAMESPACE_FORBIDDEN', { moduleId });
      };
      return {
        get<T>(sql: string, params: SqlValue[] = []): T | null { assertOpen(); guard(sql); if (!/^\s*(SELECT|EXPLAIN)\b/i.test(sql)) throw new WorkbenchError('MODULE_SQL_READ_ONLY'); return db.prepare(sql).get(...params) as T | undefined ?? null; },
        all<T>(sql: string, params: SqlValue[] = []): T[] { assertOpen(); guard(sql); if (!/^\s*(SELECT|EXPLAIN)\b/i.test(sql)) throw new WorkbenchError('MODULE_SQL_READ_ONLY'); return db.prepare(sql).all(...params) as T[]; },
        run(sql: string, params: SqlValue[] = []) { assertWritable(); guard(sql); return atomic(() => { const result = db.prepare(sql).run(...params); if (result.changes) currentFrame().dirty = true; return { changes: Number(result.changes) }; }); },
        execMigration(id: string, ddl: string) {
          assertWritable(); guard(ddl, true); if (!/^[a-zA-Z0-9_.-]+$/.test(id)) throw new WorkbenchError('INVALID_MIGRATION_ID');
          atomic(() => { const key = `${moduleId}:${id}`; if (db.prepare('SELECT id FROM wb_schema_migrations WHERE id=?').get(key)) return;
            db.exec(ddl); db.prepare('INSERT INTO wb_schema_migrations VALUES(?,?)').run(key, new Date().toISOString()); currentFrame().dirty = true;
          });
        },
      };
    },
  };
  for (const [type, schema] of entitySchemas) repository.registerEntityType(type, { schema, references: value => entityReferences(type as WorkbenchEntityType, value as WorkbenchEntity) });
  return repository;
}
