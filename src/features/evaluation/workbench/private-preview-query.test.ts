import { afterEach, expect, it } from 'vitest';
import { draftFixture, draftCleanups, business } from '../../../../tests/fixtures/workbench/drafts';
import { fixtureId } from '../../../../tests/fixtures/workbench/factories';
import { QueryRegistry } from '../../../server/workbench/query-registry';
import { registerPrivateCalculationPreviewQuery } from './private-preview-query';
import type { VersionRef } from '../../../domain/workbench/primitives';
afterEach(async () => {
    for (const close of draftCleanups.splice(0))
        await close();
});
async function fixture() {
    const f = draftFixture();
    const opened = await f.open('goal_assignment', { entityType: 'goal_assignment', id: f.input.assignment.id });
    const saved = await f.execute('assignment.draft.save', { draftId: opened.draftId, definition: business(f.input.assignment) });
    const assignmentRef = (saved.result as {
        versionRef: VersionRef;
    }).versionRef;
    const prepared = (await f.execute('calculation.prepare', { assignmentRef, businessTime: f.input.context.businessTime })).result as {
        basisRef: VersionRef;
        resultRef: VersionRef;
    };
    const registry = new QueryRegistry();
    registerPrivateCalculationPreviewQuery(registry, f.service);
    const filter = { packageId: f.packageId(), resultRef: prepared.resultRef, editToken: f.token()! };
    const query = (patch: Record<string, unknown> = {}, context = f.context) => registry.execute('calculation.preview', { context: null, filter: { ...filter, ...patch }, sort: [], page: { limit: 50, cursor: null } }, context);
    return { ...f, opened, assignmentRef, prepared, filter, query };
}
it('reads_exact_private_numeric_example_without_writes_or_recalculation', async () => { const f = await fixture(); const before = f.repository.getStateRevision(); const result = await f.query() as any; expect(result.basis.id).toBe(f.prepared.basisRef.id); expect(result.result.id).toBe(f.prepared.resultRef.id); expect(result.assignment.revision).toBe(f.assignmentRef.revision); expect(result.goal.title).toBe(f.input.goal.title); expect(result.result.scorePercent).toEqual({ numerator: '920', denominator: '9' }); expect(f.repository.getStateRevision()).toBe(before); expect(f.count('observed_fact')).toBe(0); expect(f.count('attestation')).toBe(0); });
it.each(['viewer', 'foreign-person', 'foreign-installation', 'wrong-package', 'unknown-result', 'wrong-revision', 'wrong-type'])('rejects private preview %s', async (kind) => {
    const f = await fixture();
    let ctx = f.context;
    let patch: Record<string, unknown> = {};
    if (kind === 'viewer')
        ctx = { ...ctx, ownAccess: { ...ctx.ownAccess, role: 'viewer', personId: null } };
    if (kind === 'foreign-person')
        ctx = { ...ctx, ownAccess: { ...ctx.ownAccess, personId: fixtureId(99001) } };
    if (kind === 'foreign-installation')
        ctx = { ...ctx, installationId: fixtureId(99002) };
    if (kind === 'wrong-package') {
        const id = fixtureId(99003);
        f.store.createPackage({ packageId: id, installationId: ctx.installationId, ownerPersonId: ctx.ownAccess.personId!, baseCommit: null });
        patch = { packageId: id, editToken: 'draft:' + id + ':0' };
    }
    if (kind === 'unknown-result')
        patch = { resultRef: { ...f.prepared.resultRef, id: fixtureId(99004) } };
    if (kind === 'wrong-revision')
        patch = { resultRef: { ...f.prepared.resultRef, revision: 2 } };
    if (kind === 'wrong-type')
        patch = { resultRef: f.prepared.basisRef };
    await expect(f.query(patch, ctx)).rejects.toMatchObject({ statusCode: kind === 'viewer' ? 403 : kind === 'wrong-type' ? 422 : 404 });
});
it('rejects_stale_package_token_after_method_or_assignment_edit', async () => { const f = await fixture(); await f.execute('assignment.draft.save', { draftId: f.opened.draftId, definition: { ...business(f.input.assignment), officialDueOn: '2026-12-01' } }); await expect(f.query()).rejects.toMatchObject({ statusCode: 409, code: 'PREVIEW_STALE' }); });
it('method_read_resolves_exact_template_for_partial_assignment_without_calculation', async () => {
    const f = draftFixture();
    const { mode, rules, formula, ...header } = f.input.method as any;
    const templateId = fixtureId(99901);
    f.repository.append('template', { ...header, id: templateId, name: 'Шаблон', methodRef: { entityType: 'method_version', id: f.input.method.id, revision: f.input.method.revision } }, null);
    const opened = await f.open('goal_assignment');
    const saved = await f.execute('assignment.draft.save', { draftId: opened.draftId, definition: { goalId: f.input.goal.id, methodBinding: { kind: 'template', templateId } } });
    const assignmentRef = (saved.result as any).versionRef;
    const registry = new QueryRegistry();
    registerPrivateCalculationPreviewQuery(registry, f.service);
    const before = f.repository.getStateRevision();
    const result = await registry.execute('calculation.method', { context: null, filter: { packageId: f.packageId(), assignmentRef, editToken: f.token()! }, sort: [], page: { limit: 50, cursor: null } }, f.context) as any;
    expect(result.method.id).toBe(f.input.method.id);
    expect(result.metrics[0].id).toBe(f.input.metrics[0].id);
    expect(result.goalRef.id).toBe(f.input.goal.id);
    expect(f.repository.getStateRevision()).toBe(before);
    expect(f.count('evaluation_basis')).toBe(0);
});
it.each(['foreign', 'viewer', 'stale', 'wrong-assignment', 'unsupported-binding'])('method_read_rejects_%s', async (kind) => {
    const f = draftFixture();
    const opened = await f.open('goal_assignment', { entityType: 'goal_assignment', id: f.input.assignment.id });
    const entry = f.store.getEntry(opened.draftId)!;
    let ctx = f.context;
    let token = f.token()!;
    let assignmentRef = entry.versionRef;
    if (kind === 'foreign')
        ctx = { ...ctx, ownAccess: { ...ctx.ownAccess, personId: fixtureId(99904) } };
    if (kind === 'viewer')
        ctx = { ...ctx, ownAccess: { ...ctx.ownAccess, role: 'viewer', personId: null } };
    if (kind === 'stale')
        token = 'old';
    if (kind === 'wrong-assignment')
        assignmentRef = { ...assignmentRef, id: fixtureId(99905) };
    if (kind === 'unsupported-binding') {
        token = f.store.save(entry.draftId, { ...entry.definition, methodBinding: { kind: 'unsupported' } }, false, [], ctx.actor, ctx.clock.now());
        assignmentRef = f.store.getEntry(entry.draftId)!.versionRef;
    }
    const registry = new QueryRegistry();
    registerPrivateCalculationPreviewQuery(registry, f.service);
    await expect(registry.execute('calculation.method', { context: null, filter: { packageId: f.packageId(), assignmentRef, editToken: token }, sort: [], page: { limit: 50, cursor: null } }, ctx)).rejects.toMatchObject({ statusCode: kind === 'viewer' ? 403 : kind === 'stale' ? 409 : kind === 'unsupported-binding' ? 422 : 404 });
});
it('standalone_reference_comes_only_from_this_assignment_saved_history_not_unrelated_method', async () => {
    const f = draftFixture();
    const unrelated = await f.open('method_version');
    const assignment = await f.open('goal_assignment');
    await f.execute('assignment.draft.save', { draftId: assignment.draftId, definition: { goalId: f.input.goal.id, methodBinding: { kind: 'template', templateId: fixtureId(99551) } } });
    const registry = new QueryRegistry();
    registerPrivateCalculationPreviewQuery(registry, f.service);
    const filter = { packageId: f.packageId(), assignmentRef: f.store.getEntry(assignment.draftId)!.versionRef, editToken: f.token()!, referenceOnly: true };
    const before = await registry.execute('calculation.method', { context: null, filter, sort: [], page: { limit: 50, cursor: null } }, f.context) as any;
    expect(before.standaloneMethodRef).toBeNull();
    await f.execute('assignment.draft.save', { draftId: assignment.draftId, definition: { goalId: f.input.goal.id, methodBinding: { kind: 'standalone', methodRef: { entityType: 'method_version', id: f.input.method.id, revision: 1 } } } });
    await f.execute('assignment.draft.save', { draftId: assignment.draftId, definition: { goalId: f.input.goal.id, methodBinding: { kind: 'template' } } });
    const after = await registry.execute('calculation.method', { context: null, filter: { ...filter, assignmentRef: f.store.getEntry(assignment.draftId)!.versionRef, editToken: f.token()! }, sort: [], page: { limit: 50, cursor: null } }, f.context) as any;
    expect(after.standaloneMethodRef).toEqual({ entityType: 'method_version', id: f.input.method.id, revision: 1 });
    expect(after.standaloneMethodRef.id).not.toBe(unrelated.objectId);
});
