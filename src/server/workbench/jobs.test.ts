import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
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
