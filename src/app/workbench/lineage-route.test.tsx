// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WorkbenchProvider, useWorkbench } from './context';
import { createWorkbenchApiHarness } from './testing/api-harness';
import { fixtureId } from '../../../tests/fixtures/workbench/factories';

const closes: Array<() => Promise<void>> = [];
afterEach(async () => { cleanup(); for (const close of closes.splice(0)) await close(); window.history.replaceState(null, '', '/'); });
function Probe() {
  const { loading, session, refreshSession } = useWorkbench();
  return <><output>{loading ? 'loading' : session ? 'ready' : 'empty'}</output><button onClick={() => { void refreshSession(); }}>Refresh session</button></>;
}
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
