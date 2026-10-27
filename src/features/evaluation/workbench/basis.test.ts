import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { CalculationResult, EvaluationBasis, GoalAssignment, MethodVersion } from '../../../domain/workbench/entities';
import { createWorkbenchRepository } from '../../../server/storage/workbench-repository';
import type { WorkbenchRepository } from '../../../server/storage/workbench-repository';
import { fixtureId, makeEntityGraph, makeHeader, makeNumericFixture, makePublicationAnchor, versionRef } from '../../../../tests/fixtures/workbench/factories';
import { seedGraph } from '../../../../tests/fixtures/workbench/repository';
import { canonicalBasis, digestBasis } from './basis';
import { prepareEvaluation } from './prepare-evaluation';
import { resolveEvaluationInput } from './resolve-input';
import { projectEvaluationQuality } from './quality';
import { validateAttestation } from './state-rules';

const cleanups: Array<() => void> = [];
function setup(graph = makeEntityGraph()) {
  const root = mkdtempSync(path.join(tmpdir(), 'uor-basis-')); const filename = path.join(root, 'state.sqlite');
  const r = createWorkbenchRepository({ filename, artifactRoot: path.join(root, 'artifacts') }); seedGraph(r, graph);
  cleanups.push(() => { r.close(); if (!path.basename(root).startsWith('uor-basis-')) throw new Error('Unexpected test root'); rmSync(root, { recursive: true, force: true }); });
  const counts = () => { const db = new DatabaseSync(filename, { readOnly: true }); try { return db.prepare('SELECT entity_type,COUNT(*) AS n FROM wb_entity_versions GROUP BY entity_type ORDER BY entity_type').all(); } finally { db.close(); } };
  return { r, graph, counts };
}
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });
const request = (i: ReturnType<typeof makeNumericFixture>) => ({ assignmentRef: { entityType: 'goal_assignment', id: i.assignment.id, revision: i.assignment.revision }, businessTime: i.context.businessTime });

describe('immutable evaluation bases', () => {
  it('canonicalizes_semantics_and_reuses_materialized_refs', () => {
    const { r, graph, counts } = setup(); const input = graph.input;
    const actor = { hostname: 'demo-reader', installationId: fixtureId(2), profilePersonId: null };
    let clockCalls = 0; const clock = { now: () => { clockCalls++; return input.context.evaluatedAt; } };
    const resolved = resolveEvaluationInput(request(input), r, clock, actor); expect(clockCalls).toBe(1);
    const before = counts(); const first = prepareEvaluation(resolved, r); const state = r.getStateRevision();
    expect(prepareEvaluation({ ...resolved, resolution: { ...resolved.resolution, actor: input.goal.actor } }, r)).toEqual(first);
    expect(r.getStateRevision()).toBe(state);
    expect(r.readVersion<EvaluationBasis>(first.basisRef)?.actor).toEqual(actor);
    expect(r.readVersion<CalculationResult>(first.resultRef!)?.actor).toEqual(actor);
    expect(counts().filter(row => !['evaluation_basis', 'calculation_result'].includes(String(row.entity_type)))).toEqual(before);
    const content = canonicalBasis(resolved); const digest = digestBasis(content);
    expect(digestBasis({ ...content, factRefs: [...content.factRefs].reverse(), expectedPopulation: [...content.expectedPopulation!].reverse() })).toBe(digest);
    expect(digestBasis({ ...content, methodRef: { ...content.methodRef, revision: 2 } })).not.toBe(digest);
    expect(digestBasis({ ...content, factRefs: content.factRefs.map(ref => ({ ...ref, revision: 2 })) })).not.toBe(digest);
    expect(digestBasis({ ...content, expectedPopulation: [{ kind: 'product', id: fixtureId(999) }] })).not.toBe(digest);
  });

  it('rolls back the basis, result and digest index on a failed append projection', () => {
    const { r, graph, counts } = setup(); const before = counts(); const state = r.getStateRevision();
    r.registerProjection('fail-result', type => { if (type === 'calculation_result') throw new Error('failure'); });
    expect(() => prepareEvaluation(graph.input, r)).toThrow('failure');
    expect(r.findEvaluationByDigest(digestBasis(canonicalBasis(graph.input)))).toBeNull();
    expect(counts()).toEqual(before); expect(r.getStateRevision()).toBe(state);
  });

  it('resolves_template_and_standalone_without_retroactivity', () => {
    const i = makeNumericFixture(); i.assignment.methodBinding = { kind: 'template', templateId: fixtureId(60) };
    i.facts[0].lineage.directoryLinkRefs = [versionRef('directory_link', 80)];
    const graph = makeEntityGraph(i);
    const link = { ...makeHeader(80, { publicationAnchorId: i.goal.publicationAnchorId }), kind: 'leader' as const, scope: i.assignment.scope, personId: i.goal.primaryCuratorPersonId };
    graph.entries.push({ entityType: 'directory_link', value: link });
    const { r } = setup(graph); const actor = i.goal.actor; const clock = { now: () => i.context.evaluatedAt };
    const first = resolveEvaluationInput(request(i), r, clock, actor); const saved = prepareEvaluation(first, r);
    expect(first.resolution.templateRef).toEqual(versionRef('template', 60));
    expect(first.resolution.directoryLinkRefs).toEqual([versionRef('directory_link', 80)]);
    r.append('directory_link', { ...link, revision: 2 }, 1);
    const unknown = makePublicationAnchor({ id: fixtureId(70), packageId: fixtureId(71), timeVerification: 'unknown', mergedAt: null });
    r.transaction(() => { r.appendPublicationAnchor(unknown, null); r.append('method_version', { ...i.method, revision: 2, publicationAnchorId: unknown.id }, 1); r.append('template', { ...makeHeader(60, { revision: 2, publicationAnchorId: unknown.id }), name: 'demo_template_v2', methodRef: versionRef('method_version', 14, 2) }, 1); });
    const second = resolveEvaluationInput(request(i), r, clock, actor); expect(second.method.revision).toBe(2); expect(second.resolution.templateRef?.revision).toBe(2);
    const pending = makePublicationAnchor({ id: fixtureId(72), packageId: fixtureId(73), publicationState: 'unconfirmed', timeVerification: 'unknown', mergedAt: null, mainCommit: null, verifiedAt: null });
    r.appendPublicationAnchor(pending, null); r.append('template', { ...makeHeader(60, { revision: 3, publicationAnchorId: pending.id }), name: 'pending', methodRef: versionRef('method_version', 14) }, 2);
    expect(resolveEvaluationInput(request(i), r, clock, actor).method.revision).toBe(2);
    expect(r.readVersion<EvaluationBasis>(saved.basisRef)?.methodRef.revision).toBe(1);
    expect(r.readVersion<EvaluationBasis>(saved.basisRef)?.directoryLinkRefs).toEqual([versionRef('directory_link', 80)]);
    r.append('goal_assignment', { ...i.assignment, revision: 2, methodBinding: { kind: 'standalone', methodRef: versionRef('method_version', 14) } }, 1);
    const standalone: GoalAssignment = { ...i.assignment, revision: 2 };
    expect(resolveEvaluationInput({ ...request(i), assignmentRef: { entityType: 'goal_assignment', id: standalone.id, revision: 2 } }, r, clock, actor).method.revision).toBe(1);
    const broken: WorkbenchRepository = { ...r, readVersion<T extends import('../../../domain/workbench/primitives').Header>(ref: import('../../../domain/workbench/primitives').VersionRef): T | null { return ref.entityType === 'method_version' ? null : r.readVersion<T>(ref); } };
    expect(() => resolveEvaluationInput(request(i), broken, clock, actor)).toThrowError(expect.objectContaining({ code: 'BROKEN_REFERENCE' }));
  });

  it('reuses_basis_while_projecting_current_quality', () => {
    const { r, graph } = setup(); const first = prepareEvaluation(graph.input, r);
    const stored = r.readVersion<CalculationResult>(first.resultRef!)!; const frozen = JSON.stringify(stored);
    const { schemaVersion, id, revision, recordedAt, actor, publicationAnchorId, ...numericResult } = stored;
    const agreedRef = r.append('agreed_snapshot', { ...makeHeader(777), basisRef: first.basisRef, numericResult, manualStatusRef: null, attestationRef: null }, null);
    const frozenAgreed = JSON.stringify(r.readVersion(agreedRef)); const state = r.getStateRevision();
    const later = { ...graph.input, context: { ...graph.input.context, evaluatedAt: '2026-10-31T12:00:00Z' } };
    expect(prepareEvaluation(later, r)).toEqual(first); expect(r.getStateRevision()).toBe(state);
    const projected = projectEvaluationQuality(stored, later);
    expect(projected).toMatchObject({ scorePercent: stored.scorePercent, basisRef: stored.basisRef, freshness: 'stale', canConfirm: false });
    expect(JSON.stringify(stored)).toBe(frozen); expect(JSON.stringify(r.readVersion(first.resultRef!))).toBe(frozen);
    expect(JSON.stringify(r.readVersion(agreedRef))).toBe(frozenAgreed);
    const basis = r.readVersion<EvaluationBasis>(first.basisRef)!;
    expect(() => validateAttestation({ basis, result: projected, attestation: { ...makeHeader(900), basisDigest: basis.digest, comment: 'Done', evidenceIds: [] } })).toThrowError(expect.objectContaining({ code: 'CONFIRMATION_NOT_ALLOWED' }));
  });

  it('prepares manual goals without a numeric result', () => {
    const { r, graph } = setup(); const i = graph.input;
    const manualMethod: MethodVersion = { ...makeHeader(14, { revision: 2, publicationAnchorId: i.goal.publicationAnchorId }), mode: 'manual_status' };
    r.transaction(() => {
      r.append('core_goal_definition', { ...i.goal, revision: 2, mode: 'manual_status' }, 1);
      r.append('source_definition', { ...makeHeader(12, { revision: 2, publicationAnchorId: i.goal.publicationAnchorId }), goalId: i.goal.id, kind: 'manual_status', mappingRef: null, publicLocator: null }, 1);
      r.append('method_version', manualMethod, 1);
      r.append('goal_assignment', { ...i.assignment, revision: 2, expectedPopulation: null, methodBinding: { kind: 'standalone', methodRef: versionRef('method_version', 14, 2) } }, 1);
    });
    const resolved = resolveEvaluationInput({ ...request(i), assignmentRef: versionRef('goal_assignment', 15, 2) }, r, { now: () => i.context.evaluatedAt }, i.goal.actor);
    expect(prepareEvaluation(resolved, r).resultRef).toBeNull();
  });
});
