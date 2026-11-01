// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WorkbenchProvider, useGlobalContext, useWorkbench } from './context';
import { createWorkbenchApiHarness } from './testing/api-harness';
import { fixtureId } from '../../../tests/fixtures/workbench/factories';

const closes: Array<() => Promise<void>> = [];
afterEach(async () => { cleanup(); for (const close of closes.splice(0)) await close(); window.history.replaceState(null, '', '/'); });
function Probe() {
  const { loading, session, refreshSession } = useWorkbench();
  const { setContext } = useGlobalContext();
  return <><output>{loading ? 'loading' : session ? 'ready' : 'empty'}</output><button onClick={() => { void refreshSession(); }}>Refresh session</button><button onClick={() => { void setContext({ time: { kind: 'as_of', date: '2026-10-29' } }); }}>Change date</button></>;
}
it('keeps the personal-data page selector through startup, refresh, context changes and history navigation', async () => {
  const h = await createWorkbenchApiHarness({ role: 'viewer', scenario: 'scope-split' }); closes.push(h.close);
  window.history.replaceState(null, '', '/data?cluster=' + fixtureId(103) + '&at=2026-10-28#personal-oko');
  render(<WorkbenchProvider client={h.client}><Probe /></WorkbenchProvider>);
  await screen.findByText('ready');
  expect(window.location.hash).toBe('#personal-oko');
  const initialSearch = window.location.search;
  fireEvent.click(screen.getByRole('button', { name: 'Refresh session' }));
  await screen.findByText('ready');
  expect(window.location.hash).toBe('#personal-oko');
  expect(window.location.search).toBe(initialSearch);
  fireEvent.click(screen.getByRole('button', { name: 'Change date' }));
  await waitFor(() => expect(new URLSearchParams(window.location.search).get('at')).toBe('2026-10-29'));
  expect(window.location.hash).toBe('#personal-oko');
  await act(async () => {
    window.history.pushState(null, '', '/data' + initialSearch + '#personal-oko');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  expect(window.location.hash).toBe('#personal-oko');
  expect(window.location.search).toBe(initialSearch);
  await act(async () => {
    window.history.pushState(null, '', '/data' + initialSearch);
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  expect(window.location.hash).toBe('');
  expect(window.location.search).toBe(initialSearch);
});
it.each(['fact', 'result'] as const)('preserves exact %s lineage on hard reload and session refresh', async kind => {
  const h = await createWorkbenchApiHarness({ role: 'viewer', scenario: 'scope-split' }); closes.push(h.close);
  const id = fixtureId(310001);
  window.history.replaceState(null, '', `/data?${kind}=${id}&${kind}Revision=2&ignored=discard`);
  render(<WorkbenchProvider client={h.client}><Probe /></WorkbenchProvider>);
  await screen.findByText('ready');
  expect(new URLSearchParams(window.location.search).get(kind)).toBe(id);
  expect(new URLSearchParams(window.location.search).get(kind + 'Revision')).toBe('2');
  expect(new URLSearchParams(window.location.search).has('ignored')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Refresh session' }));
  await waitFor(() => expect(screen.getByText('ready')).toBeTruthy());
  expect(new URLSearchParams(window.location.search).get(kind)).toBe(id);
  expect(new URLSearchParams(window.location.search).get(kind + 'Revision')).toBe('2');
});
it.each([
  `fact=invalid&factRevision=1`,
  `fact=${fixtureId(310001)}&factRevision=0`,
  `fact=${fixtureId(310001)}&factRevision=9007199254740992`,
  `fact=${fixtureId(310001)}`,
  `fact=${fixtureId(310001)}&factRevision=1&result=${fixtureId(310002)}&resultRevision=1`,
])('drops invalid or ambiguous lineage selectors: %s', async selector => {
  const h = await createWorkbenchApiHarness({ role: 'viewer', scenario: 'scope-split' }); closes.push(h.close);
  window.history.replaceState(null, '', '/data?' + selector);
  render(<WorkbenchProvider client={h.client}><Probe /></WorkbenchProvider>);
  await screen.findByText('ready');
  const params = new URLSearchParams(window.location.search);
  for (const key of ['fact', 'factRevision', 'result', 'resultRevision']) expect(params.has(key)).toBe(false);
});
