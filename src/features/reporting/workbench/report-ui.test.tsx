// @vitest-environment jsdom
import { afterEach, it, expect, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { WorkbenchProvider } from '../../../app/workbench/context';
import { createWorkbenchApiHarness } from '../../../app/workbench/testing/api-harness';
import { draftFixture, draftCleanups } from '../../../../tests/fixtures/workbench/drafts';
import { QueryRegistry } from '../../../server/workbench/query-registry';
import { loadMaturityMaterials } from '../../maturity/workbench-materials';
import { registerMaturityQueries } from '../../maturity/workbench-query';
import { createReportService } from './service';
import { registerReportCommands } from './commands';
import { registerReportQueries } from './queries';
import {defaultReportDefinition} from './contracts';
import {WorkbenchApiError} from '../../../app/workbench/api-client';
import { WorkbenchReportsPage } from './WorkbenchReportsPage';
const closes: Array<() => Promise<void>> = [];
afterEach(async () => { cleanup(); vi.restoreAllMocks(); for (const close of closes.splice(0))
    await close(); while (draftCleanups.length)
    await draftCleanups.pop()!(); });
it('edits sections, previews, saves and reopens through real command/query registries', async () => {
    const h = await createWorkbenchApiHarness({ role: 'curator', scenario: 'empty' });
    closes.push(h.close);
    const f = draftFixture(), materials = loadMaturityMaterials(), service = createReportService({ repository: f.repository, clock: f.clock, materials });
    registerReportCommands(f.registry, service);
    const queries = new QueryRegistry();
    registerReportQueries(queries, service);
    registerMaturityQueries(queries, { repository: f.repository, materials });
    const session = await h.client.session();
    vi.spyOn(h.client, 'session').mockResolvedValue({ ...session, data: { ...session.data, allowedCommands: [...session.data.allowedCommands, 'report.save'] } });
    const query = h.client.query.bind(h.client), command = h.client.command.bind(h.client);
    vi.spyOn(h.client, 'query').mockImplementation(async (name, input) => name.startsWith('reports.') || name === 'maturity.overview' ? { ...session, data: await queries.execute(name, input as any, f.context) } as any : query(name, input));
    vi.spyOn(h.client, 'command').mockImplementation(async (input) => input.name === 'report.save' ? { ...session, data: await f.registry.execute(input, { ...f.context, commandId: input.commandId }) } as any : command(input));
    const view = render(<WorkbenchProvider client={h.client}><WorkbenchReportsPage /></WorkbenchProvider>);
    fireEvent.change(await screen.findByLabelText('Название отчёта'), { target: { value: 'Наш отчёт' } });
    fireEvent.click(screen.getByRole('button', { name: 'Исключить Матрица команд и метрик' }));
    fireEvent.click(screen.getByRole('button', { name: 'Предпросмотр влияния' }));
    const preview = await screen.findByRole('region', { name: 'Предпросмотр отчёта' }).catch(() => screen.findByLabelText('Предпросмотр отчёта'));
    expect(preview.textContent).toContain('271 / 290');
    expect(within(preview).queryByText('Матрица команд и метрик')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить версию' }));
    await screen.findByText('Версия отчёта сохранена');
    expect(service.list(f.context)).toHaveLength(1);
    view.unmount();
    render(<WorkbenchProvider client={h.client}><WorkbenchReportsPage /></WorkbenchProvider>);
    fireEvent.click(await screen.findByRole('button', { name: 'Наш отчёт · v1' }));
    await waitFor(() => expect((screen.getByLabelText('Название отчёта') as HTMLInputElement).value).toBe('Наш отчёт'));
    expect(screen.queryByRole('button', { name: 'Исключить Матрица команд и метрик' })).toBeNull();
    expect(screen.getByRole('button', { name: 'PPTX' })).toBeTruthy();
});

it.each(['independent','section'] as const)('recovers two-window %s edits through the real registry without rewriting history',async(kind)=>{
 const h=await createWorkbenchApiHarness({role:'curator',scenario:'empty'});closes.push(h.close);const f=draftFixture(),materials=loadMaturityMaterials(),service=createReportService({repository:f.repository,clock:f.clock,materials});registerReportCommands(f.registry,service);const queries=new QueryRegistry();registerReportQueries(queries,service);registerMaturityQueries(queries,{repository:f.repository,materials});
 const base=defaultReportDefinition(materials.period),v1=await f.execute('report.save',{id:null,definition:base},{baseRevision:null}),id=String(v1.result.id);const session=await h.client.session();vi.spyOn(h.client,'session').mockResolvedValue({...session,data:{...session.data,allowedCommands:[...session.data.allowedCommands,'report.save']}});const query=h.client.query.bind(h.client),command=h.client.command.bind(h.client);
 vi.spyOn(h.client,'query').mockImplementation(async(name,input)=>name.startsWith('reports.')||name==='maturity.overview'?{...session,data:await queries.execute(name,input as any,f.context)} as any:query(name,input));
 vi.spyOn(h.client,'command').mockImplementation(async input=>{if(input.name!=='report.save')return command(input);try{return {...session,data:await f.registry.execute(input,{...f.context,commandId:input.commandId})} as any;}catch(e:any){throw new WorkbenchApiError({code:e.code,message:e.message,retryable:false,details:[],operationId:null,provider:null},e.statusCode??500,null);}});
 render(<WorkbenchProvider client={h.client}><WorkbenchReportsPage/></WorkbenchProvider>);fireEvent.click(await screen.findByRole('button',{name:base.title+' · v1'}));await waitFor(()=>expect(screen.getByText('Открыта версия 1')).toBeTruthy());
 fireEvent.change(kind==='independent'?screen.getByLabelText('Комментарий отчёта'):screen.getAllByLabelText('Заголовок раздела')[0],{target:{value:'B retained edit'}});
 const a=structuredClone(base);if(kind==='independent')a.title='A title';else a.sections[0].title='A section';await f.execute('report.save',{id,definition:a},{baseRevision:v1.editToken});
 fireEvent.click(screen.getByRole('button',{name:'Сохранить версию'}));await screen.findByRole('button',{name:'Загрузить текущую версию для сравнения'});expect((kind==='independent'?screen.getByLabelText('Комментарий отчёта'):screen.getAllByLabelText('Заголовок раздела')[0] as HTMLInputElement).getAttribute('value')??(screen.getByLabelText('Комментарий отчёта') as HTMLTextAreaElement).value).toBe('B retained edit');
 fireEvent.click(screen.getByRole('button',{name:'Загрузить текущую версию для сравнения'}));await screen.findByText('Сравнение с версией 2');if(kind==='section')fireEvent.click(screen.getByLabelText('Моё значение: Итоги · заголовок'));
 fireEvent.click(screen.getByRole('button',{name:'Применить проверенное объединение'}));fireEvent.click(screen.getByRole('button',{name:'Сохранить версию'}));await screen.findByText('Версия отчёта сохранена');expect(service.detail(f.context,id).revision).toBe(3);expect(service.detail(f.context,id,1).definition).toEqual(base);expect(service.detail(f.context,id,2).definition).toEqual(a);expect(service.detail(f.context,id).definition).toMatchObject(kind==='independent'?{title:'A title',comment:'B retained edit'}:{sections:[{title:'B retained edit'},{},{},{}]});
});
