// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WorkbenchProvider } from './context';
import { QuickNavigation } from './QuickNavigation';
import { WorkbenchClient } from './api-client';
import { createWorkbenchApiHarness } from './testing/api-harness';
import { draftFixture, draftCleanups } from '../../../tests/fixtures/workbench/drafts';
import { fixtureId } from '../../../tests/fixtures/workbench/factories';
import { createReportService } from '../../features/reporting/workbench/service';
import { registerReportCommands } from '../../features/reporting/workbench/commands';
import { registerReportQueries } from '../../features/reporting/workbench/queries';
import { defaultReportDefinition } from '../../features/reporting/workbench/contracts';
import { loadMaturityMaterials } from '../../features/maturity/workbench-materials';
import { QueryRegistry } from '../../server/workbench/query-registry';
import type { PreferencesRead } from '../../features/system/workbench-preferences-query';

const closes:Array<()=>Promise<void>>=[];
afterEach(async()=>{cleanup();vi.restoreAllMocks();for(const close of closes.splice(0))await close();for(const close of draftCleanups.splice(0))await close();window.history.replaceState(null,'','/');});
const request={context:null,filter:{},sort:[],page:{limit:50,cursor:null}};

it('keeps stale objects visible and removable without querying private reports for a viewer',async()=>{
 const h=await createWorkbenchApiHarness({role:'viewer',scenario:'empty'});closes.push(h.close);await h.client.session();
 const initial=(await h.client.query<PreferencesRead>('preferences.get',request)).data;
 await h.client.command({commandId:crypto.randomUUID(),name:'preferences.set',baseRevision:initial.editToken,payload:{values:{...initial.values,navigation:{favorites:[{kind:'report',id:fixtureId(99801),revision:1},{kind:'team',id:fixtureId(99802)},'/data'],recent:[],startPage:'/overview'}}}});
 render(<WorkbenchProvider client={h.client}><QuickNavigation onClose={()=>{}}/></WorkbenchProvider>);
 const missing=await screen.findByRole('button',{name:'Отчёт недоступен · '+fixtureId(99801)+' · v1'});
 expect(missing.getAttribute('aria-disabled')).toBe('true');const current=window.location.href;fireEvent.click(missing);expect(window.location.href).toBe(current);
 expect(h.requests.some(entry=>entry.url.endsWith('/queries/reports.detail'))).toBe(false);
 fireEvent.click(screen.getByRole('button',{name:'Убрать из избранного: Отчёт недоступен · '+fixtureId(99801)+' · v1'}));
 await waitFor(()=>expect(screen.queryByRole('button',{name:'Отчёт недоступен · '+fixtureId(99801)+' · v1'})).toBeNull());
 expect((await h.client.query<PreferencesRead>('preferences.get',request)).data.values.navigation?.favorites).toEqual([{kind:'team',id:fixtureId(99802)},'/data']);
});

it('discards a late authorized report title after changing clients and never reveals the foreign report title',async()=>{
 const a=await createWorkbenchApiHarness({role:'curator',scenario:'empty'}),b=await createWorkbenchApiHarness({role:'curator',scenario:'empty'});closes.push(a.close,b.close);
 const f=draftFixture(),materials=loadMaturityMaterials(),service=createReportService({repository:f.repository,clock:f.clock,materials});registerReportCommands(f.registry,service);
 const queries=new QueryRegistry();registerReportQueries(queries,service);
 const saved=await f.execute('report.save',{id:null,definition:{...defaultReportDefinition(materials.period),title:'Private report title from the old owner'}},{baseRevision:null});
 const id=String(saved.result.id);
 let release!:()=>void,started!:()=>void;const gate=new Promise<void>(r=>release=r),reading=new Promise<void>(r=>started=r);
 for(const [h,foreign] of [[a,false],[b,true]] as const){
  const session=await h.client.session();vi.spyOn(h.client,'session').mockResolvedValue({...session,data:{...session.data,allowedCommands:[...session.data.allowedCommands,'report.save']}});
  const initial=(await h.client.query<PreferencesRead>('preferences.get',request)).data;
  await h.client.command({commandId:crypto.randomUUID(),name:'preferences.set',baseRevision:initial.editToken,payload:{values:{...initial.values,navigation:{favorites:[{kind:'report',id,revision:1}],recent:[],startPage:'/overview'}}}});
  const query=h.client.query.bind(h.client);
  vi.spyOn(h.client,'query').mockImplementation(async(name,input,options)=>{
   if(name!=='reports.detail')return query(name,input,options);
   const context=foreign?{...f.context,installationId:fixtureId(99901),ownAccess:{...f.context.ownAccess,personId:fixtureId(99902)}}:f.context;
   const data=await queries.execute(name,input as never,context);
   if(!foreign){started();await gate;}
   return {...session,data} as never;
  });
 }
 const view=render(<WorkbenchProvider client={a.client}><QuickNavigation onClose={()=>{}}/></WorkbenchProvider>);await reading;
 view.rerender(<WorkbenchProvider client={b.client}><QuickNavigation onClose={()=>{}}/></WorkbenchProvider>);
 await waitFor(()=>expect(b.requests.filter(entry=>entry.url.endsWith('/queries/preferences.get')).length).toBeGreaterThan(1));
 await act(async()=>{release();});
 await screen.findByRole('button',{name:'Отчёт недоступен · '+id+' · v1'});
 expect(screen.queryByText(/Private report title/)).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Убрать из избранного: Отчёт недоступен · '+id+' · v1'}));
 await waitFor(()=>expect(screen.queryByRole('button',{name:'Отчёт недоступен · '+id+' · v1'})).toBeNull());
 expect(service.detail(f.context,id,1).definition.title).toBe('Private report title from the old owner');
});

it('does not restore an old save focus after changing the client identity',async()=>{
 const a=await createWorkbenchApiHarness({role:'viewer',scenario:'empty'}),b=await createWorkbenchApiHarness({role:'viewer',scenario:'empty'});closes.push(a.close,b.close);
 let release!:()=>void,started!:()=>void;const gate=new Promise<void>(r=>release=r),sent=new Promise<void>(r=>started=r);
 const client=new WorkbenchClient({fetch:async(input,init)=>{const response=await a.fetch(input,init);if(String(input).endsWith('/commands')){started();await gate;}return response;}});
 const view=render(<WorkbenchProvider client={client}><QuickNavigation onClose={()=>{}}/></WorkbenchProvider>);
 const star=await screen.findByRole('button',{name:'В избранное: Данные'});await waitFor(()=>expect(a.requests.some(entry=>entry.url.endsWith('/queries/preferences.get'))).toBe(true));
 star.focus();fireEvent.click(star);await sent;
 view.rerender(<WorkbenchProvider client={b.client}><QuickNavigation onClose={()=>{}}/></WorkbenchProvider>);
 await waitFor(()=>expect(b.requests.some(entry=>entry.url.endsWith('/queries/preferences.get'))).toBe(true));
 await waitFor(()=>expect((screen.getByRole('button',{name:'В избранное: Данные'}) as HTMLButtonElement).disabled).toBe(false));
 // JSDOM does not implement Chromium's automatic blur of a disabled button.
 const currentInput=screen.getByRole('searchbox',{name:'Найти раздел'});currentInput.focus();currentInput.blur();
 expect(document.activeElement).toBe(document.body);
 await act(async()=>{release();});
 expect(document.activeElement).toBe(document.body);
 expect((await b.client.query<PreferencesRead>('preferences.get',request)).data.values.navigation?.favorites).toEqual([]);
});
