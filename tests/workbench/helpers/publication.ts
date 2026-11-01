import { createHash } from 'node:crypto';
import path from 'node:path';
import type { AgreedSnapshot, EvaluationBasis, SourceFieldMapping } from '../../../src/domain/workbench/entities';
import type { GlobalContext, JobSnapshot } from '../../../src/server/workbench/protocol';
import { WorkbenchHttpError } from '../../../src/server/workbench/protocol';
import { createAccessPolicyService } from '../../../src/features/identity/workbench-access-policy';
import { createFakeBitbucket } from '../../../src/features/publishing/workbench/fake-bitbucket';
import { buildPackageManifest, canonicalBytes } from '../../../src/features/publishing/workbench/package-manifest';
import { verifyPublicationAnchor } from '../../../src/features/publishing/workbench/publication-anchor';
import { readMainProjection } from '../../../src/features/publishing/workbench/package-projection';
import type { PreparedProposal, PublicationGitPort } from '../../../src/features/publishing/workbench/git-port';
import type { TerminalRunner } from '../../../src/features/publishing/workbench/terminal-runner';
import type { VerifiedMain } from '../../../src/features/publishing/workbench/contracts';
import type { SourceAdapter } from '../../../src/features/connectors/workbench-source-contracts';
import { sourcePayloadHash } from '../../../src/features/connectors/workbench-source-contracts';
import { canonicalBasis, digestBasis } from '../../../src/features/evaluation/workbench/basis';
import { evaluateAssignment } from '../../../src/features/evaluation/workbench/evaluate';
import { fixtureId, makeEntityGraph, makeHeader, makeNumericFixture } from '../../fixtures/workbench/factories';
import { seedGraph } from '../../fixtures/workbench/repository';
import { syntheticCapabilities } from '../../fixtures/workbench/proposals';
import { createLocalRuntime } from './runtime';

type Local = Awaited<ReturnType<typeof createLocalRuntime>>;
export const rawPublicationRows = [{ rowKey: '["source-row-1"]', cells: { RowId: { kind: 'text' as const, original: 'source-row-1' }, ProductAlias: { kind: 'text' as const, original: 'ALIAS-A' }, Amount: { kind: 'text' as const, original: '96.5' }, Date: { kind: 'text' as const, original: '2026-10-23' } } }];

/** Only the outside world is synthetic: no HTTP command/query, receipt, store or normalizer is replaced. */
export async function createPublicationScenario() {
  const input = makeNumericFixture({ scope: { kind: 'dit', id: fixtureId(100) }, expectedPopulation: [{ kind: 'product', id: fixtureId(101) }], values: ['92'], targets: ['90'] });
  // The assignment is product-scoped so the saved 92 and fresh 96.5 have identical selector grain.
  input.assignment.scope = { kind: 'product', id: fixtureId(101) };
  input.facts[0].scope = input.assignment.scope;
  const graph = makeEntityGraph(input), anchorId = input.goal.publicationAnchorId!;
  const header = (id: number) => makeHeader(id, { publicationAnchorId: anchorId });
  graph.entries.push({ entityType: 'directory_entity', value: { ...header(100), kind: 'dit', name: 'Synthetic DIT', externalKeys: [] } });
  graph.entries.push({ entityType: 'directory_entity', value: { ...header(103), kind: 'cluster', name: 'Synthetic cluster', externalKeys: [] } });
  for (const entry of graph.entries) if (entry.entityType === 'directory_entity' && entry.value.id === fixtureId(101)) Object.assign(entry.value, { name: 'Published product A', externalKeys: [{ sourceId: input.goal.sourceId, key: 'ALIAS-A' }] });
  graph.entries.push({ entityType: 'directory_link', value: { ...header(104), kind: 'dit_cluster', from: { entityType: 'directory_entity', id: fixtureId(100) }, to: { entityType: 'directory_entity', id: fixtureId(103) } } });
  graph.entries.push({ entityType: 'directory_link', value: { ...header(105), kind: 'cluster_product', from: { entityType: 'directory_entity', id: fixtureId(103) }, to: { entityType: 'directory_entity', id: fixtureId(101) } } });
  for (const [id, kind, scopeId] of [[106, 'cluster', 103], [107, 'product', 101]] as const) graph.entries.push({ entityType: 'directory_link', value: { ...header(id), kind: 'leader', scope: { kind, id: fixtureId(scopeId) }, personId: input.goal.primaryCuratorPersonId } });
  const mapping = graph.entries.find(entry => entry.entityType === 'source_field_mapping')!.value as SourceFieldMapping;
  Object.assign(mapping, { rowKeyFields: ['RowId'], dimensionFields: { productAlias: 'ProductAlias' }, productKeyField: 'ProductAlias', metricFields: [{ metricId: input.metrics[0].id, fields: { demo_value: 'Amount' } }], dateField: 'Date' });
  input.resolution.directoryLinkRefs = [104, 105, 106, 107].map(id => ({ entityType: 'directory_link', id: fixtureId(id), revision: 1 }));
  const content = canonicalBasis(input);
  const basis: EvaluationBasis = { ...header(16), ...content, evaluatedAt: input.context.evaluatedAt, digest: digestBasis(content) };
  const numericResult = evaluateAssignment(input);
  const snapshot: AgreedSnapshot = { ...header(602), basisRef: input.resolution.basisRef, numericResult, manualStatusRef: null, attestationRef: null };
  graph.entries.push({ entityType: 'evaluation_basis', value: basis }, { entityType: 'calculation_result', value: { ...header(18), ...numericResult } }, { entityType: 'agreed_snapshot', value: snapshot });
  const initialFiles = new Map(graph.entries.map(({ entityType, value }) => [`records/${entityType}/${value.id}/${value.revision}.json`, canonicalBytes(value)]));
  const initialManifest = buildPackageManifest({ package: { schemaVersion: 1, packageId: anchorId, cycleId: fixtureId(603), curatorPersonId: input.goal.primaryCuratorPersonId, revision: 1, baseCommit: '0'.repeat(40), targetBranch: 'main', createdAt: input.context.evaluatedAt }, files: initialFiles });
  const initialPrefix = `published/workbench/packages/${anchorId}/1/`;
  let main: VerifiedMain = { repositoryId: 'synthetic-main', commit: 'a'.repeat(40), files: new Map([...initialFiles].map(([name, bytes]) => [initialPrefix + name, bytes])) };
  (main.files as Map<string, Uint8Array>).set(initialPrefix + 'manifest.json', canonicalBytes(initialManifest));
  readMainProjection(main);
  graph.anchors = [verifyPublicationAnchor({ main, manifest: initialManifest, evidence: null, verifiedAt: input.context.evaluatedAt })];
  const prepared = new Map<string, { proposal: PreparedProposal; files: ReadonlyMap<string, Uint8Array> }>(), remote = new Map<string, string>();
  const bitbucket = createFakeBitbucket({ capabilities: { ...syntheticCapabilities, mergeEvidence: 'unsupported' } });
  const createProposal = bitbucket.createProposal;
  let gitAuthorized = false, restAuthorized = false, revoked = false, gitReads = 0, pushes = 0, authOpens = 0, restAuthOpens = 0;
  let terminalMode: 'normal' | 'network' | 'revoke' = 'normal';
  let transferRecheckFinished!: () => void;
  const revokedTransfer = new Promise<void>(resolve => { transferRecheckFinished = resolve; });
  let curatorNow = '2026-10-23T12:00:00Z', readerNow = '2026-10-23T13:00:00Z';
  const git: PublicationGitPort = {
    async readMain() { gitReads++; return { ...main, files: new Map(main.files) }; },
    async inspectRemote(branch) { return remote.get(branch) ?? null; },
    async prepare({ manifest, files, expectedRemoteHead }) {
      const key = manifest.packageRevision.contentHash, prior = prepared.get(key); if (prior) return prior.proposal;
      const revision = manifest.packageRevision, prefix = `published/workbench/packages/${revision.packageId}/${revision.revision}/`;
      const tree = new Map<string, Uint8Array>([...files].map(([name, bytes]) => [prefix + name, new Uint8Array(bytes)])); tree.set(prefix + 'manifest.json', canonicalBytes(manifest));
      const proposal: PreparedProposal = { packageRevision: revision, branch: `uor/${revision.curatorPersonId}/${revision.packageId}`, checkout: path.join(curator.root, '.runtime/synthetic-external-checkout'), commit: createHash('sha1').update(key).digest('hex'), expectedRemoteHead };
      prepared.set(key, { proposal, files: tree }); return proposal;
    },
    async verifyPrepared(value) { if ((remote.get(value.branch) ?? null) !== value.expectedRemoteHead) throw new WorkbenchHttpError(409, 'PREVIEW_STALE', 'Synthetic branch changed'); },
  };
  const terminal: TerminalRunner = {
    async openAuth() { authOpens++; gitAuthorized = true; },
    async runGitPush(request) {
      if (!gitAuthorized) return { status: 'auth_required', provider: 'git' };
      if (terminalMode === 'network') { terminalMode = 'normal'; return { status: 'unknown', exitCode: null, reason: 'SYNTHETIC_NETWORK_DOWN' }; }
      if (terminalMode === 'revoke') {
        revoked = true;
        try { await request.preTransferGate(); }
        catch (error) { if ((error as { code?: string }).code === 'ACCESS_DENIED') throw new WorkbenchHttpError(403, 'ACCESS_DENIED', 'Synthetic terminal observed rejected transfer gate'); throw error; }
        finally { transferRecheckFinished(); }
      } else await request.preTransferGate();
      const value = [...prepared.values()].find(value => value.proposal.commit === request.preparedCommit)!.proposal;
      pushes++; remote.set(value.branch, value.commit); return { status: 'confirmed', exitCode: 0, remoteCommit: value.commit };
    },
  };
  bitbucket.createProposal = async value => { if (!restAuthorized) throw new WorkbenchHttpError(409, 'PR_AUTH_REQUIRED', 'Synthetic separate REST login'); return createProposal(value); };
  bitbucket.openAuth = async () => { restAuthOpens++; restAuthorized = true; };
  let readerRestCalls = 0;
  const readerBitbucket = { ...bitbucket, async capabilities(): Promise<never> { readerRestCalls++; throw Error('Reader must never require REST'); }, async readMergeEvidence(): Promise<never> { readerRestCalls++; throw Error('Reader must never require REST merge time'); } };
  const policy = (role: 'curator' | 'viewer') => ({ installationId, capabilityFor, clock }: Parameters<NonNullable<import('../../../src/server/workbench/runtime-contracts').WorkbenchRuntimeProviders['accessPolicy']>>[0]) => {
    let cached: any = null;
    return createAccessPolicyService({ installationId, capabilityFor, clock, hostname: () => `synthetic-${role}`, mainRepositoryId: 'synthetic-main', serviceRepositoryId: 'synthetic-registry', cache: { read: () => cached, write: value => { cached = value; }, invalidate: () => { cached = null; } }, registry: { async readAccepted() { return { commit: 'synthetic-registry-1', value: { schemaVersion: 1, profiles: [{ hostname: `synthetic-${role}`, displayName: `Synthetic ${role}`, personId: input.goal.primaryCuratorPersonId, role, enabled: !revoked || role === 'viewer' }], serviceSettings: {} } }; } } });
  };
  const source: SourceAdapter = { async check() { return { status: 'ready', issues: [] }; }, async collect(request) { return { operationId: request.operationId, sourceRef: request.sourceRef, mappingRef: request.mappingRef, capturedAt: curatorNow, sourceUpdatedAt: curatorNow, rawRows: structuredClone(rawPublicationRows), artifact: null, payloadHash: sourcePayloadHash(rawPublicationRows), coverage: { complete: true, expectedRows: 1, receivedRows: 1, evidence: ['Synthetic full source export'] }, issues: [] }; } };
  const shared = { git, classification: { mode: 'demo-only' as const, classifyRecord: () => true } };
  const curator = await createLocalRuntime({ ...shared, hostname: () => 'synthetic-curator', clock: { now: () => curatorNow }, accessPolicy: policy('curator'), bitbucket, terminal, sourceAdapters: new Map([['qlik', source]]) });
  let reader: Local;
  try { reader = await createLocalRuntime({ ...shared, hostname: () => 'synthetic-reader', clock: { now: () => readerNow }, accessPolicy: policy('viewer'), bitbucket: readerBitbucket }); } catch (error) { await curator.close(); throw error; }
  try { seedGraph(curator.runtime.deps.repository, graph); seedGraph(reader.runtime.deps.repository, graph); } catch (error) { await Promise.all([curator.close(), reader.close()]); throw error; }
  const context: GlobalContext = { scopePath: { ditId: fixtureId(100), clusterId: fixtureId(103), productId: fixtureId(101), teamId: null }, goalId: input.goal.id, time: input.context.businessTime as GlobalContext['time'], resultMode: 'current', snapshotId: null };
  const agreedContext = { ...context, resultMode: 'agreed' as const, snapshotId: snapshot.id };
  async function settled(local: Local, name: string, payload: Record<string, unknown>, token: string | null = null) { return local.request.settle(await local.request.command(name, payload, token)); }
  async function waitJob(local: Local, id: string, statuses: JobSnapshot['status'][] = ['succeeded','failed','waiting_user','retry_wait','cancelled']) {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) { const job = await local.request.job(id); if (statuses.includes(job.status)) return job; await new Promise(resolve => setTimeout(resolve, 20)); }
    throw Error('HTTP job wait timed out: ' + id);
  }
  return { curator, reader, input, snapshot, context, agreedContext, rawRows: rawPublicationRows, prepared, bitbucket, settled, waitJob,
    counts: () => ({ prepares: prepared.size, pushes, authOpens, restAuthOpens, creates: bitbucket.testing.creates, updates: bitbucket.testing.updates, readerRestCalls, gitReads }),
    now(curatorValue: string, readerValue = readerNow) { curatorNow = curatorValue; readerNow = readerValue; },
    mode(value: typeof terminalMode) { terminalMode = value; }, revokedTransfer, restorePolicy() { revoked = false; }, authorize() { gitAuthorized = true; restAuthorized = true; },
    main: () => main,
    async mergeExternal(proposal: import('../../../src/features/publishing/workbench/bitbucket-port').ProposalLink) {
      const value = await bitbucket.readProposal(proposal), candidate = [...prepared.values()].find(item => item.proposal.commit === value.sourceCommit);
      if (!candidate || remote.get(candidate.proposal.branch) !== candidate.proposal.commit) throw Error('Synthetic merge requires an externally pushed proposal');
      bitbucket.testing.setState(proposal, 'merged'); main = { ...main, commit: 'e'.repeat(40), files: new Map([...main.files, ...candidate.files]) };
    },
    async close() { await Promise.all([curator.close(), reader.close()]); },
  };
}
