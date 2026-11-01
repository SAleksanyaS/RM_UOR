// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { jobSnapshotSchema } from '../../../server/workbench/protocol';
import { fixtureId, makeHeader } from '../../../../tests/fixtures/workbench/factories';
import { publicationPackageRecordSchema } from './contracts';
import { PublishOperation } from './PublishOperation';
afterEach(cleanup);
const pending = () => jobSnapshotSchema.parse({ jobId: fixtureId(360001), commandId: fixtureId(360002), status: 'waiting_user', stage: 'PR.auth', progress: { completed: 2, total: 3, unit: 'steps' }, cancelAvailable: true, retryAvailable: false, result: null, error: null, warnings: [{ code: 'PR_AUTH_REQUIRED', message: 'Native login required', retryable: true, details: [], operationId: fixtureId(360001), provider: 'bitbucket' }], nextAction: { commandName: 'job.openAuth', payload: { jobId: fixtureId(360001) }, route: null, label: 'Открыть штатный вход', enabled: true, disabledReason: null }, startedAt: '2026-11-01T09:00:00Z', finishedAt: null });
const pushed = () => publicationPackageRecordSchema.parse({ ...makeHeader(360003), cycleId: fixtureId(360004), curatorPersonId: fixtureId(17), state: 'publishing', current: null, sent: null, draftRefs: [], proposal: null });
const delivery = () => ({packageRevision: {schemaVersion: 1 as const, packageId: fixtureId(360003), cycleId: fixtureId(360004), curatorPersonId: fixtureId(17), revision: 1, baseCommit: 'a'.repeat(40), targetBranch: 'main' as const, contentHash: 'sha256:'+'a'.repeat(64), createdAt: '2026-11-01T09:00:00Z'}, preparedCommit: 'b'.repeat(40), pushState: 'confirmed' as const, job: pending()});
it('shows accepted git transfer separately from a pending PR and only actual controls', () => {
  const onControl = vi.fn(); const job = pending();
  render(<PublishOperation publication={pushed()} delivery={delivery()} job={job} onControl={onControl} />);
  expect(screen.getByText('Коммиты отправлены, PR ожидает входа')).toBeTruthy();
  expect(screen.queryByText('PR создан')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Открыть штатный вход' }));
  expect(onControl).toHaveBeenCalledWith('job.openAuth', job.jobId);
  expect(screen.queryByRole('button', { name: 'Повторить операцию' })).toBeNull();
  expect(screen.queryByLabelText(/пароль/i)).toBeNull();
  expect(screen.queryByRole('button', { name: 'Слить в main' })).toBeNull();
});
it('does not relabel retained accepted commits as an unsuccessful push after cancellation', () => {
  render(<PublishOperation publication={pushed()} delivery={delivery()} job={{ ...pending(), status: 'cancelled', nextAction: null, cancelAvailable: false }} onControl={vi.fn()} />);
  expect(screen.getByText('Коммиты сохранены; продолжение операции отменено')).toBeTruthy();
  expect(screen.queryByText('Изменения не отправлены')).toBeNull();
});
it('rejects unsafe proposal links and disables unavailable native controls', () => {
  render(<PublishOperation publication={{ ...pushed(), state: 'open_pr', proposal: { provider: 'bitbucket', repositoryId: 'fixture', id: '1', url: 'javascript:alert(1)' } }} job={{ ...pending(), nextAction: { ...pending().nextAction!, enabled: false, disabledReason: 'Native window unavailable' } }} onControl={vi.fn()} />);
  expect(screen.queryByRole('link')).toBeNull();
  expect((screen.getByRole('button', { name: 'Открыть штатный вход' }) as HTMLButtonElement).disabled).toBe(true);
});

it('does not animate a completed operation as still running',()=>{
 render(<PublishOperation publication={pushed()} job={{...pending(),status:'succeeded',stage:'completed',nextAction:null,cancelAvailable:false,retryAvailable:false,finishedAt:'2026-11-01T09:01:00Z'}} onControl={vi.fn()}/>);
 expect(screen.queryByRole('progressbar')).toBeNull();
});
