import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { createWorkbenchRepository } from '../storage/workbench-repository';
import { fixtureId } from '../../../tests/fixtures/workbench/factories';
import { createJobStore } from './jobs';

const cleanup: Array<() => void> = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'uor-jobs-')); const config = { filename: path.join(root, 'state.sqlite'), artifactRoot: path.join(root, 'artifacts') };
  const repo = createWorkbenchRepository(config); cleanup.push(() => { repo.close(); if (!path.basename(root).startsWith('uor-jobs-')) throw Error('Invalid test root'); rmSync(root, { recursive: true, force: true }); });
  const clock = { now: () => '2026-10-28T04:20:00Z' };
  return { repo, config, clock, jobs: createJobStore({ repository: repo, clock }) };
}
it('recovers all interrupted jobs without replay and protects ownership', () => {
  const f = fixture(); const ids: string[] = [];
  const queued = f.jobs.create(fixtureId(999), fixtureId(1), 'package.submit'); ids.push(queued.jobId);
  for (let n = 0; n < 61; n++) { const accepted = f.jobs.create(fixtureId(100 + n), fixtureId(1), 'source.capture'); ids.push(accepted.jobId); f.jobs.update(accepted.jobId, { status: 'running' }); }
  expect(f.jobs.get(ids[0], fixtureId(2))).toBeNull(); f.repo.close();
  const reopened = createWorkbenchRepository(f.config); try { const jobs = createJobStore({ repository: reopened, clock: f.clock }); jobs.recoverInterrupted(); for (const id of ids) expect(jobs.get(id, fixtureId(1))).toMatchObject({ status: 'interrupted', result: null, retryAvailable: false }); } finally { reopened.close(); }
});
it('validates stages, terminal results, cancellation and checkpoint retention', async () => {
  const f = fixture(); const a = f.jobs.create(fixtureId(100), fixtureId(1), 'demo');
  expect(f.jobs.create(fixtureId(100), fixtureId(1), 'demo')).toEqual(a);
  expect(() => f.jobs.update(a.jobId, { stage: 'unregistered' })).toThrow();
  f.jobs.update(a.jobId, { status: 'running' });
  f.jobs.registerStage('demo.collect'); f.jobs.stage(a.jobId, 'demo.collect', { completed: 1, total: 2, unit: 'rows' });
  for (let n = 0; n < 350; n++) f.jobs.checkpoint(a.jobId, { n });
  expect(f.jobs.checkpoints(a.jobId, fixtureId(1))).toHaveLength(350);
  f.jobs.registerControl(a.jobId, { cancel: async () => {} }); f.jobs.markIrreversible(a.jobId);
  await expect(f.jobs.cancel(a.jobId, fixtureId(1))).rejects.toMatchObject({ statusCode: 409 });
  f.jobs.complete(a.jobId, { rows: 2 }, []); expect(f.jobs.get(a.jobId, fixtureId(1))).toMatchObject({ status: 'succeeded', result: { rows: 2 }, error: null });
  expect(() => f.jobs.update(a.jobId, { status: 'running' })).toThrow();
});
it('retains a registered continuation while replacing per-attempt cancel and auth controls', async () => {
  const f = fixture(), installation = fixtureId(1), accepted = f.jobs.create(fixtureId(400), installation, 'source.browser.record.test');
  let cancelled = '', authenticated = 0;
  f.jobs.setScheduler(async (_resource, run) => { await run(); });
  f.jobs.registerControl(accepted.jobId, { retry: async () => { f.jobs.complete(accepted.jobId, { resumed: true }, []); }, cancel: async () => { cancelled = 'old'; } });
  f.jobs.registerControl(accepted.jobId, { cancel: async () => { cancelled = 'latest'; }, openAuth: async () => { authenticated++; } });
  f.jobs.update(accepted.jobId, { status: 'running' }); f.jobs.update(accepted.jobId, { status: 'waiting_user' });
  expect(f.jobs.get(accepted.jobId, installation)).toMatchObject({ retryAvailable: true, cancelAvailable: true });
  await f.jobs.openAuth(accepted.jobId, installation); expect(authenticated).toBe(1);
  f.jobs.registerControl(accepted.jobId, { openAuth: undefined });
  await expect(f.jobs.openAuth(accepted.jobId, installation)).rejects.toMatchObject({ code: 'AUTH_NOT_AVAILABLE' });
  await f.jobs.retry(accepted.jobId, installation); await Promise.resolve();
  expect(f.jobs.get(accepted.jobId, installation)).toMatchObject({ status: 'succeeded', result: { resumed: true } }); expect(cancelled).toBe('');
  const cancelledJob = f.jobs.create(fixtureId(401), installation, 'source.browser.record.test');
  f.jobs.registerControl(cancelledJob.jobId, { cancel: async () => { cancelled = 'old'; } });
  f.jobs.registerControl(cancelledJob.jobId, { cancel: async () => { cancelled = 'latest'; } });
  await f.jobs.cancel(cancelledJob.jobId, installation); expect(cancelled).toBe('latest');
});

it('uses an indexed checkpoint lookup after reopening retained job history', () => {
  const f = fixture();
  const history = f.jobs.create(fixtureId(200), fixtureId(1), 'demo.history');
  const withoutCheckpoint = f.jobs.create(fixtureId(201), fixtureId(1), 'demo.pending');
  const withCheckpoint = f.jobs.create(fixtureId(202), fixtureId(1), 'demo.pending');
  f.repo.transaction(() => { for (let n = 0; n < 1000; n++) f.jobs.checkpoint(history.jobId, { n }); });
  f.jobs.update(history.jobId, { status: 'running' }); f.jobs.complete(history.jobId, {}, []);
  f.jobs.checkpoint(withCheckpoint.jobId, { uncertain: true });
  f.repo.close();
  const repository = createWorkbenchRepository(f.config);
  try {
    const jobs = createJobStore({ repository, clock: f.clock });
    const candidates = jobs.recoveryCandidates();
    expect(candidates.map(row => [row.snapshot.jobId, row.hasCheckpoints])).toEqual([[withoutCheckpoint.jobId, false], [withCheckpoint.jobId, true]]);
    const inspection = new DatabaseSync(f.config.filename, { readOnly: true });
    try {
      const plan = inspection.prepare('EXPLAIN QUERY PLAN SELECT EXISTS(SELECT 1 FROM wb_jobs_checkpoints c WHERE c.job_id=?)').all(withoutCheckpoint.jobId) as Array<{ detail: string }>;
      expect(plan.some(row => /SEARCH c USING COVERING INDEX .*\(job_id=\?\)/.test(row.detail))).toBe(true);
      expect(plan.some(row => /SCAN c\b/.test(row.detail))).toBe(false);
      expect(jobs.checkpoints(history.jobId, fixtureId(1))).toHaveLength(1000);
    } finally { inspection.close(); }
  } finally { repository.close(); }
});

it('preserves queue identity across restart without exposing another installation resource', () => {
  const f = fixture();
  const accepted = f.jobs.create(fixtureId(300), fixtureId(1), 'source.capture');
  f.jobs.setResourceKey(accepted.jobId, 'source:published-source-a');
  f.repo.close();
  const repository = createWorkbenchRepository(f.config);
  try {
    const jobs = createJobStore({ repository, clock: f.clock });
    expect(jobs.getResourceKey(accepted.jobId, fixtureId(1))).toBe('source:published-source-a');
    expect(jobs.getResourceKey(accepted.jobId, fixtureId(2))).toBeNull();
    expect(jobs.getResourceKey(fixtureId(301), fixtureId(1))).toBeNull();
  } finally { repository.close(); }
});
