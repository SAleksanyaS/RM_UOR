// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { WorkbenchProvider, useGlobalContext, useWorkbench, useWorkbenchQuery } from './context';
import { WorkbenchClient } from './api-client';
import { createWorkbenchApiHarness } from './testing/api-harness';
import type { GlobalContext, QueryRequest } from '../../server/workbench/protocol';
import { fixtureId } from '../../../tests/fixtures/workbench/factories';
const closes: Array<() => Promise<void>> = [];
afterEach(async () => { cleanup(); for (const close of closes.splice(0)) await close(); vi.restoreAllMocks(); window.history.replaceState(null, '', '/'); });
it('ignores_obsolete_context_response', async () => {
  const h = await createWorkbenchApiHarness({ role: 'viewer', scenario: 'scope-split' }); closes.push(h.close);
  const context = (await h.client.session()).data.defaultContext!;
  let resolveA!: (r: Response) => void, aStarted!: () => void;
  const started = new Promise<void>(r => { aStarted = r; });
  let heldSignal: AbortSignal | null | undefined;
  const fetcher: typeof fetch = async (input, init) => {
    if (String(input).endsWith('/queries/context.options') && JSON.parse(String(init?.body)).context.time.date === '2026-10-28') {
      heldSignal = init?.signal; const response = await h.fetch(input, init); aStarted();
      return new Promise<Response>(resolve => { resolveA = () => resolve(response); });
    }
    return h.fetch(input, init);
  };
  const client = new WorkbenchClient({ fetch: fetcher });
  const request = (c: GlobalContext): QueryRequest => ({ context: c, filter: {}, sort: [], page: { limit: 50, cursor: null } });
  function Probe({ date }: { date: string }) { const result = useWorkbenchQuery<{ entities: unknown[] }>('context.options', request({ ...context, time: { kind: 'as_of', date } })); return <div data-testid="result">{result.loading ? 'loading' : result.data ? date + ':' + result.response?.requestId : 'empty'}</div>; }
  const view = render(<WorkbenchProvider client={client}><Probe date="2026-10-28" /></WorkbenchProvider>);
  await started;
  view.rerender(<WorkbenchProvider client={client}><Probe date="2026-10-29" /></WorkbenchProvider>);
  await screen.findByText(/^2026-10-29:/); expect(heldSignal?.aborted).toBe(true);
  const activeRequest = screen.getByTestId('result').textContent;
  await act(async () => { resolveA(new Response()); });
  expect(screen.getByTestId('result').textContent).toBe(activeRequest);
});
it('persists_context_preserving_preferences_and_handles_browser_history', async () => {
  const h = await createWorkbenchApiHarness({ role: 'viewer', scenario: 'scope-split' }); closes.push(h.close);
  await h.client.session();
  await h.client.command({ commandId: crypto.randomUUID(), name: 'preferences.set', baseRevision: null, payload: { values: { context: null, sorts: { 'goals.list': [{ field: 'title', direction: 'asc' }] }, visual: { theme: 'dark', density: 'compact' }, notificationPersonId: null } } });
  let global!: ReturnType<typeof useGlobalContext>;
  function Probe() { global = useGlobalContext(); return <div>{global.context?.time.kind === 'as_of' ? global.context.time.date : 'empty'}</div>; }
  const view = render(<WorkbenchProvider client={h.client}><Probe /></WorkbenchProvider>);
  await screen.findByText('2026-10-28');
  await act(async () => { await global.setContext({ time: { kind: 'as_of', date: '2026-10-29' } }); });
  expect(window.location.search).toContain('at=2026-10-29');
  const saved = h.requests.filter(r => r.body?.name === 'preferences.set').at(-1)?.body;
  expect(saved?.payload).toMatchObject({ values: { visual: { theme: 'dark', density: 'compact' }, sorts: { 'goals.list': [{ field: 'title', direction: 'asc' }] } } });
  view.unmount();
  window.history.replaceState(null, '', '/overview');
  render(<WorkbenchProvider client={h.client}><Probe /></WorkbenchProvider>);
  await screen.findByText('2026-10-29');
  await act(async () => { window.history.replaceState(null, '', '/goals?at=2026-10-28'); window.dispatchEvent(new PopStateEvent('popstate')); });
  await waitFor(() => expect(global.context?.time).toEqual({ kind: 'as_of', date: '2026-10-28' }));
  await waitFor(() => expect(h.requests.filter(r => r.body?.name === 'preferences.set')).toHaveLength(3));
});
it('keeps_null_default_context_without_an_invented_selection_or_preference_write', async () => {
  const h = await createWorkbenchApiHarness({ role: 'viewer', scenario: 'empty' }); closes.push(h.close);
  let global!: ReturnType<typeof useGlobalContext>;
  function Probe() { global = useGlobalContext(); return <div>{global.context === null ? 'no catalog' : 'unexpected scope'}</div>; }
  render(<WorkbenchProvider client={h.client}><Probe /></WorkbenchProvider>);
  await waitFor(() => expect(h.requests.some(r => r.url.endsWith('preferences.get'))).toBe(true));
  expect(global.context).toBeNull();
  expect(h.requests.some(r => r.body?.name === 'preferences.set')).toBe(false);
});
it('preserves_the_selected_context_and_surfaces_a_lost_mutation_response_without_retry', async () => {
  const h = await createWorkbenchApiHarness({ role: 'viewer', scenario: 'scope-split' }); closes.push(h.close);
  const client = new WorkbenchClient({ fetch: async (input, init) => {
    const response = await h.fetch(input, init);
    if (String(input).endsWith('/commands')) throw Error('synthetic lost response');
    return response;
  } });
  let global!: ReturnType<typeof useGlobalContext>;
  function Probe() { global = useGlobalContext(); return <div>{global.context?.time.kind === 'as_of' ? global.context.time.date : 'empty'}</div>; }
  render(<WorkbenchProvider client={client}><Probe /></WorkbenchProvider>);
  await screen.findByText('2026-10-28');
  await act(async () => { await expect(global.setContext({ time: { kind: 'as_of', date: '2026-10-29' } })).rejects.toThrow('synthetic lost response'); });
  expect(global.persistenceError).toBeInstanceOf(Error);
  expect(global.context?.time).toEqual({ kind: 'as_of', date: '2026-10-29' });
  expect(h.requests.filter(r => r.body?.name === 'preferences.set')).toHaveLength(1);
});
it('does_not_persist_history_before_authoritative_initialization', async () => {
  const h = await createWorkbenchApiHarness({ role: 'viewer', scenario: 'scope-split' }); closes.push(h.close);
  const saved = (await h.client.session()).data.defaultContext!;
  await h.client.command({ commandId: crypto.randomUUID(), name: 'preferences.set', baseRevision: null, payload: { values: { context: saved, sorts: {}, visual: { theme: 'dark', density: 'compact' }, notificationPersonId: null } } });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const client = new WorkbenchClient({ fetch: async (input, init) => {
    const response = await h.fetch(input, init);
    if (String(input).endsWith('/session')) await gate;
    return response;
  } });
  let global!: ReturnType<typeof useGlobalContext>;
  function Probe() { global = useGlobalContext(); const state = useWorkbench(); return <div>{state.loading ? 'loading' : 'ready'}</div>; }
  render(<WorkbenchProvider client={client}><Probe /></WorkbenchProvider>);
  await waitFor(() => expect(h.requests.filter(r => r.url.endsWith('/session')).length).toBeGreaterThan(1));
  await act(async () => { window.history.replaceState(null, '', '/goals?at=2026-10-29'); window.dispatchEvent(new PopStateEvent('popstate')); });
  const beforeRelease = h.requests.filter(r => r.body?.name === 'preferences.set').length;
  await act(async () => { release(); }); await screen.findByText('ready');
  expect(global.context?.time).toEqual({ kind: 'as_of', date: '2026-10-29' });
  expect(beforeRelease).toBe(1);
  expect(h.requests.filter(r => r.body?.name === 'preferences.set')).toHaveLength(1);
});
it.each(['replace-client', 'unmount'] as const)('abandons_obsolete_preference_reads_and_queued_work_on_%s', async kind => {
  const a = await createWorkbenchApiHarness({ role: 'viewer', scenario: 'scope-split' }); closes.push(a.close);
  const b = await createWorkbenchApiHarness({ role: 'viewer', scenario: 'scope-split' }); closes.push(b.close);
  let preferenceReads = 0, started!: () => void, release!: () => void;
  const reading = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const clientA = new WorkbenchClient({ fetch: async (input, init) => {
    const response = await a.fetch(input, init);
    if (String(input).endsWith('/queries/preferences.get') && ++preferenceReads === 2) { started(); await gate; }
    return response;
  } });
  let global!: ReturnType<typeof useGlobalContext>, workbench!: ReturnType<typeof useWorkbench>;
  function Probe() { global = useGlobalContext(); workbench = useWorkbench(); return <div>{workbench.loading ? 'loading' : 'ready'}</div>; }
  const view = render(<WorkbenchProvider client={clientA}><Probe /></WorkbenchProvider>);
  await screen.findByText('ready');
  let first!: Promise<void>, queued!: Promise<void>;
  act(() => { first = global.setContext({ time: { kind: 'as_of', date: '2026-10-29' } }); queued = global.setContext({ time: { kind: 'as_of', date: '2026-10-30' } }); });
  await reading;
  if (kind === 'replace-client') { view.rerender(<WorkbenchProvider client={b.client}><Probe /></WorkbenchProvider>); await waitFor(() => expect(workbench.client).toBe(b.client)); await screen.findByText('ready'); }
  else view.unmount();
  await act(async () => { release(); await Promise.allSettled([first, queued]); });
  expect(a.requests.filter(r => r.body?.name === 'preferences.set')).toHaveLength(0);
  expect(preferenceReads).toBe(2);
  if (kind === 'replace-client') { expect(workbench.preferences?.values.context).toBeNull(); expect(global.persistenceError).toBeNull(); }
});
it.each(['response', 'error'] as const)('ignores_an_already_dispatched_old_client_mutation_%s', async outcome => {
  const a = await createWorkbenchApiHarness({ role: 'viewer', scenario: 'scope-split' }); closes.push(a.close);
  const b = await createWorkbenchApiHarness({ role: 'viewer', scenario: 'scope-split' }); closes.push(b.close);
  let started!: () => void, release!: () => void;
  const dispatched = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const clientA = new WorkbenchClient({ fetch: async (input, init) => {
    const response = await a.fetch(input, init);
    if (String(input).endsWith('/commands')) { started(); await gate; if (outcome === 'error') throw Error('old client lost response'); }
    return response;
  } });
  let global!: ReturnType<typeof useGlobalContext>, workbench!: ReturnType<typeof useWorkbench>;
  function Probe() { global = useGlobalContext(); workbench = useWorkbench(); return <div>{workbench.loading ? 'loading' : 'ready'}</div>; }
  const view = render(<WorkbenchProvider client={clientA}><Probe /></WorkbenchProvider>);
  await screen.findByText('ready');
  let save!: Promise<void>;
  act(() => { save = global.setContext({ time: { kind: 'as_of', date: '2026-10-29' } }); });
  await dispatched;
  view.rerender(<WorkbenchProvider client={b.client}><Probe /></WorkbenchProvider>);
  await waitFor(() => expect(workbench.client).toBe(b.client)); await screen.findByText('ready');
  await act(async () => { release(); await Promise.allSettled([save]); });
  expect(workbench.preferences?.values.context).toBeNull();
  expect(global.persistenceError).toBeNull();
  expect(a.requests.filter(r => r.body?.name === 'preferences.set')).toHaveLength(1);
  expect(b.requests.filter(r => r.body?.name === 'preferences.set')).toHaveLength(0);
});
it('serializes appearance and context writes without dropping either preference',async()=>{
 const h=await createWorkbenchApiHarness({role:'viewer',scenario:'scope-split'});closes.push(h.close);
 let global!:ReturnType<typeof useGlobalContext>,wb!:ReturnType<typeof useWorkbench>;
 function Probe(){global=useGlobalContext();wb=useWorkbench();return <p>{wb.loading?'loading':'ready'}</p>;}
 render(<WorkbenchProvider client={h.client}><Probe/></WorkbenchProvider>);await screen.findByText('ready');
 await act(async()=>{await Promise.all([wb.saveAppearance({theme:'dark',sidebar:'compact'}),global.setContext({time:{kind:'as_of',date:'2026-10-29'}})]);});
 expect(wb.preferences?.values.visual).toMatchObject({theme:'dark',sidebar:'compact'});
 expect(wb.preferences?.values.context?.time).toEqual({kind:'as_of',date:'2026-10-29'});
});
it('never applies an old appearance response after changing clients',async()=>{
 const a=await createWorkbenchApiHarness({role:'viewer',scenario:'empty'}),b=await createWorkbenchApiHarness({role:'viewer',scenario:'empty'});closes.push(a.close,b.close);
 let release!:()=>void,started!:()=>void;const gate=new Promise<void>(r=>{release=r;}),sent=new Promise<void>(r=>{started=r;});
 const client=new WorkbenchClient({fetch:async(input,init)=>{const response=await a.fetch(input,init);if(String(input).endsWith('/commands')){started();await gate;}return response;}});
 let wb!:ReturnType<typeof useWorkbench>;function Probe(){wb=useWorkbench();return <p>{wb.loading?'loading':'ready'}</p>;}
 const view=render(<WorkbenchProvider client={client}><Probe/></WorkbenchProvider>);await screen.findByText('ready');
 let save!:Promise<void>;act(()=>{save=wb.saveAppearance({theme:'dark'});});await sent;
 view.rerender(<WorkbenchProvider client={b.client}><Probe/></WorkbenchProvider>);await screen.findByText('ready');
 await act(async()=>{release();await save;});expect(wb.preferences?.values.visual.theme).toBe('system');expect(wb.appearancePending).toBe(false);
});

it('persists navigation with merged appearance and respects only bare-root start page',async()=>{
 const h=await createWorkbenchApiHarness({role:'viewer',scenario:'empty'});closes.push(h.close);
 let wb!:ReturnType<typeof useWorkbench>,g!:ReturnType<typeof useGlobalContext>;
 function Probe(){wb=useWorkbench();g=useGlobalContext();return <p>{wb.loading?'loading':'ready'}</p>;}
 const view=render(<WorkbenchProvider client={h.client}><Probe/></WorkbenchProvider>);await screen.findByText('ready');
 await act(async()=>{await Promise.all([wb.saveNavigation({kind:'favorite',path:'/data'}),wb.saveNavigation({kind:'start',path:'/data'}),wb.saveAppearance({theme:'dark'})]);});
 act(()=>g.navigate('/knowledge'));await waitFor(()=>expect(wb.preferences?.values.navigation?.recent).toEqual(['/knowledge']));
 expect(wb.preferences?.values.navigation).toEqual({favorites:['/data'],recent:['/knowledge'],startPage:'/data'});
 expect(wb.preferences?.values.visual.theme).toBe('dark');view.unmount();
 window.history.replaceState(null,'','/');const second=render(<WorkbenchProvider client={h.client}><Probe/></WorkbenchProvider>);await screen.findByText('ready');expect(window.location.pathname).toBe('/data');second.unmount();
 window.history.replaceState(null,'','/reports#weekly');render(<WorkbenchProvider client={h.client}><Probe/></WorkbenchProvider>);await screen.findByText('ready');expect(window.location.pathname+window.location.hash).toBe('/reports#weekly');
});
it('reconciles lost navigation receipt without duplicate mutation',async()=>{
 const h=await createWorkbenchApiHarness({role:'viewer',scenario:'empty'});closes.push(h.close);
 const client=new WorkbenchClient({fetch:async(input,init)=>{const r=await h.fetch(input,init);if(String(input).endsWith('/commands'))throw Error('lost');return r;}});
 let wb!:ReturnType<typeof useWorkbench>;function Probe(){wb=useWorkbench();return <p>{wb.loading?'loading':'ready'}</p>;}
 render(<WorkbenchProvider client={client}><Probe/></WorkbenchProvider>);await screen.findByText('ready');
 await act(async()=>{await expect(wb.saveNavigation({kind:'favorite',path:'/data'})).rejects.toThrow('lost');});
 expect(wb.appearancePending).toBe(true);await act(async()=>{await wb.recoverAppearance();});
 expect(wb.preferences?.values.navigation?.favorites).toEqual(['/data']);expect(h.requests.filter(r=>r.body?.name==='preferences.set')).toHaveLength(1);
});

it('does not carry a pending favorite or late saved result into another client identity',async()=>{
 const a=await createWorkbenchApiHarness({role:'viewer',scenario:'empty'}),b=await createWorkbenchApiHarness({role:'viewer',scenario:'empty'});closes.push(a.close,b.close);
 let release!:()=>void,started!:()=>void;const gate=new Promise<void>(r=>release=r),sent=new Promise<void>(r=>started=r);
 const client=new WorkbenchClient({fetch:async(input,init)=>{const r=await a.fetch(input,init);if(String(input).endsWith('/commands')){started();await gate;}return r;}});
 let wb!:ReturnType<typeof useWorkbench>;function Probe(){wb=useWorkbench();return <p>{wb.loading?'loading':'ready'}</p>;}
 const view=render(<WorkbenchProvider client={client}><Probe/></WorkbenchProvider>);await screen.findByText('ready');let save!:Promise<void>;
 act(()=>{save=wb.saveNavigation({kind:'favorite',path:'/data'});});await sent;
 view.rerender(<WorkbenchProvider client={b.client}><Probe/></WorkbenchProvider>);await waitFor(()=>expect(wb.client).toBe(b.client));await screen.findByText('ready');
 await act(async()=>{release();await save;});expect(wb.preferences?.values.navigation?.favorites).toEqual([]);expect(wb.appearancePending).toBe(false);expect(b.requests.some(r=>r.body?.name==='preferences.set')).toBe(false);
});

it('recovers a pre-send preference failure by explicitly retrying the original command',async()=>{
 const h=await createWorkbenchApiHarness({role:'viewer',scenario:'empty'});closes.push(h.close);const attempts:unknown[]=[];
 const client=new WorkbenchClient({fetch:async(input,init)=>{if(String(input).endsWith('/commands')){attempts.push(JSON.parse(String(init?.body)));if(attempts.length===1)throw Error('before send');}return h.fetch(input,init);}});
 let wb!:ReturnType<typeof useWorkbench>;function Probe(){wb=useWorkbench();return <p>{wb.loading?'loading':'ready'}</p>;}
 render(<WorkbenchProvider client={client}><Probe/></WorkbenchProvider>);await screen.findByText('ready');
 await act(async()=>{await expect(wb.saveAppearance({theme:'dark'})).rejects.toThrow('before send');await expect(wb.recoverAppearance()).rejects.toThrow();});
 expect(wb.appearanceRecovery).toBe('not_found');expect(wb.appearancePending).toBe(true);
 await act(async()=>{await wb.retryAppearance();});expect(attempts).toHaveLength(2);expect(attempts[1]).toEqual(attempts[0]);expect(wb.preferences?.values.visual.theme).toBe('dark');expect(wb.appearancePending).toBe(false);
});
it.each(['completed','interrupted'] as const)('retains %s preference recovery through failed readback and does not acknowledge unrelated changes',async(status)=>{
 const h=await createWorkbenchApiHarness({role:'viewer',scenario:'empty'});closes.push(h.close);let failRead=false,first=true;
 const client=new WorkbenchClient({fetch:async(input,init)=>{if(String(input).endsWith('/queries/preferences.get')&&failRead)throw Error('readback failed');if(String(input).endsWith('/commands')&&first){first=false;if(status==='completed')await h.fetch(input,init);throw Error('lost');}return h.fetch(input,init);}});
 const reconcile=client.reconcileCommand.bind(client);vi.spyOn(client,'reconcileCommand').mockImplementation(async id=>{const r=await reconcile(id);return {...r,data:{...r.data,status}};});
 let wb!:ReturnType<typeof useWorkbench>;function Probe(){wb=useWorkbench();return <p>{wb.loading?'loading':'ready'}</p>;}
 render(<WorkbenchProvider client={client}><Probe/></WorkbenchProvider>);await screen.findByText('ready');
 await act(async()=>{await expect(wb.saveAppearance({theme:'dark'})).rejects.toThrow('lost');await expect(wb.saveNavigation({kind:'favorite',path:'/data'})).rejects.toThrow();});
 expect(wb.preferences?.values.navigation?.favorites).toEqual([]);failRead=true;
 await act(async()=>{await expect(wb.recoverAppearance()).rejects.toThrow('readback failed');});expect(wb.appearancePending).toBe(true);failRead=false;
 await act(async()=>{if(status==='interrupted')await expect(wb.recoverAppearance()).rejects.toThrow(/прервано/);else await wb.recoverAppearance();});
 expect(wb.appearancePending).toBe(false);expect(wb.preferences?.values.visual.theme).toBe(status==='completed'?'dark':'system');
 await act(async()=>{await wb.saveNavigation({kind:'favorite',path:'/data'});});expect(wb.preferences?.values.navigation?.favorites).toEqual(['/data']);
});

it('queues mixed favorite ordering, visibility and default-view reset while preserving the selected context and recipient',async()=>{
 const h=await createWorkbenchApiHarness({role:'viewer',scenario:'scope-split'});closes.push(h.close);
 await h.client.session();
 await h.client.command({commandId:crypto.randomUUID(),name:'preferences.set',baseRevision:null,payload:{values:{context:null,sorts:{'goals.list':[{field:'title',direction:'asc'}]},visual:{theme:'light',density:'compact'},rawTableColumns:{['a'.repeat(64)]:['col_2','col_1']},notificationPersonId:fixtureId(17)}}});
 let wb!:ReturnType<typeof useWorkbench>,g!:ReturnType<typeof useGlobalContext>;
 function Probe(){wb=useWorkbench();g=useGlobalContext();return <p>{wb.loading?'loading':'ready'}</p>;}
 render(<WorkbenchProvider client={h.client}><Probe/></WorkbenchProvider>);await screen.findByText('ready');
 const goal={kind:'goal' as const,id:fixtureId(11)},team={kind:'team' as const,id:fixtureId(104)},report={kind:'report' as const,id:fixtureId(99501),revision:3};
 await act(async()=>{await Promise.all([wb.saveNavigation({kind:'favorite',path:goal}),wb.saveNavigation({kind:'favorite',path:'/data'}),wb.saveNavigation({kind:'favorite',path:team}),wb.saveNavigation({kind:'favorite',path:report}),wb.saveAppearance({theme:'dark',density:'compact'}),g.setContext({time:{kind:'as_of',date:'2026-10-29'}})]);});
 expect(wb.preferences?.values.navigation?.favorites).toEqual([goal,'/data',team,report]);
 await act(async()=>{await wb.saveNavigation({kind:'move',favorite:report,offset:-1});await wb.saveNavigation({kind:'display',visible:false});});
 expect(wb.preferences?.values.navigation).toMatchObject({favorites:[goal,'/data',report,team],showFavorites:false});
 act(()=>g.navigate('/reports?report='+report.id+'&reportRevision=3'));
 await act(async()=>{await g.setContext({time:{kind:'as_of',date:'2026-10-30'}});});
 expect(new URL(window.location.href).searchParams.get('report')).toBe(report.id);expect(new URL(window.location.href).searchParams.get('reportRevision')).toBe('3');
 const context=wb.preferences?.values.context,recipient=wb.preferences?.values.notificationPersonId;
 expect(wb.preferences?.values.sorts).toEqual({'goals.list':[{field:'title',direction:'asc'}]});expect(wb.preferences?.values.rawTableColumns).toEqual({['a'.repeat(64)]:['col_2','col_1']});expect(recipient).toBe(fixtureId(17));
 const core=h.repository.exportWorkspaceCore();
 await act(async()=>{await wb.saveNavigation({kind:'reset'});});
 expect(wb.preferences?.values.navigation).toEqual({favorites:[],recent:[],startPage:'/overview'});
 expect(wb.preferences?.values.visual).toEqual({theme:'system',density:'comfortable',sidebar:'expanded'});
 expect(wb.preferences?.values.sorts).toEqual({});expect(wb.preferences?.values.rawTableColumns).toBeUndefined();
 expect(wb.preferences?.values.context).toEqual(context);expect(wb.preferences?.values.notificationPersonId).toEqual(recipient);
 expect(h.repository.exportWorkspaceCore()).toEqual(core);
});
