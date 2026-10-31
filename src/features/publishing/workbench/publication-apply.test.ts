import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { fixtureId, makeEntityGraph, makeHeader, makeNumericFixture, makePublicationAnchor } from '../../../../tests/fixtures/workbench/factories';
import { seedGraph } from '../../../../tests/fixtures/workbench/repository';
import type { CalculationResult, EvaluationBasis, WorkbenchEntity, WorkbenchEntityType } from '../../../domain/workbench/entities';
import { publicationAnchorSchema } from '../../../domain/workbench/schemas';
import { createWorkbenchRepository } from '../../../server/storage/workbench-repository';
import type { CommandContext } from '../../../server/workbench/command-registry';
import { createCommandStore, withCommandExecution } from '../../../server/workbench/command-store';
import { createPackageArtifactStore } from './package-artifacts';
import { buildPackageManifest, canonicalBytes, hashBytes } from './package-manifest';
import { createUnavailableBitbucketPort } from './bitbucket-port';
import { canonicalBasis, digestBasis } from '../../evaluation/workbench/basis';
import { evaluateAssignment } from '../../evaluation/workbench/evaluate';
import { createDraftStore } from '../../catalog/workbench-draft-store';
import { createPreferencesService } from '../../system/workbench-preferences';
import { createEvidenceService } from '../../evidence/workbench-evidence';
import { createFileStore, defaultFileLimits } from '../../../server/workbench/files';
import { applyVerifiedPublication, readAppliedPublication, type PublicationApplyDependencies } from './publication-apply';
import type { VerifiedMain } from './contracts';

type Entry = { entityType: WorkbenchEntityType; value: WorkbenchEntity };
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
const packageId = fixtureId(261001), commit = 'b'.repeat(40);
const resultSchema = z.strictObject({ appliedCommit: z.string(), stateRevision: z.string(), anchors: z.array(publicationAnchorSchema), warnings: z.array(z.unknown()) });
function capsule(entries: Entry[], id = packageId, revision = 1, extraFiles: ReadonlyMap<string, Uint8Array> = new Map()) {
  const files = new Map<string, Uint8Array>([...entries.map(({ entityType, value }) => [`records/${entityType}/${value.id}/${value.revision}.json`, canonicalBytes(value)] as const), ...extraFiles]);
  const manifest = buildPackageManifest({ package: { schemaVersion: 1, packageId: id, cycleId: fixtureId(261002), curatorPersonId: fixtureId(17), revision, baseCommit: 'a'.repeat(40), targetBranch: 'main', createdAt: '2026-10-29T08:00:00Z' }, files });
  const prefix = `published/workbench/packages/${id}/${revision}/`;
  const tree = new Map<string, Uint8Array>([...files].map(([name, bytes]) => [prefix + name, bytes])); tree.set(prefix + 'manifest.json', canonicalBytes(manifest));
  return { manifest, files, tree };
}
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'uor-t26-apply-'));
  const repository = createWorkbenchRepository({ filename: path.join(root, 'test.sqlite'), artifactRoot: path.join(root, 'evidence') });
  cleanups.push(() => { repository.close(); if (!path.basename(root).startsWith('uor-t26-apply-')) throw Error('Unsafe cleanup'); rmSync(root, { recursive: true, force: true }); });
  const input = makeNumericFixture({ scope: { kind: 'dit', id: fixtureId(101) } });
  const graph = makeEntityGraph(input);
  graph.entries = graph.entries.map(entry => ({ ...entry, value: { ...entry.value, publicationAnchorId: packageId } }));
  const original = capsule(graph.entries);
  let main: VerifiedMain = { repositoryId: 'synthetic-main', commit, files: original.tree };
  const artifacts = createPackageArtifactStore({ artifactRoot: path.join(root, 'packages') });
  const context: CommandContext = { requestId: 'synthetic-request', commandId: fixtureId(261003), installationId: fixtureId(1), actor: makeHeader(1).actor, repository, clock: { now: () => '2026-10-31T08:00:00Z' }, ownAccess: { role: 'viewer', personId: null, displayName: null, policyState: 'unavailable', checkedAt: null } };
  const deps: PublicationApplyDependencies = { repository, artifacts, clock: context.clock, bitbucket: null, publication: { mode: 'demo-only', classifyRecord: () => true }, git: { async readMain() { return main; }, async prepare() { throw Error('Unexpected write'); }, async inspectRemote() { throw Error('Unexpected write'); }, async verifyPrepared() { throw Error('Unexpected write'); } } };
  const commands = createCommandStore(repository);
  readAppliedPublication(repository);
  let serial = 261010;
  const begin = (mainCommit = main.commit, id = fixtureId(serial++)) => { const request = { commandId: id, name: 'publication.apply', baseRevision: null, payload: { mainCommit } }; commands.begin(request, context.installationId); return { ...context, commandId: id }; };
  const run = (ctx = begin(), mainCommit = main.commit, schema: z.ZodType = resultSchema) => withCommandExecution(ctx, schema, () => applyVerifiedPublication(ctx, { mainCommit }, deps));
  return { root, repository, graph, input, original, context, deps, commands, begin, run, main: () => main, setMain: (value: VerifiedMain) => { main = value; } };
}
function proofEntries(f: ReturnType<typeof fixture>) {
  const content = canonicalBasis(f.input);
  const basis: EvaluationBasis = { ...makeHeader(16, { publicationAnchorId: packageId }), ...content, evaluatedAt: f.input.context.evaluatedAt, digest: digestBasis(content) };
  const numeric = evaluateAssignment(f.input);
  const result: CalculationResult = { ...makeHeader(18, { publicationAnchorId: packageId }), ...numeric };
  return [...f.graph.entries, { entityType: 'evaluation_basis' as const, value: basis }, { entityType: 'calculation_result' as const, value: result }, { entityType: 'attestation' as const, value: { ...makeHeader(20, { publicationAnchorId: packageId }), basisDigest: basis.digest, comment: 'Synthetic agreement', evidenceIds: [] } }, { entityType: 'agreed_snapshot' as const, value: { ...makeHeader(21, { publicationAnchorId: packageId }), basisRef: numeric.basisRef, numericResult: numeric, manualStatusRef: null, attestationRef: { entityType: 'attestation', id: fixtureId(20), revision: 1 } } }];
}

it('applies real capsules for a reader without REST and commits anchor, records, pointer and receipt together', async () => {
  const f = fixture(), ctx = f.begin(), before = f.repository.getStateRevision();
  const result = await f.run(ctx);
  expect(result).toMatchObject({ appliedCommit: commit, stateRevision: (BigInt(before) + 1n).toString(), anchors: [{ id: packageId, packageId, revision: 1, publicationState: 'confirmed', timeVerification: 'unknown', mergedAt: null, mainCommit: commit }] });
  expect(result.stateRevision).toBe(f.repository.getStateRevision());
  expect(f.repository.readPublishedHead({ entityType: 'goal_assignment', id: f.input.assignment.id })).toEqual({ ...f.input.assignment, publicationAnchorId: packageId });
  expect(readAppliedPublication(f.repository)).toEqual({ repositoryId: 'synthetic-main', commit });
  expect(JSON.parse(f.commands.get(ctx.installationId, ctx.commandId)!.receipt_json!).result).toEqual(result);
  expect(() => f.repository.readPublishedAt({ entityType: 'goal_assignment', id: f.input.assignment.id }, '2026-10-30T09:00:00Z')).toThrowError(expect.objectContaining({ code: 'EFFECTIVE_TIME_UNVERIFIED' }));
});

it.each(['bad_manifest', 'naked_record', 'foreign_anchor', 'missing_reference', 'unsupported_schema', 'missing_classification', 'rejected_classification', 'method_mode'])('rejects %s without partial data or an applied pointer', async fault => {
  const f = fixture();
  let entries = structuredClone(f.graph.entries);
  if (fault === 'foreign_anchor') entries[0].value.publicationAnchorId = fixtureId(261099);
  if (fault === 'missing_reference') entries = entries.filter(entry => entry.entityType !== 'source_field_mapping');
  if (fault === 'unsupported_schema') Object.assign(entries[0].value, { schemaVersion: 2 });
  if (fault === 'method_mode') entries = entries.map(entry => entry.entityType === 'method_version' ? { ...entry, value: { ...makeHeader(14, { publicationAnchorId: packageId }), mode: 'manual_status' } } : entry);
  const incoming = capsule(entries);
  let files = incoming.tree;
  if (fault === 'bad_manifest') files.set(`published/workbench/packages/${packageId}/1/manifest.json`, canonicalBytes({ ...incoming.manifest, files: [] }));
  if (fault === 'naked_record') files = new Map([['records/directory_entity/' + entries[0].value.id + '/1.json', canonicalBytes(entries[0].value)]]);
  if (fault === 'missing_classification') delete f.deps.publication;
  if (fault === 'rejected_classification') f.deps.publication!.classifyRecord = () => false;
  f.setMain({ ...f.main(), files });
  const ctx = f.begin(), before = f.repository.getStateRevision();
  await expect(f.run(ctx)).rejects.toThrow();
  expect(readAppliedPublication(f.repository)).toBeNull();
  expect(f.repository.readPublicationAnchor({ entityType: 'publication_anchor', id: packageId })).toBeNull();
  expect(f.repository.readPublishedCatalog()).toEqual([]);
  expect(f.repository.getStateRevision()).toBe(before);
  expect(f.commands.get(ctx.installationId, ctx.commandId)?.receipt_json).toBeNull();
});

it('rejects an invalid older capsule even when only the latest revision would be imported', async () => {
  const f = fixture(), old = capsule(f.graph.entries), latest = capsule(f.graph.entries, packageId, 2);
  old.tree.set(`published/workbench/packages/${packageId}/1/manifest.json`, canonicalBytes({ ...old.manifest, files: [] }));
  f.setMain({ ...f.main(), files: new Map([...old.tree, ...latest.tree]) });
  await expect(f.run()).rejects.toThrow();
  expect(readAppliedPublication(f.repository)).toBeNull();
});

it('imports only the highest capsule revision of a package', async () => {
  const f = fixture(), abandoned = capsule([{ entityType: 'metric_definition', value: { ...f.input.metrics[0], publicationAnchorId: packageId, name: 'Abandoned proposal' } }]);
  const latest = capsule(f.graph.entries, packageId, 2);
  f.setMain({ ...f.main(), files: new Map([...abandoned.tree, ...latest.tree]) });
  const result = await f.run();
  expect(result.anchors[0].revision).toBe(2);
  expect(f.repository.readPublishedHead({ entityType: 'metric_definition', id: f.input.metrics[0].id })).toMatchObject({ name: 'demo_metric_0' });
});

it('rolls back domain versions, anchors, applied pointer and receipt when a projection fails', async () => {
  const f = fixture();
  f.repository.registerProjection('synthetic-failure', () => { throw Error('Synthetic projection failure'); });
  const ctx = f.begin(), before = f.repository.getStateRevision();
  await expect(f.run(ctx)).rejects.toThrow('Synthetic projection failure');
  expect(f.repository.getStateRevision()).toBe(before);
  expect(f.repository.getHead({ entityType: 'goal_assignment', id: f.input.assignment.id })).toBeNull();
  expect(f.repository.readPublicationAnchor({ entityType: 'publication_anchor', id: packageId })).toBeNull();
  expect(readAppliedPublication(f.repository)).toBeNull();
  expect(f.commands.get(ctx.installationId, ctx.commandId)?.receipt_json).toBeNull();
});

it('does not activate an unrelated private record reusing the package anchor UUID', async () => {
  const f = fixture();
  f.repository.appendPublicationAnchor(makePublicationAnchor({ id: packageId, packageId, publicationState: 'unconfirmed', timeVerification: 'unknown', mergedAt: null, verifiedAt: null, mainCommit: null }), null);
  const privateRecord = { ...makeHeader(261080, { publicationAnchorId: packageId }), name: 'Private metric', unit: { code: 'demo', label: 'Demo' }, domain: 'nonnegative_decimal' as const };
  f.repository.append('metric_definition', privateRecord, null);
  await expect(f.run()).rejects.toThrow();
  expect(f.repository.readPublishedHead({ entityType: 'metric_definition', id: privateRecord.id })).toBeNull();
  expect(f.repository.readPublicationAnchor({ entityType: 'publication_anchor', id: packageId })?.publicationState).toBe('unconfirmed');
});

it('preserves a higher successful local fact, correction and private namespaces while importing old Git fallback', async () => {
  const f = fixture();
  const pending = makePublicationAnchor({ id: packageId, packageId, publicationState: 'unconfirmed', timeVerification: 'unknown', mergedAt: null, verifiedAt: null, mainCommit: null });
  seedGraph(f.repository, { ...f.graph, anchors: [pending] });
  const capture = { ...f.input.captures[0], id: fixtureId(261090), publicationAnchorId: null, capturedAt: '2026-10-31T07:00:00Z', sourceUpdatedAt: '2026-10-31T07:00:00Z' };
  const fact = { ...f.input.facts[0], revision: 2, publicationAnchorId: null, captureId: capture.id, value: '93', lineage: { ...f.input.facts[0].lineage, captureId: capture.id } };
  const correction = { ...makeHeader(261091), factKey: fact.factKey, originalFactRefs: [{ entityType: 'observed_fact', id: fact.id, revision: 2 }], replacement: '94', reason: 'Synthetic local correction' };
  f.repository.transaction(() => { f.repository.append('capture', capture, null); f.repository.append('observed_fact', fact, 1); f.repository.append('manual_correction', correction, null); });
  const drafts = createDraftStore({ repository: f.repository, artifactDirectory: path.join(f.root, 'draft-evidence') });
  const draftPackageId = fixtureId(261180), draftId = fixtureId(261181), draftObjectId = fixtureId(261182);
  drafts.createPackage({ packageId: draftPackageId, installationId: f.context.installationId, ownerPersonId: fixtureId(17), baseCommit: 'a'.repeat(40) });
  drafts.add({ packageId: draftPackageId, draftId, entityRef: { entityType: 'core_goal_definition', id: draftObjectId }, baseRef: null, definition: { title: 'Unsaved local form' }, complete: false, problems: [], header: makeHeader(261182) });
  const preferences = createPreferencesService({ repository: f.repository, installationId: f.context.installationId, clock: f.context.clock });
  preferences.backup.restore({ schemaVersion: 1, values: { context: null, sorts: {}, visual: { theme: 'dark', density: 'compact' }, notificationPersonId: null } });
  const savedDraft = drafts.getPackage(draftPackageId), savedHistory = drafts.history(draftId), savedPreferences = preferences.backup.exportSnapshot(), preferencesToken = preferences.editToken(f.context.installationId);
  await f.run();
  expect(f.repository.getHead({ entityType: 'observed_fact', id: fact.id })).toEqual(fact);
  expect(f.repository.getHead({ entityType: 'capture', id: capture.id })).toEqual(capture);
  expect(f.repository.getHead({ entityType: 'manual_correction', id: correction.id })).toEqual(correction);
  expect(drafts.getPackage(draftPackageId)).toEqual(savedDraft);
  expect(drafts.history(draftId)).toEqual(savedHistory);
  expect(preferences.backup.exportSnapshot()).toEqual(savedPreferences);
  expect(preferences.editToken(f.context.installationId)).toBe(preferencesToken);
});

it('returns the durable result for a retried command without reapplying or reading Git', async () => {
  const f = fixture(), ctx = f.begin(), result = await f.run(ctx), before = f.repository.getStateRevision();
  f.deps.git.readMain = async () => { throw Error('Replay must not access network'); };
  expect(await f.run(ctx, commit)).toEqual(result);
  expect(f.repository.getStateRevision()).toBe(before);
  expect(f.repository.publicationAnchorMetadataRevision({ entityType: 'publication_anchor', id: packageId })).toBe(1);
});

it('retains the original accepted main proof when a later main still contains its unchanged capsule', async () => {
  const f = fixture(), first = await f.run();
  f.setMain({ ...f.main(), commit: 'c'.repeat(40) });
  const second = await f.run();
  expect(second.appliedCommit).toBe('c'.repeat(40));
  expect(second.anchors).toEqual(first.anchors);
  expect(f.repository.publicationAnchorMetadataRevision({ entityType: 'publication_anchor', id: packageId })).toBe(1);
});

it('allows an empty verified main without classification', async () => {
  const f = fixture(); f.setMain({ ...f.main(), files: new Map() }); delete f.deps.publication;
  expect(await f.run()).toMatchObject({ appliedCommit: commit, anchors: [], warnings: [] });
});

it.each(['requested_commit', 'main_moved', 'repository_changed', 'recheck_denied', 'artifact_failed', 'output_failed'])('retains prior state when %s fails', async fault => {
  const f = fixture();
  if (fault === 'main_moved') { let reads = 0; f.deps.git.readMain = async () => ++reads === 1 ? f.main() : { ...f.main(), commit: 'd'.repeat(40) }; }
  if (fault === 'repository_changed') { await f.run(); f.setMain({ ...f.main(), repositoryId: 'other-repository' }); }
  if (fault === 'recheck_denied') f.deps.recheck = async () => { throw Error('Access recheck failed'); };
  if (fault === 'artifact_failed') f.deps.artifacts.writeRevision = async () => { throw Error('Artifact staging failed'); };
  const requested = fault === 'requested_commit' ? 'e'.repeat(40) : f.main().commit;
  const ctx = f.begin(requested), before = f.repository.getStateRevision(), prior = readAppliedPublication(f.repository);
  await expect(f.run(ctx, requested, fault === 'output_failed' ? z.never() : resultSchema)).rejects.toThrow();
  expect(f.repository.getStateRevision()).toBe(before);
  expect(readAppliedPublication(f.repository)).toEqual(prior);
  expect(f.commands.get(ctx.installationId, ctx.commandId)?.receipt_json).toBeNull();
});

it('imports a later publication with historical revision gaps and retains the earlier immutable records', async () => {
  const f = fixture(); await f.run();
  const nextId = fixtureId(261100), assignment = { ...f.input.assignment, revision: 5, publicationAnchorId: nextId, officialDueOn: '2026-12-31' };
  const next = capsule([{ entityType: 'goal_assignment', value: assignment }], nextId);
  f.setMain({ ...f.main(), commit: 'c'.repeat(40), files: new Map([...f.main().files, ...next.tree]) });
  const result = await f.run();
  expect(result.anchors).toHaveLength(2);
  expect(f.repository.readPublishedHead({ entityType: 'goal_assignment', id: assignment.id })).toEqual(assignment);
  expect(f.repository.readVersion({ entityType: 'goal_assignment', id: assignment.id, revision: 1 })).toEqual({ ...f.input.assignment, publicationAnchorId: packageId });
});

it('rejects an immutable version collision without replacing local bytes or confirming its anchor', async () => {
  const f = fixture();
  const local = { ...f.input.metrics[0], name: 'Different local bytes', publicationAnchorId: null };
  f.repository.append('metric_definition', local, null);
  await expect(f.run()).rejects.toMatchObject({ code: 'REFERENCE_VERSION_COLLISION' });
  expect(f.repository.getHead({ entityType: 'metric_definition', id: local.id })).toEqual(local);
  expect(f.repository.readPublicationAnchor({ entityType: 'publication_anchor', id: packageId })).toBeNull();
});

it('never resolves an incoming reference from an unpublished local UUID', async () => {
  const f = fixture(), assignment = { ...f.input.assignment, publicationAnchorId: packageId };
  f.repository.append('metric_definition', { ...f.input.metrics[0], publicationAnchorId: null }, null);
  const entries = f.graph.entries.filter(entry => entry.entityType !== 'metric_definition');
  f.setMain({ ...f.main(), files: capsule(entries).tree });
  await expect(f.run()).rejects.toMatchObject({ code: 'REFERENCE_NOT_FOUND' });
  expect(f.repository.readPublishedHead({ entityType: 'goal_assignment', id: assignment.id })).toBeNull();
});

it('checks saved numeric proof and agreement bytes without recomputing them for the current clock', async () => {
  const f = fixture(), entries = proofEntries(f);
  f.setMain({ ...f.main(), files: capsule(entries).tree });
  await f.run();
  expect(f.repository.readVersion({ entityType: 'evaluation_basis', id: fixtureId(16), revision: 1 })).toEqual(entries.find(entry => entry.entityType === 'evaluation_basis')!.value);
  expect(f.repository.readPublishedHead({ entityType: 'agreed_snapshot', id: fixtureId(21) })).toEqual(entries.find(entry => entry.entityType === 'agreed_snapshot')!.value);
});

it.each(['basis', 'result', 'attestation', 'snapshot'])('rejects inconsistent saved %s proof atomically', async fault => {
  const f = fixture(), entries = proofEntries(f);
  if (fault === 'basis') Object.assign(entries.find(entry => entry.entityType === 'evaluation_basis')!.value, { digest: 'sha256:' + '0'.repeat(64) });
  if (fault === 'result') Object.assign(entries.find(entry => entry.entityType === 'calculation_result')!.value, { scorePercent: { numerator: '99', denominator: '1' } });
  if (fault === 'attestation') Object.assign(entries.find(entry => entry.entityType === 'attestation')!.value, { basisDigest: 'sha256:' + '0'.repeat(64) });
  if (fault === 'snapshot') Object.assign(entries.find(entry => entry.entityType === 'agreed_snapshot')!.value, { numericResult: { ...evaluateAssignment(f.input), scorePercent: { numerator: '99', denominator: '1' } } });
  f.setMain({ ...f.main(), files: capsule(entries).tree });
  await expect(f.run()).rejects.toThrow();
  expect(f.repository.readPublishedCatalog()).toEqual([]);
  expect(readAppliedPublication(f.repository)).toBeNull();
});

it('rejects a self-consistent basis whose method does not belong to its pinned assignment', async () => {
  const f = fixture(), entries = proofEntries(f);
  const unrelatedMethod = { ...f.input.method, id: fixtureId(261150), publicationAnchorId: packageId };
  const content = canonicalBasis({ ...f.input, method: unrelatedMethod });
  Object.assign(entries.find(entry => entry.entityType === 'evaluation_basis')!.value, content, { digest: digestBasis(content) });
  Object.assign(entries.find(entry => entry.entityType === 'attestation')!.value, { basisDigest: digestBasis(content) });
  entries.push({ entityType: 'method_version', value: unrelatedMethod });
  f.setMain({ ...f.main(), files: capsule(entries).tree });
  await expect(f.run()).rejects.toMatchObject({ code: 'BASIS_MISMATCH' });
  expect(readAppliedPublication(f.repository)).toBeNull();
});

it('refines only known proposal time metadata while retaining the first accepted main and package revision', async () => {
  const f = fixture(), first = await f.run();
  const link = { provider: 'bitbucket' as const, repositoryId: 'synthetic-main', id: 'known-own-pr', url: 'https://bitbucket.invalid/pr/known-own-pr' };
  f.setMain({ ...f.main(), commit: 'c'.repeat(40) });
  f.deps.knownProposal = id => { if (id !== packageId) throw Error('Wrong package'); return link; };
  f.deps.bitbucket = { ...createUnavailableBitbucketPort(), async readMergeEvidence(actual) { expect(actual).toEqual(link); return { mainCommit: commit, proposalCommit: 'd'.repeat(40), mergedAt: '2026-10-30T09:00:00Z', source: 'synthetic-merge-event', verified: true, repositoryId: 'synthetic-main', packageId, revision: 1, contentHash: f.original.manifest.packageRevision.contentHash, pullRequestId: link.id }; } };
  const second = await f.run();
  expect(second.anchors[0]).toMatchObject({ mainCommit: commit, revision: 1, contentHash: first.anchors[0].contentHash, timeVerification: 'verified', mergedAt: '2026-10-30T09:00:00Z', pullRequestId: link.id });
  expect(f.repository.publicationAnchorMetadataRevision({ entityType: 'publication_anchor', id: packageId })).toBe(2);
});

function configureEarlierMerge(f: ReturnType<typeof fixture>) {
  f.deps.knownProposal = () => ({ provider: 'bitbucket', repositoryId: 'synthetic-main', id: 'known-own-pr', url: 'https://bitbucket.invalid/pr/known-own-pr' });
  f.deps.bitbucket = { ...createUnavailableBitbucketPort(), async readMergeEvidence() { return { mainCommit: commit, proposalCommit: 'd'.repeat(40), mergedAt: '2026-10-30T09:00:00Z', source: 'synthetic-merge-event', verified: true, repositoryId: 'synthetic-main', packageId, revision: 1, contentHash: f.original.manifest.packageRevision.contentHash, pullRequestId: 'known-own-pr' }; } };
}

it('gives installations first observing merge B or descendant C the same verified real merge time', async () => {
  const atMerge = fixture(), atDescendant = fixture();
  atDescendant.setMain({ ...atDescendant.main(), commit: 'c'.repeat(40) });
  configureEarlierMerge(atMerge); configureEarlierMerge(atDescendant);
  Object.assign(atDescendant.deps.git, { async readAcceptedMainAt(oid: string) { if (oid !== commit) throw Error('Wrong requested merge'); return { ...atDescendant.main(), commit }; } });
  const a = await atMerge.run(), b = await atDescendant.run();
  expect(a.anchors[0]).toMatchObject({ mainCommit: commit, timeVerification: 'verified', mergedAt: '2026-10-30T09:00:00Z' });
  expect(b.anchors[0]).toMatchObject({ mainCommit: 'c'.repeat(40), timeVerification: 'verified', mergedAt: a.anchors[0].mergedAt });
});

it('can enrich a Git-only anchor first observed at descendant C using verified earlier merge B', async () => {
  const f = fixture(); f.setMain({ ...f.main(), commit: 'c'.repeat(40) });
  const first = await f.run(); configureEarlierMerge(f);
  Object.assign(f.deps.git, { async readAcceptedMainAt() { return { ...f.main(), commit }; } });
  const second = await f.run();
  expect(second.anchors[0]).toMatchObject({ mainCommit: first.anchors[0].mainCommit, timeVerification: 'verified', mergedAt: '2026-10-30T09:00:00Z' });
  expect(f.repository.publicationAnchorMetadataRevision({ entityType: 'publication_anchor', id: packageId })).toBe(2);
});

it.each(['missing_port', 'wrong_branch', 'wrong_bytes', 'wrong_oid', 'wrong_repository'])('keeps optional earlier merge time unknown with %s proof', async fault => {
  const f = fixture(); f.setMain({ ...f.main(), commit: 'c'.repeat(40) }); configureEarlierMerge(f);
  if (fault !== 'missing_port') Object.assign(f.deps.git, { async readAcceptedMainAt() {
    if (fault === 'wrong_branch') throw Error('Not an ancestor of accepted main');
    return { ...f.main(), commit: fault === 'wrong_oid' ? 'f'.repeat(40) : commit, repositoryId: fault === 'wrong_repository' ? 'other-repository' : f.main().repositoryId, files: fault === 'wrong_bytes' ? new Map() : f.main().files };
  } });
  const result = await f.run();
  expect(result.anchors[0]).toMatchObject({ publicationState: 'confirmed', timeVerification: 'unknown', mergedAt: null, mainCommit: 'c'.repeat(40) });
  expect(result.warnings).toContainEqual(expect.objectContaining({ code: 'MERGE_TIME_UNVERIFIED' }));
});

it.each(['unbound', 'wrong_hash', 'wrong_package', 'malformed_time', 'wrong_link_repository'])('does not reject verified Git main for %s optional merge metadata', async fault => {
  const f = fixture(); configureEarlierMerge(f);
  if (fault === 'wrong_link_repository') f.deps.knownProposal = () => ({ provider: 'bitbucket', repositoryId: 'other-repository', id: 'known-own-pr', url: 'https://bitbucket.invalid/pr/known-own-pr' });
  const read = f.deps.bitbucket!.readMergeEvidence;
  f.deps.bitbucket!.readMergeEvidence = async link => {
    const actual = await read(link);
    if (fault === 'unbound') return { mainCommit: actual.mainCommit, proposalCommit: actual.proposalCommit, mergedAt: actual.mergedAt, source: actual.source, verified: true };
    return { ...actual, ...(fault === 'wrong_hash' ? { contentHash: 'sha256:' + '0'.repeat(64) } : fault === 'wrong_package' ? { packageId: fixtureId(999) } : { mergedAt: 'not-a-time' }) };
  };
  const result = await f.run();
  expect(result.anchors[0]).toMatchObject({ publicationState: 'confirmed', timeVerification: 'unknown', mergedAt: null });
  expect(result.warnings).toContainEqual(expect.objectContaining({ code: 'MERGE_TIME_UNVERIFIED' }));
});

it('does not hide a failed access recheck after an optional ancestor read', async () => {
  const f = fixture(); f.setMain({ ...f.main(), commit: 'c'.repeat(40) }); configureEarlierMerge(f);
  let revoked = false;
  Object.assign(f.deps.git, { async readAcceptedMainAt() { revoked = true; return { ...f.main(), commit }; } });
  f.deps.recheck = async () => { if (revoked) throw Error('Revoked after ancestor verification'); };
  await expect(f.run()).rejects.toThrow('Revoked after ancestor verification');
  expect(readAppliedPublication(f.repository)).toBeNull();
});

it('does not access Bitbucket without a known proposal and keeps a failed optional read nonblocking', async () => {
  const f = fixture();
  f.deps.bitbucket = { ...createUnavailableBitbucketPort(), async readMergeEvidence() { throw Error('Optional provider unavailable'); } };
  const first = await f.run(); expect(first.warnings).toEqual([]);
  f.deps.knownProposal = () => ({ provider: 'bitbucket', repositoryId: 'synthetic-main', id: 'known-own', url: 'https://bitbucket.invalid/pr/known-own' });
  const second = await f.run();
  expect(second.anchors).toEqual(first.anchors);
  expect(second.warnings).toContainEqual(expect.objectContaining({ code: 'MERGE_TIME_UNAVAILABLE' }));
});

it.each(['demo', 'missing_classifier', 'rejected_classifier', 'missing_bytes', 'executable_mime'])('rejects evidence with %s classification or bytes', async fault => {
  const f = fixture(), bytes = Buffer.from('Synthetic proof'), hash = hashBytes(bytes);
  const evidence = { ...makeHeader(261120, { publicationAnchorId: packageId }), kind: 'file' as const, file: { artifactId: fixtureId(261121), hash: 'sha256:' + hash, bytes: bytes.length, mimeType: fault === 'executable_mime' ? 'application/x-msdownload' : 'text/plain' } };
  f.setMain({ ...f.main(), files: capsule([...f.graph.entries, { entityType: 'evidence', value: evidence }], packageId, 1, fault === 'missing_bytes' ? new Map() : new Map([['artifacts/' + hash, bytes]])).tree });
  f.deps.publication = { mode: fault === 'demo' ? 'demo-only' : 'internal', classifyRecord: () => true, ...(fault === 'missing_classifier' ? {} : { classifyEvidence: async () => fault !== 'rejected_classifier' }) };
  await expect(f.run()).rejects.toMatchObject({ code: fault === 'executable_mime' ? 'INTEGRITY_MISMATCH' : 'EVIDENCE_CLASSIFICATION_REQUIRED' });
  expect(readAppliedPublication(f.repository)).toBeNull();
});

it('stages the exact positively classified evidence bytes before committing its record', async () => {
  const f = fixture(), bytes = Buffer.from('Synthetic proof'), hash = hashBytes(bytes);
  const evidence = { ...makeHeader(261120, { publicationAnchorId: packageId }), kind: 'file' as const, file: { artifactId: fixtureId(261121), hash: 'sha256:' + hash, bytes: bytes.length, mimeType: 'text/plain' } };
  const incoming = capsule([...f.graph.entries, { entityType: 'evidence', value: evidence }], packageId, 1, new Map([['artifacts/' + hash, bytes]]));
  f.setMain({ ...f.main(), files: incoming.tree });
  f.deps.publication = { mode: 'internal', classifyRecord: () => true, async classifyEvidence(proof, actual) { return proof.file.hash === 'sha256:' + hash && Buffer.from(actual).equals(bytes); } };
  const owner = createEvidenceService({ repository: f.repository, store: createDraftStore({ repository: f.repository, artifactDirectory: path.join(f.root, 'owner-evidence') }), files: createFileStore({ directory: path.join(f.root, 'owner-uploads'), limits: defaultFileLimits }), clock: f.context.clock });
  Object.assign(f.deps, { evidence: owner });
  await f.run();
  expect(f.repository.readPublishedHead({ entityType: 'evidence', id: evidence.id })).toEqual(evidence);
  expect(Buffer.from((await f.deps.artifacts.readRevision(incoming.manifest.packageRevision)).get('artifacts/' + hash)!)).toEqual(bytes);
  const artifact = await owner.readArtifactForContext(f.context, evidence.file.artifactId), chunks: Buffer[] = [];
  for await (const chunk of artifact.stream) chunks.push(Buffer.from(chunk));
  expect(Buffer.concat(chunks)).toEqual(bytes);
});

it('requires the actual evidence owner port before publishing classified file evidence', async () => {
  const f = fixture(), bytes = Buffer.from('Synthetic owner proof'), hash = hashBytes(bytes);
  const evidence = { ...makeHeader(261120, { publicationAnchorId: packageId }), kind: 'file' as const, file: { artifactId: fixtureId(261121), hash: 'sha256:' + hash, bytes: bytes.length, mimeType: 'text/plain' } };
  f.setMain({ ...f.main(), files: capsule([...f.graph.entries, { entityType: 'evidence', value: evidence }], packageId, 1, new Map([['artifacts/' + hash, bytes]])).tree });
  f.deps.publication = { mode: 'internal', classifyRecord: () => true, async classifyEvidence() { return true; } };
  await expect(f.run()).rejects.toMatchObject({ code: 'EVIDENCE_STORE_UNAVAILABLE' });
  expect(readAppliedPublication(f.repository)).toBeNull();
});

it('commits evidence owner metadata inside the same rollback boundary as records, pointer and receipt', async () => {
  const f = fixture(), bytes = Buffer.from('Synthetic owner rollback'), hash = hashBytes(bytes);
  const evidence = { ...makeHeader(261120, { publicationAnchorId: packageId }), kind: 'file' as const, file: { artifactId: fixtureId(261121), hash: 'sha256:' + hash, bytes: bytes.length, mimeType: 'text/plain' } };
  f.setMain({ ...f.main(), files: capsule([...f.graph.entries, { entityType: 'evidence', value: evidence }], packageId, 1, new Map([['artifacts/' + hash, bytes]])).tree });
  f.deps.publication = { mode: 'internal', classifyRecord: () => true, async classifyEvidence() { return true; } };
  const artifactDirectory = path.join(f.root, 'owner-evidence');
  const owner = createEvidenceService({ repository: f.repository, store: createDraftStore({ repository: f.repository, artifactDirectory }), files: createFileStore({ directory: path.join(f.root, 'owner-uploads'), limits: defaultFileLimits }), clock: f.context.clock });
  Object.assign(f.deps, { evidence: owner });
  const ctx = f.begin(), before = f.repository.getStateRevision();
  await expect(f.run(ctx, commit, z.never())).rejects.toThrow();
  expect(readFileSync(path.join(artifactDirectory, evidence.file.artifactId))).toEqual(bytes);
  expect(f.repository.sqlForModule('evidence').all('SELECT * FROM wb_evidence_published_artifacts')).toEqual([]);
  expect(readAppliedPublication(f.repository)).toBeNull();
  expect(f.repository.readPublishedHead({ entityType: 'evidence', id: evidence.id })).toBeNull();
  expect(f.repository.readPublicationAnchor({ entityType: 'publication_anchor', id: packageId })).toBeNull();
  expect(f.repository.getStateRevision()).toBe(before);
  expect(f.commands.get(ctx.installationId, ctx.commandId)?.receipt_json).toBeNull();
  await expect(owner.readArtifactForContext(f.context, evidence.file.artifactId)).rejects.toMatchObject({ code: 'ARTIFACT_NOT_FOUND' });
});

it('rejects classified-private payloads even in an older abandoned capsule', async () => {
  const f = fixture(), abandoned = capsule([{ entityType: 'metric_definition', value: { ...f.input.metrics[0], publicationAnchorId: packageId, name: 'Private proposal bytes' } }]), latest = capsule(f.graph.entries, packageId, 2);
  f.setMain({ ...f.main(), files: new Map([...abandoned.tree, ...latest.tree]) });
  f.deps.publication!.classifyRecord = (_type, value) => !('name' in value && value.name === 'Private proposal bytes');
  await expect(f.run()).rejects.toMatchObject({ code: 'CLASSIFICATION_REQUIRED' });
  expect(readAppliedPublication(f.repository)).toBeNull();
});
