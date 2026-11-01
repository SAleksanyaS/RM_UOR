import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { createPublicationScenario, rawPublicationRows } from './helpers/publication';

type Scenario = Awaited<ReturnType<typeof createPublicationScenario>>;
async function startCapture(scenario: Scenario) {
  const { curator, context } = scenario;
  const values = { context, sorts: {}, visual: { theme: 'system', density: 'comfortable' }, notificationPersonId: null };
  await curator.request.session(); await curator.request.command('preferences.set', { values });
  const captureId = randomUUID(), accepted = await curator.request.command('source.capture', { goalId: scenario.input.goal.id }, null, captureId);
  const capture = await scenario.waitJob(curator, accepted.jobId, ['succeeded','failed']);
  expect(capture.error).toBeNull(); expect(capture.result).toMatchObject({ acceptedRows: 1, rejectedRows: 0, duplicate: false });
  expect(await curator.request.command('source.capture', { goalId: scenario.input.goal.id }, null, captureId)).toEqual(accepted);
  const captures = await curator.request.query<any>('data.captures', {}, context), captured = captures.items.find((value: any) => value.capture.id === (capture.result as any).captureRef.id);
  expect(captured.capture.rawRows).toEqual(rawPublicationRows);
  expect(captured.capture.canonicalRows[0]).toMatchObject({ numbers: { demo_value: '96.5' }, dimensions: { productAlias: 'ALIAS-A' } });
  const enriched = await curator.request.query<any>('data.rows', { captureRef: (capture.result as any).captureRef, layer: 'enriched' }, context);
  expect(enriched.items[0].factRefs).toHaveLength(1);
  const lineage = await curator.request.query<any>('data.lineage', { factRef: enriched.items[0].factRefs[0] }, context);
  expect(lineage.facts[0]).toMatchObject({ value: '96.5', scope: scenario.input.assignment.scope, lineage: { sourceRowKeys: ['["source-row-1"]'] } });
  return capture;
}

async function prepareCapturePackage(scenario: Scenario) {
  const { curator, context } = scenario;
  const prepared = await curator.request.command('calculation.prepare', { assignmentRef: { entityType: 'goal_assignment', id: scenario.input.assignment.id, revision: 1 }, businessTime: context.time });
  expect(prepared.result.resultRef).toBeTruthy();
  const confirmation = await curator.request.command('draft.open', { entityType: 'attestation', ref: null, packageId: null });
  const confirmed = await curator.request.command('result.confirm', { draftId: confirmation.result.draftId, resultRef: prepared.result.resultRef, comment: 'Synthetic UOR confirmation after source and directory review', evidenceIds: [] }, confirmation.editToken);
  const confirmedQueue = await curator.request.query<any>('uor.queue', {}, context), confirmedPackage = confirmedQueue.items.find((value: any) => value.editToken === confirmed.editToken);
  const opened = await curator.request.command('draft.open', { entityType: 'agreed_snapshot', ref: null, packageId: confirmedPackage.packageRef.id }, confirmed.editToken);
  const saved = await curator.request.command('snapshot.save', { draftId: opened.result.draftId, basisRef: prepared.result.basisRef, resultRef: prepared.result.resultRef, manualStatusRef: null, attestationRef: confirmed.result.versionRef }, opened.editToken);
  expect(saved.result.complete).toBe(true);
  const queue = await curator.request.query<any>('uor.queue', {}, context), pkg = queue.items.find((value: any) => value.editToken === saved.editToken);
  const preview = await scenario.settled(curator, 'package.preview', { packageId: pkg.packageRef.id }, saved.editToken);
  expect(preview.result.errors).toEqual([]);
  return { packageId: pkg.packageRef.id, preview: preview.result, draftId: opened.result.draftId, saved };
}

it('full_capture_enrich_draft_pr_merge_apply_second_client', async () => {
  const scenario = await createPublicationScenario();
  try {
    const { curator, reader, context, agreedContext } = scenario;
    expect(curator.root).not.toBe(reader.root); expect(curator.runtime.deps.installationId).not.toBe(reader.runtime.deps.installationId);
    expect((await curator.request.session()).role).toBe('curator'); expect((await reader.request.session()).role).toBe('viewer');
    const agreedBefore = await reader.request.query<any>('goals.detail', {}, agreedContext);
    // The history inventory may gain a new snapshot; the selected historical slice stays exact.
    const selectedAgreed = (detail: any) => ({ ...detail, tabs: { ...detail.tabs, history: detail.tabs.history.filter((snapshot: any) => snapshot.id === scenario.snapshot.id) } });
    expect(agreedBefore.rows[0].displayValue).toBe('920/9');
    const capture = await startCapture(scenario), pkg = await prepareCapturePackage(scenario);
    const commandId = randomUUID(), submit = { packageId: pkg.packageId, previewToken: pkg.preview.previewToken };
    const accepted = await curator.request.command('package.submit', submit, null, commandId);
    let job = await scenario.waitJob(curator, accepted.jobId);
    expect(job).toMatchObject({ status: 'waiting_user', stage: 'git.auth', warnings: [{ code: 'GIT_AUTH_REQUIRED' }] });
    expect(scenario.counts()).toMatchObject({ prepares: 1, pushes: 0, creates: 0 });
    const retained = await curator.request.query<any>('uor.package', { packageRef: { entityType: 'publication_package', id: pkg.packageId } }, context);
    expect(retained.entries.find((entry: any) => entry.draftId === pkg.draftId)).toMatchObject({ complete: true });
    expect(retained.summary.delivery.preparedCommit).toMatch(/^[a-f0-9]{40}$/);
    await curator.request.command('job.openAuth', { jobId: accepted.jobId });
    scenario.mode('network'); await curator.request.command('job.retry', { jobId: accepted.jobId });
    job = await scenario.waitJob(curator, accepted.jobId);
    expect(job).toMatchObject({ status: 'retry_wait', warnings: [{ code: 'REMOTE_STATE_UNKNOWN', provider: 'git' }] });
    expect(scenario.counts()).toMatchObject({ prepares: 1, pushes: 0, creates: 0 });
    await curator.request.command('job.retry', { jobId: accepted.jobId }); job = await scenario.waitJob(curator, accepted.jobId);
    expect(job).toMatchObject({ status: 'waiting_user', stage: 'PR.auth' });
    expect(scenario.counts()).toMatchObject({ prepares: 1, pushes: 1, creates: 0 });
    await curator.request.command('job.openAuth', { jobId: accepted.jobId }); scenario.bitbucket.testing.loseNextCreateResponse = true;
    await curator.request.command('job.retry', { jobId: accepted.jobId }); job = await scenario.waitJob(curator, accepted.jobId);
    expect(job).toMatchObject({ status: 'retry_wait', warnings: [{ code: 'REMOTE_STATE_UNKNOWN', provider: 'bitbucket' }] });
    expect(scenario.counts()).toMatchObject({ prepares: 1, pushes: 1, creates: 1 });
    await curator.request.command('job.retry', { jobId: accepted.jobId }); job = await scenario.waitJob(curator, accepted.jobId, ['succeeded','failed']);
    expect(job.error).toBeNull(); expect(job.result).toMatchObject({ state: 'open_pr', proposal: { id: '1' } });
    expect(await curator.request.command('package.submit', submit, null, commandId)).toEqual(accepted);
    expect((await curator.request.reconcile(commandId)).status).toBe('completed');
    expect(scenario.main().commit).toBe('a'.repeat(40));
    const stillOld = await reader.request.query<any>('goals.detail', {}, context); expect(stillOld.rows[0].needs_calculation).toBe(true); expect(stillOld.rows[0].attestation).toBeNull();
    expect(await reader.request.query('goals.detail', {}, agreedContext)).toEqual(agreedBefore);
    // Only the outside service performs merge. App submission and confirmation never do.
    await scenario.mergeExternal((job.result as any).proposal);
    const refreshed = await scenario.settled(curator, 'package.refreshStatus', { packageId: pkg.packageId }); expect(refreshed.result.state).toBe('merged');
    scenario.now('2026-10-23T14:00:00Z', '2026-10-23T15:00:00Z');
    const checked = await scenario.settled(reader, 'publication.check', {}); expect(checked.result.available).toBe(true);
    const readerApply = await scenario.settled(reader, 'publication.apply', { mainCommit: checked.result.availableCommit });
    const curatorApply = await scenario.settled(curator, 'publication.apply', { mainCommit: checked.result.availableCommit });
    expect(readerApply.result.appliedAt).toBe('2026-10-23T15:00:00Z'); expect(curatorApply.result.appliedAt).toBe('2026-10-23T14:00:00Z');
    const identity = (result: any) => result.anchors.map((anchor: any) => ({ packageId: anchor.packageId, revision: anchor.revision, contentHash: anchor.contentHash, repositoryId: anchor.repositoryId, mainCommit: anchor.mainCommit }));
    expect(identity(readerApply.result)).toEqual(identity(curatorApply.result));
    const anchor = readerApply.result.anchors.find((anchor: any) => anchor.id === pkg.packageId);
    expect(anchor).toMatchObject({ publicationState: 'confirmed', timeVerification: 'unknown', mergedAt: null }); expect(anchor).not.toHaveProperty('appliedAt');
    expect(scenario.counts()).toMatchObject({ prepares: 1, pushes: 1, creates: 1, updates: 0, readerRestCalls: 0, authOpens: 1, restAuthOpens: 1 });
    await reader.request.command('calculation.prepare', { assignmentRef: { entityType: 'goal_assignment', id: scenario.input.assignment.id, revision: 1 }, businessTime: context.time });
    const current = await reader.request.query<any>('goals.detail', {}, context); expect(current.rows[0].displayValue).toBe('965/9');
    expect(current.tabs.raw.find((value: any) => value.capture.id === (capture.result as any).captureRef.id).capture.rawRows).toEqual(rawPublicationRows);
    expect(selectedAgreed(await reader.request.query('goals.detail', {}, agreedContext))).toEqual(agreedBefore);
    expect(selectedAgreed(await curator.request.query('goals.detail', {}, agreedContext))).toEqual(agreedBefore);
    await reader.restart(); await reader.request.session();
    scenario.now('2026-10-24T14:00:00Z', '2026-10-24T15:00:00Z');
    const again = await scenario.settled(reader, 'publication.apply', { mainCommit: checked.result.availableCommit }); expect(again.result.appliedAt).toBe(readerApply.result.appliedAt);
  } finally { await scenario.close(); }
}, 120000);

it('auth_cancel_and_policy_revoke_preserve_prepared_package_without_external_write', async () => {
  const scenario = await createPublicationScenario();
  try {
    await startCapture(scenario); const pkg = await prepareCapturePackage(scenario), { curator, context } = scenario;
    const accepted = await curator.request.command('package.submit', { packageId: pkg.packageId, previewToken: pkg.preview.previewToken });
    expect(await scenario.waitJob(curator, accepted.jobId)).toMatchObject({ status: 'waiting_user', stage: 'git.auth' });
    await curator.request.command('job.cancel', { jobId: accepted.jobId });
    expect(await scenario.waitJob(curator, accepted.jobId)).toMatchObject({ status: 'cancelled' });
    const retained = await curator.request.query<any>('uor.package', { packageRef: { entityType: 'publication_package', id: pkg.packageId } }, context);
    expect(retained.entries.find((entry: any) => entry.draftId === pkg.draftId)?.complete).toBe(true);
    expect(scenario.counts()).toMatchObject({ prepares: 1, pushes: 0, creates: 0 });
    scenario.authorize(); scenario.mode('revoke');
    const second = await curator.request.command('package.submit', { packageId: pkg.packageId, previewToken: pkg.preview.previewToken });
    await scenario.revokedTransfer; scenario.restorePolicy();
    expect(await scenario.waitJob(curator, second.jobId, ['failed'])).toMatchObject({ status: 'failed', error: { code: 'ACCESS_DENIED' } });
    expect(scenario.counts()).toMatchObject({ prepares: 1, pushes: 0, creates: 0 });
    const preserved = await curator.request.query<any>('uor.package', { packageRef: { entityType: 'publication_package', id: pkg.packageId } }, context);
    expect(preserved.entries).toEqual(retained.entries); expect(preserved.summary.delivery.preparedCommit).toBe(retained.summary.delivery.preparedCommit);
  } finally { await scenario.close(); }
}, 120000);
