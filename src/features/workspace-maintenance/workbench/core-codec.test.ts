import { afterEach, expect, it } from 'vitest';
import { createCoreWorkspaceArchiveCodec } from './core-codec';
import { fixture } from './test-fixture';
import { fixtureId, makeEntityGraph, makeNumericFixture, makePublicationAnchor } from '../../../../tests/fixtures/workbench/factories';
import { seedGraph } from '../../../../tests/fixtures/workbench/repository';
import { createWorkspaceArchive, validateWorkspaceArchive } from './workspace-archive';
const cleanup: Array<() => Promise<void>> = []; afterEach(async () => { for (const c of cleanup.splice(0)) await c(); });
it('rejects mismatched publication anchor identity in typed archives before writing any record', async () => {
  const f = await fixture(); cleanup.push(() => f.dispose()); const codec = createCoreWorkspaceArchiveCodec();
  const bad = makePublicationAnchor({ id: fixtureId(910030), packageId: fixtureId(910031) });
  const record = { moduleId: 'core', schemaId: 'core.publication_anchor', schemaVersion: 1, key: `publication_anchor/${bad.id}/1`, value: bad };
  expect(() => codec.validate(record)).toThrow();
  const metric = { ...makeNumericFixture().metrics[0], publicationAnchorId: null };
  const before = f.deps.repository.getStateRevision();
  expect(() => codec.restoreRecords(f.deps.repository, [{ moduleId: 'core', schemaId: 'core.metric_definition', schemaVersion: 1, key: `metric_definition/${metric.id}/1`, value: metric }, record])).toThrow();
  expect(f.deps.repository.exportWorkspaceCore()).toEqual([]);
  expect(f.deps.repository.getStateRevision()).toBe(before);
});
it('core codec refuses unknown schema, actor rebinding, malformed identities, and arbitrary SQL payloads', () => {
  const codec = createCoreWorkspaceArchiveCodec();
  for (const record of [
    { moduleId: 'core', schemaId: 'core.registry', schemaVersion: 1, key: 'registry/anything/1', value: {} },
    { moduleId: 'core', schemaId: 'sql', schemaVersion: 1, key: 'table', value: 'DROP TABLE wb_entity_versions' },
    { moduleId: 'registry', schemaId: 'core.goal', schemaVersion: 1, key: 'goal/anything/1', value: {} },
  ]) expect(() => codec.validate(record)).toThrow();
});
it('core export and restore use the repository complete snapshot ports or fail closed', async () => {
  const f = await fixture(); cleanup.push(() => f.dispose()); const codec = createCoreWorkspaceArchiveCodec();
  const missing = new Proxy(f.deps.repository, { get(target, property, receiver) { if (property === 'exportWorkspaceCore' || property === 'restoreWorkspaceCore') return undefined; return Reflect.get(target, property, receiver); } });
  expect(() => codec.exportRecords(missing)).toThrowError(expect.objectContaining({ code: 'SCHEMA_UNSUPPORTED' })); expect(() => codec.restoreRecords(missing, [])).toThrowError(expect.objectContaining({ code: 'SCHEMA_UNSUPPORTED' }));
});
it('roundtrips all real core versions and anchor metadata with unchanged historical actors and module records', async () => {
  const source = await fixture('personal-setting'); const target = await fixture(); cleanup.push(() => source.dispose(), () => target.dispose());
  source.deps.modules = new Map([...source.deps.modules, ['core', createCoreWorkspaceArchiveCodec()]]); target.deps.modules = new Map([...target.deps.modules, ['core', createCoreWorkspaceArchiveCodec()]]);
  const graph = makeEntityGraph(); const anchor = { ...graph.anchors[0], timeVerification: 'unknown' as const, mergedAt: null }; graph.anchors = [anchor]; seedGraph(source.deps.repository, graph);
  const fact = graph.input.facts[0]; source.deps.repository.append('observed_fact', { ...fact, revision: 2, value: '71', publicationAnchorId: null }, 1);
  source.deps.repository.appendPublicationAnchor({ ...anchor, timeVerification: 'verified', mergedAt: '2026-10-23T08:00:00Z' }, 1);
  const backup = await createWorkspaceArchive(source.context, { label: null, includeOriginals: true }, source.deps); const bytes = await source.archiveBytes(backup.backupId);
  const validated = await validateWorkspaceArchive(bytes, source.deps.modules, source.deps.workspace); const archivedAnchors = validated.records.filter(r => r.schemaId === 'core.publication_anchor'); expect(archivedAnchors.map(r => r.key.split('/').at(-1))).toEqual(['1', '2']);
  const upload = await target.upload(bytes); const preview = await target.service.previewRestore(target.context, { fileHandle: upload.fileHandle }); await target.service.applyRestore(target.context, { restoreToken: preview.restoreToken, confirmReplacement: true });
  expect(target.deps.modules.get('core')!.exportRecords(target.deps.repository)).toEqual(source.deps.modules.get('core')!.exportRecords(source.deps.repository));
  expect(target.deps.repository.readVersion({ entityType: 'observed_fact', id: fact.id, revision: 1 })).toEqual(fact); expect(target.deps.repository.getHead({ entityType: 'observed_fact', id: fact.id })).toMatchObject({ revision: 2, value: '71', actor: fact.actor }); expect(target.get()).toEqual([{ value: 'personal-setting' }]);
});
