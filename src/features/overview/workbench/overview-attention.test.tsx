// @vitest-environment jsdom
import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { createWorkbenchUiHarness } from '../../../app/workbench/testing/ui-harness';
import type { EvaluationBasis, ManualStatusEvent } from '../../../domain/workbench/entities';
import { fixtureId, makeHeader, versionRef } from '../../../../tests/fixtures/workbench/factories';
import { resolveEvaluationInput } from '../../evaluation/workbench/resolve-input';
import { canonicalBasis, digestBasis } from '../../evaluation/workbench/basis';
import { WorkbenchOverviewPage } from './OverviewPage';

const closes: Array<() => Promise<void>> = [];
afterEach(async () => { cleanup(); for (const close of closes.splice(0)) await close(); window.history.replaceState(null, '', '/'); });

it.each([
  { state: null, label: 'Ручной статус не задан', running: false },
  { state: 'not_started', label: 'Работа не начата', running: false },
  { state: 'in_progress', label: 'Работа продолжается', running: true },
  { state: 'completed', label: 'Ожидает подтверждения', running: false },
] as const)('shows the actual manual state $state without inventing progress or confirmation', async ({ state, label, running }) => {
  const h = await createWorkbenchUiHarness({ role: 'viewer', scenario: 'manual-goal' }, { views: { overview: WorkbenchOverviewPage } }); closes.push(h.close);
  if (state) {
    const event: ManualStatusEvent = { ...makeHeader(8301, { publicationAnchorId: fixtureId(2) }), assignmentId: h.refs.assignment.id, from: null, to: state, resultDescription: state === 'completed' ? 'Результат принят исполнителем' : null, reason: null, evidenceIds: [] };
    h.repository.append('manual_status_event', event, null);
  }
  await h.open('/overview');
  const queue = await screen.findByRole('region', { name: /Требуют внимания/ });
  expect(within(queue).getByText(label)).toBeTruthy();
  if (!running) expect(within(queue).queryByText('Работа продолжается')).toBeNull();
  if (state === 'completed') expect(within(queue).getByText(/Работа завершена.*ещё не подтвердил/)).toBeTruthy();
  else expect(within(queue).queryByText('Ожидает подтверждения')).toBeNull();
  expect(within(queue).queryByText('Подтверждено УОР')).toBeNull();
});

it('does not ask for confirmation again for the exact confirmed manual snapshot', async () => {
  const h = await createWorkbenchUiHarness({ role: 'viewer', scenario: 'manual-goal' }, { views: { overview: WorkbenchOverviewPage } }); closes.push(h.close);
  const actor = makeHeader(1).actor, clock = { now: () => '2026-10-28T09:00:00Z' };
  const input = resolveEvaluationInput({ assignmentRef: h.refs.assignment, businessTime: { kind: 'as_of', date: '2026-10-28' } }, h.repository, clock, actor);
  const content = canonicalBasis(input);
  const basis: EvaluationBasis = { ...makeHeader(8401, { publicationAnchorId: fixtureId(2) }), ...content, digest: digestBasis(content), evaluatedAt: clock.now() };
  h.repository.transaction(() => {
    h.repository.append('evaluation_basis', basis, null);
    h.repository.append('manual_status_event', { ...makeHeader(8402, { publicationAnchorId: fixtureId(2) }), assignmentId: h.refs.assignment.id, from: null, to: 'completed', resultDescription: 'Готовый результат', reason: null, evidenceIds: [] }, null);
    h.repository.append('attestation', { ...makeHeader(8403, { publicationAnchorId: fixtureId(2) }), basisDigest: basis.digest, comment: 'Проверено УОР', evidenceIds: [] }, null);
    h.repository.append('agreed_snapshot', { ...makeHeader(8404, { publicationAnchorId: fixtureId(2) }), basisRef: versionRef('evaluation_basis', 8401), numericResult: null, manualStatusRef: versionRef('manual_status_event', 8402), attestationRef: versionRef('attestation', 8403) }, null);
  });
  await h.open('/overview?mode=agreed&snapshot=' + fixtureId(8404) + '&at=2026-10-28');
  const queue = await screen.findByRole('region', { name: /Требуют внимания/ });
  expect(within(queue).queryByText('Ожидает подтверждения')).toBeNull();
  expect(within(queue).queryByRole('button', { name: /Открыть цель/ })).toBeNull();
  expect(within(queue).getByText('В этом разделе нет задач для проверки')).toBeTruthy();
});
