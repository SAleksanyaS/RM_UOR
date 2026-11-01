import { afterEach, expect, it, vi } from 'vitest';
import { createBrowserIntegrationHarness } from './fixtures/workbench/browser-integration';
import { createHash } from 'node:crypto';
import { fixtureId } from './fixtures/workbench/factories';

const closes: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });
it('local_recorder_to_published_reader_capture_uses_downloaded_rows', async () => {
  const f = await createBrowserIntegrationHarness(); closes.push(f.close);
  const review = await f.curatorRecordAndFinish();
  expect(review.steps.at(-1)?.action).toBe('download');
  expect(JSON.stringify(review)).not.toMatch(/synthetic-password|oko_fixture/);
  const screenshot = await f.screenshot(review); expect(screenshot.status).toBe(200); expect(screenshot.headers.get('cache-control')).toBe('no-store'); expect(screenshot.headers.get('content-type')).toBe('image/png');
  const tested = await f.testAndSaveDraft(review);
  expect(tested).toMatchObject({ complete: true, acceptedPreviewRows: 2000, rejectedPreviewRows: 0 });
  expect(f.acceptedCaptures()).toHaveLength(0);
  await f.applyVerifiedSyntheticMain();
  const waiting = await f.readerCapture(); expect(waiting).toMatchObject({ status: 'waiting_user', stage: 'browser.auth' });
  expect(await f.readerLogin()).toEqual({ hadCookie: false });
  const captured = await f.readerCapture(true);
  expect(captured).toMatchObject({ status: 'succeeded', result: { acceptedRows: 2000, rejectedRows: 0 } });
  const view = f.captureView();
  const ownHistory = vi.spyOn(f.reader().sources, 'listOwnCaptures');
  const versions = vi.spyOn(f.reader().repository, 'readVersion');
  try {
    const bounded = await f.download('original'); expect(bounded.status).toBe(200);
    expect(ownHistory).not.toHaveBeenCalled();
    expect(versions.mock.calls.every(([ref]) => ref.id === view.capture.id || view.facts.some(fact => fact.id === ref.id))).toBe(true);
    expect(versions.mock.calls.length).toBeLessThanOrEqual(view.facts.length + 2);
  } finally { ownHistory.mockRestore(); versions.mockRestore(); }
  expect(view.capture.rawRows).toHaveLength(2000); expect(view.capture.canonicalRows).toHaveLength(2000);
  expect(view.facts).toHaveLength(2); expect(view.facts.every(fact => fact.lineage.sourceRowKeys.length === 1000)).toBe(true);
  expect(view.coverage).toMatchObject({ complete: true, expectedRows: 2000, receivedRows: 2000 });
  const original = await f.download('original'); expect(original.status).toBe(200); expect(original.headers.get('cache-control')).toBe('no-store');
  const originalBytes = Buffer.from(await original.arrayBuffer());
  expect(originalBytes.toString().trimEnd().split('\n')).toHaveLength(2001);
  expect('sha256:' + createHash('sha256').update(originalBytes).digest('hex')).toBe(view.capture.payloadHash);
  const enriched = await f.download('enriched'); expect(enriched.status).toBe(200); expect((await enriched.text()).split('\r\n')).toHaveLength(2001);
  expect(f.count('attestation')).toBe(0); expect(f.externalWriteCalls()).toBe(0);
  expect(f.packageText()).not.toMatch(/synthetic-password|oko_fixture|profileDirectory|executablePath/);
  expect(view.facts.map(fact => fact.value)).toEqual(expect.arrayContaining([{ numerator: '1000250', denominator: '1' }, { numerator: '1001250', denominator: '1' }]));
  const reader = f.reader(), resultUrl = reader.origin + `/api/v1/browser/results/${view.capture.id}/original`;
  expect((await fetch(resultUrl)).status).toBe(401);
  expect((await fetch(resultUrl, { headers: { cookie: reader.cookie, origin: f.report.forbiddenOrigin } })).status).toBe(403);
  reader.setPerson(fixtureId(959999)); expect((await f.download('original')).status).toBe(404); reader.setPerson(null);
  expect(reader.sources.readOwnCaptureArtifact({ ...reader.owner, installationId: fixtureId(959998) }, view.capture.id)).toBeNull();
  const screenshotUrl = `/api/v1/browser/recordings/${review.recordingId}/screenshots/${review.screenshotHandles[0]}`;
  expect((await fetch(reader.origin + screenshotUrl, { headers: { cookie: reader.cookie } })).status).toBe(404);
  expect((await fetch(f.curator.origin + screenshotUrl)).status).toBe(401);
  const artifact = reader.repository.sqlForModule('sources').get<{bytes_value: Uint8Array}>('SELECT bytes_value FROM wb_sources_artifacts WHERE installation_id=? AND artifact_id=?', [reader.owner.installationId, view.artifact!.artifactId])!;
  reader.repository.sqlForModule('sources').run('UPDATE wb_sources_artifacts SET bytes_value=? WHERE installation_id=? AND artifact_id=?', [Buffer.from('tampered'), reader.owner.installationId, view.artifact!.artifactId]);
  expect((await f.download('original')).status).toBe(409); expect((await f.download('enriched')).status).toBe(409);
  reader.repository.sqlForModule('sources').run('UPDATE wb_sources_artifacts SET bytes_value=? WHERE installation_id=? AND artifact_id=?', [artifact.bytes_value, reader.owner.installationId, view.artifact!.artifactId]);
  reader.repository.sqlForModule('sources').run('DELETE FROM wb_sources_artifacts WHERE installation_id=? AND artifact_id=?', [reader.owner.installationId, view.artifact!.artifactId]);
  expect((await f.download('original')).status).toBe(409);
  reader.sources.saveArtifact({ installationId: reader.owner.installationId, artifactId: view.artifact!.artifactId, mimeType: view.artifact!.mimeType, bytesValue: artifact.bytes_value });
  const prior = f.acceptedCaptures().length;
  f.report.setMissingSelector(true); expect(await f.readerCapture()).toMatchObject({ status: 'failed', error: { code: 'SELECTOR_NOT_FOUND' } }); f.report.setMissingSelector(false); expect(f.acceptedCaptures()).toHaveLength(prior);
  for (const mode of ['truncated', 'empty', 'error-html', 'cancelled'] as const) { f.report.setExportMode(mode); const failed = await f.readerCapture(true); expect(failed.status, mode + ':' + JSON.stringify(failed.error ?? failed.warnings)).toBe(mode === 'error-html' ? 'waiting_user' : 'failed'); expect(f.acceptedCaptures()).toHaveLength(prior); }
  f.report.setExportMode('expired'); expect(await f.readerCapture()).toMatchObject({ status: 'waiting_user', stage: 'browser.auth' }); expect(f.acceptedCaptures()).toHaveLength(prior);
  f.report.setExportMode('complete');
  expect(await f.captureDuringDelivery('cancel')).toMatchObject({ status: 'cancelled' }); expect(f.acceptedCaptures()).toHaveLength(prior);
  expect(await f.captureDuringDelivery('profile')).toMatchObject({ status: 'failed', error: { code: 'SOURCE_CONFIGURATION_CHANGED' } }); expect(f.acceptedCaptures()).toHaveLength(prior);
  const repeated = await f.repeatCaptureCommand(); expect(repeated.first.jobId).toBe(repeated.second.jobId); expect(repeated.completed.status).toBe('succeeded'); expect(f.acceptedCaptures()).toHaveLength(prior + 1);
  const latest = reader.sources.readCapture(repeated.completed.result!.captureRef, reader.owner.installationId)!, sql = reader.repository.sqlForModule('sources');
  expect(latest.capture.id).not.toBe(view.capture.id);
  const historical = sql.get<{value_json:string}>('SELECT value_json FROM wb_sources_captures WHERE installation_id=? AND capture_id=?', [reader.owner.installationId, view.capture.id])!;
  // A valid download must remain independent of even damaged unrelated history.
  sql.run('UPDATE wb_sources_captures SET value_json=? WHERE installation_id=? AND capture_id=?', ['SYNTHETIC_DAMAGED_HISTORY', reader.owner.installationId, view.capture.id]);
  const selectedVersions = vi.spyOn(reader.repository, 'readVersion');
  try {
    const response = await fetch(reader.origin + `/api/v1/browser/results/${latest.capture.id}/enriched`, { headers: { cookie: reader.cookie } }); expect(response.status).toBe(200); expect((await response.text()).split('\r\n')).toHaveLength(2001);
    expect(selectedVersions.mock.calls.every(([ref]) => ref.id === latest.capture.id || latest.facts.some(fact => fact.id === ref.id))).toBe(true);
    expect(selectedVersions.mock.calls.length).toBeLessThanOrEqual(latest.facts.length + 2);
  } finally { selectedVersions.mockRestore(); sql.run('UPDATE wb_sources_captures SET value_json=? WHERE installation_id=? AND capture_id=?', [historical.value_json, reader.owner.installationId, view.capture.id]); }
  expect(f.report.requests().filter(url => url.startsWith(f.report.forbiddenOrigin))).toHaveLength(0);
  await f.close(); expect(f.openContexts()).toBe(0);
}, 120000);

it('native_private_assignment_proves_a_new_goal_source_and_mapping_without_published_heads', async () => {
  const f = await createBrowserIntegrationHarness(); closes.push(f.close);
  const review = await f.curatorRecordAndFinish();
  const result = await f.testNewPrivateGoal(review);
  expect(result.tested).toMatchObject({ status: 'succeeded', result: { complete: true, acceptedPreviewRows: 2000, rejectedPreviewRows: 0 } });
  expect(result.saved.complete).toBe(true); expect(result.preview).toMatchObject({ status: 'succeeded', result: { errors: [] } });
  for (const target of result.unpublishedRefs) expect(f.curator.repository.readPublishedHead(target)).toBeNull();
  expect(f.acceptedCaptures()).toHaveLength(0); expect(f.count('attestation')).toBe(0); expect(f.externalWriteCalls()).toBe(0);
}, 60000);
