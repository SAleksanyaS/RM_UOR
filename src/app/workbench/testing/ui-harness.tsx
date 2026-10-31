import { act, render, type RenderResult } from '@testing-library/react';
import { WorkbenchProvider } from '../context';
import { WorkbenchShell, type WorkbenchViewRegistry } from '../WorkbenchShell';
import { createWorkbenchApiHarness } from './api-harness';

export async function createWorkbenchUiHarness(options: Parameters<typeof createWorkbenchApiHarness>[0], shell: { views?: WorkbenchViewRegistry } = {}) {
  const api = await createWorkbenchApiHarness(options);
  let view: RenderResult | undefined, closed = false;
  return { ...api,
    async open(path: string) {
      if (closed) throw Error('UI harness is closed');
      act(() => {
        window.history.replaceState(null, '', path);
        if (view) window.dispatchEvent(new PopStateEvent('popstate'));
        else view = render(<WorkbenchProvider client={api.client}><WorkbenchShell views={shell.views} /></WorkbenchProvider>);
      });
      await act(async () => {
        // Drain actual app.inject/session/preferences work, also with fake UI timers.
        await api.client.session();
        await api.client.query('preferences.get', { context: null, filter: {}, sort: [], page: { limit: 50, cursor: null } });
      });
    },
    async close() { if (closed) return; closed = true; await act(async () => { view?.unmount(); }); await api.close(); },
  };
}
