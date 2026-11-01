// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { createWorkbenchUiHarness } from '../../../app/workbench/testing/ui-harness';
import { WorkbenchCuratorPanel } from './CuratorPanel';
const cleanups:Array<()=>Promise<void>>=[];
afterEach(async()=>{vi.restoreAllMocks();cleanup();for(const close of cleanups.splice(0))await close();});
async function open(role:'curator'|'chief'|'viewer'='curator',scenario:'publication-ready'|'offline-draft'='publication-ready'){
 const h=await createWorkbenchUiHarness({role,scenario},{views:{uor:WorkbenchCuratorPanel}});cleanups.push(h.close);await h.open('/uor');return h;
}
async function preview(){fireEvent.click(await screen.findByRole('button',{name:'Проверить пакет'}));await screen.findByText('Предварительный просмотр · редакция 1',{}, {timeout:10000});}
async function submit(){const button=screen.getByRole('button',{name:'Отправить пакет в Bitbucket'});await waitFor(()=>expect((button as HTMLButtonElement).disabled).toBe(false));fireEvent.click(button);}
it('shows_git_pushed_pr_auth_pending and retries the same real job without a second PR',async()=>{
 const h=await open();await preview();await submit();
 expect(await screen.findByText('Коммиты отправлены, PR ожидает входа',{}, {timeout:10000})).toBeTruthy();
 expect(h.publishingTesting!.counts()).toMatchObject({commits:1,pushes:1,creates:0});
 expect(screen.queryByLabelText(/пароль/i)).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Открыть штатный вход'}));
 await waitFor(()=>expect(h.publishingTesting!.counts().authOpens).toBe(1));
 expect(h.publishingTesting!.counts().creates).toBe(0);
 await waitFor(()=>expect((screen.getByRole('button',{name:'Повторить операцию'}) as HTMLButtonElement).disabled).toBe(false));
 fireEvent.click(screen.getByRole('button',{name:'Повторить операцию'}));
 expect(await screen.findByRole('link',{name:'Открыть PR в Bitbucket'},{timeout:10000})).toBeTruthy();
 expect(h.publishingTesting!.counts()).toMatchObject({commits:1,pushes:1,creates:1});expect((screen.getByLabelText('Собственные пакеты') as HTMLSelectElement).selectedOptions[0].textContent).toContain('PR открыт');
 const submits=h.requests.filter(r=>r.body?.name==='package.submit');expect(submits).toHaveLength(1);
});
it('keeps_commits_after_auth_cancel without interpreting closed auth as success',async()=>{
 const h=await open();h.publishingTesting!.authCompletes=false;await preview();await submit();
 await screen.findByText('Коммиты отправлены, PR ожидает входа',{}, {timeout:10000});
 fireEvent.click(screen.getByRole('button',{name:'Открыть штатный вход'}));
 await waitFor(()=>expect(h.publishingTesting!.counts().authOpens).toBe(1));
 expect(screen.getByText('Коммиты отправлены, PR ожидает входа')).toBeTruthy();expect(screen.queryByRole('link',{name:'Открыть PR в Bitbucket'})).toBeNull();
 expect(screen.queryByRole('button',{name:'Отменить операцию'})).toBeNull();expect(h.publishingTesting!.counts()).toMatchObject({commits:1,pushes:1,creates:0});
});
it('chief_has_same_panel_and_no_merge_action',async()=>{
 await open('chief');await preview();expect(screen.getByRole('button',{name:'Отправить пакет в Bitbucket'})).toBeTruthy();expect(screen.queryByRole('button',{name:'Слить в main'})).toBeNull();
});
it('retains an offline own draft but disables external submission',async()=>{
 const h=await open('curator','offline-draft');await preview();expect(screen.getByText(/Без связи/)).toBeTruthy();expect((screen.getByRole('button',{name:'Отправить пакет в Bitbucket'}) as HTMLButtonElement).disabled).toBe(true);expect(h.publishingTesting!.counts().pushes).toBe(0);
});
it('fresh policy revoke refuses write and retains the own draft',async()=>{
 const h=await open();await preview();h.publishingTesting!.revoke();await submit();
 await screen.findByRole('alert');expect(h.publishingTesting!.counts()).toMatchObject({commits:0,pushes:0,creates:0});expect(screen.getAllByText('Пояснение к накопленному пакету').length).toBeGreaterThan(0);
});
it('viewer cannot open the preparation panel',async()=>{
 await open('viewer');await screen.findByText(/Панель УОР доступна/);expect(screen.queryByRole('button',{name:'Проверить пакет'})).toBeNull();
});

it('invalidates a preview on actual main drift without writing remotely',async()=>{
 const h=await open();await preview();h.publishingTesting!.driftMain();await submit();await screen.findByText(/PREVIEW_STALE/,{exact:false},{timeout:10000});await waitFor(()=>expect((screen.getByRole('button',{name:'Проверить пакет'}) as HTMLButtonElement).disabled).toBe(false));expect((screen.getByRole('button',{name:'Отправить пакет в Bitbucket'}) as HTMLButtonElement).disabled).toBe(true);expect(h.publishingTesting!.counts()).toMatchObject({commits:0,pushes:0,creates:0});
});
it('can select an own package beyond the actual first page without opening a replacement draft',async()=>{
 const h=await createWorkbenchUiHarness({role:'curator',scenario:'publication-ready'},{views:{uor:WorkbenchCuratorPanel}});cleanups.push(h.close);await h.client.session();
 for(let index=0;index<51;index++)await h.client.command({commandId:crypto.randomUUID(),name:'draft.open',baseRevision:null,payload:{entityType:'work',ref:null,packageId:null}});
 const context=(await h.client.session()).data.defaultContext!,query={context,filter:{},sort:[],page:{limit:50,cursor:null as string|null}};
 const first=await h.client.query<import('../../catalog/workbench-read-models').WorkbenchReadModels['uor.queue']>('uor.queue',query);
 const next=await h.client.query<import('../../catalog/workbench-read-models').WorkbenchReadModels['uor.queue']>('uor.queue',{...query,page:{limit:50,cursor:first.data.page.nextCursor}});const target=next.data.items[0].packageRef.id;
 await h.open('/uor');fireEvent.click(await screen.findByRole('button',{name:'Показать ещё пакеты'}));
 await waitFor(()=>expect((screen.getByLabelText('Собственные пакеты') as HTMLSelectElement).querySelector(`option[value="${target}"]`)).toBeTruthy());
 fireEvent.change(screen.getByLabelText('Собственные пакеты'),{target:{value:target}});await screen.findByText('Накопленный пакет');
 expect(h.requests.filter(r=>r.body?.name==='draft.open')).toHaveLength(51);expect(h.publishingTesting!.counts().pushes).toBe(0);
});
it('zone filter never changes package composition or submits a new operation',async()=>{
 const h=await open();await preview();const before=h.requests.filter(r=>r.body?.name==='package.preview').length;
 fireEvent.change(screen.getByLabelText('Зона просмотра'),{target:{value:'context'}});expect(screen.getByText('Фильтр меняет только просмотр. Проверяется и отправляется весь пакет.')).toBeTruthy();expect(h.requests.filter(r=>r.body?.name==='package.preview')).toHaveLength(before);expect(h.publishingTesting!.counts().pushes).toBe(0);
});

it('does not issue a new submit identity after a lost accepted HTTP response',async()=>{
 const h=await open();await preview();const command=h.client.command.bind(h.client);let lost=false;
 vi.spyOn(h.client,'command').mockImplementation(async request=>{const result=await command(request);if(request.name==='package.submit'&&!lost){lost=true;throw Error('Synthetic lost response after acceptance');}return result;});
 await submit();await screen.findByRole('button',{name:'Проверить результат запроса'});fireEvent.click(screen.getByRole('button',{name:'Проверить результат запроса'}));
 await screen.findByText('Коммиты отправлены, PR ожидает входа',{}, {timeout:10000});
 const attempts=h.requests.filter(r=>r.body?.name==='package.submit');expect(attempts).toHaveLength(2);expect(new Set(attempts.map(r=>r.body?.commandId)).size).toBe(1);expect(h.publishingTesting!.counts()).toMatchObject({commits:1,pushes:1,creates:0});
});
it('disables an expired exact preview locally and leaves the package intact',async()=>{
 const h=await open();await preview();const now=Date.now();vi.spyOn(Date,'now').mockImplementation(()=>now+31*60*1000);
 fireEvent.change(screen.getByLabelText('Зона просмотра'),{target:{value:'context'}});expect(screen.getByText('Предварительный просмотр устарел. Проверьте пакет заново.')).toBeTruthy();expect((screen.getByRole('button',{name:'Отправить пакет в Bitbucket'}) as HTMLButtonElement).disabled).toBe(true);expect(h.publishingTesting!.counts().pushes).toBe(0);
});
it('refreshes an external merge without creating another PR',async()=>{
 const h=await open();h.publishingTesting!.requireRestAuth=false;await preview();await submit();await screen.findByRole('link',{name:'Открыть PR в Bitbucket'},{timeout:10000});
 const pkg=(await h.client.query<import('../../catalog/workbench-read-models').WorkbenchReadModels['uor.queue']>('uor.queue',{context:(await h.client.session()).data.defaultContext!,filter:{},sort:[],page:{limit:50,cursor:null}})).data.items[0];
 h.publishingTesting!.provider.testing.setState(pkg.publication!.proposal!,'merged');fireEvent.click(screen.getByRole('button',{name:'Проверить состояние PR'}));
 await screen.findByText(/PR принят во внешнем Bitbucket/,{exact:false},{timeout:10000});expect(h.publishingTesting!.counts()).toMatchObject({commits:1,pushes:1,creates:1});expect((screen.getByLabelText('Собственные пакеты') as HTMLSelectElement).selectedOptions[0].textContent).toContain('Принят');expect(screen.queryByRole('button',{name:'Слить в main'})).toBeNull();
});
it('lists empty and incomplete owned packages with leader links and no publication preparation',async()=>{
 const h=await open();for(const entityType of ['work','source_definition'])await h.client.command({commandId:crypto.randomUUID(),name:'draft.open',baseRevision:null,payload:{entityType,ref:null,packageId:null}});
 const context=(await h.client.session()).data.defaultContext!,query={context,filter:{},sort:[],page:{limit:50,cursor:null}};
 const queue=(await h.client.query<import('../../catalog/workbench-read-models').WorkbenchReadModels['uor.queue']>('uor.queue',query)).data;
 expect(queue.items).toHaveLength(3);
 for(const item of queue.items){const own=(await h.client.query<import('../../catalog/workbench-read-models').WorkbenchReadModels['uor.package']>('uor.package',{...query,filter:{packageRef:item.packageRef}})).data;expect(own.summary.delivery).toBeNull();expect(own.entries.length).toBeGreaterThan(0);}
 expect(queue.items.filter(item=>item.publication===null)).toHaveLength(3);
});
it('creates and resumes a private goal in the selected package without a published goal route',async()=>{
 const h=await open();await screen.findByRole('button',{name:'Проверить пакет'});const context=(await h.client.session()).data.defaultContext!;
 const initial=(await h.client.query<import('../../catalog/workbench-read-models').WorkbenchReadModels['uor.queue']>('uor.queue',{context,filter:{},sort:[],page:{limit:50,cursor:null}})).data.items[0].packageRef;
 fireEvent.click(screen.getByRole('button',{name:'Создать цель'}));const title=await screen.findByLabelText('Название цели');fireEvent.change(title,{target:{value:'Новая цель из панели'}});
 fireEvent.click(screen.getByRole('button',{name:'Сохранить черновик'}));await screen.findByText('Черновик сохранён');fireEvent.click(screen.getByRole('button',{name:'Закрыть настройку'}));
 fireEvent.click(await screen.findByRole('button',{name:'Продолжить настройку: Новая цель из панели'}));await waitFor(()=>expect((screen.getByLabelText('Название цели') as HTMLInputElement).value).toBe('Новая цель из панели'));
 const queue=(await h.client.query<import('../../catalog/workbench-read-models').WorkbenchReadModels['uor.queue']>('uor.queue',{context,filter:{},sort:[],page:{limit:50,cursor:null}})).data;expect(queue.items).toHaveLength(1);expect(queue.items[0].packageRef).toEqual(initial);
 expect(window.location.pathname).toBe('/uor');const opens=h.requests.filter(r=>r.body?.name==='draft.open');expect(opens.every(r=>(r.body?.payload as {packageId?:string}).packageId===initial.id)).toBe(true);
 expect(h.requests.filter(r=>r.url.endsWith('/goals.detail')).every(r=>(r.body?.context as {goalId?:string})?.goalId===h.refs.goal.id)).toBe(true);
});

it('offers the constructor with a published organization catalog and zero published goals',async()=>{
 const h=await createWorkbenchUiHarness({role:'curator',scenario:'organization-only'},{views:{uor:WorkbenchCuratorPanel}});cleanups.push(h.close);
 expect(h.repository.exportWorkspaceCore().filter(row=>row.entityType==='core_goal_definition')).toHaveLength(0);await h.open('/uor');fireEvent.click(await screen.findByRole('button',{name:'Создать цель'}));await screen.findByLabelText('Название цели');expect(window.location.pathname).toBe('/uor');
});


it('retains accepted command identity when its first job read is unavailable',async()=>{
 const h=await open();await preview();const job=h.client.job.bind(h.client);let unavailable=true;
 vi.spyOn(h.client,'job').mockImplementation(async id=>{if(unavailable){unavailable=false;throw Error('Synthetic job read outage');}return job(id);});
 await submit();fireEvent.click(await screen.findByRole('button',{name:'Проверить результат запроса'}));await screen.findByText('Коммиты отправлены, PR ожидает входа',{}, {timeout:10000});const attempts=h.requests.filter(r=>r.body?.name==='package.submit');expect(attempts).toHaveLength(2);expect(new Set(attempts.map(r=>r.body?.commandId)).size).toBe(1);expect(h.publishingTesting!.counts()).toMatchObject({commits:1,pushes:1,creates:0});
});


it('refreshes the known operation after polling failed and the preview completed meanwhile',async()=>{
 const h=await open(),release=h.publishingTesting!.holdMain(),job=h.client.job.bind(h.client);let reads=0;
 vi.spyOn(h.client,'job').mockImplementation(async id=>{reads++;if(reads===2)throw Error('Synthetic polling outage');return job(id);});
 try{fireEvent.click(await screen.findByRole('button',{name:'Проверить пакет'}));await screen.findByRole('alert');}finally{release();}
 await h.publishingTesting!.commands.idle();fireEvent.click(screen.getByRole('button',{name:'Обновить состояние пакета'}));await screen.findByText('Предварительный просмотр · редакция 1',{}, {timeout:2000});
 expect(h.requests.filter(r=>r.body?.name==='package.preview')).toHaveLength(1);
});
it('observes live native Git login through completion without an additional UI command',async()=>{
 const h=await open();h.publishingTesting!.requireRestAuth=false;const native=h.publishingTesting!.holdGitAuth();
 try{
  await preview();await submit();await native.waiting;
  await screen.findByText('Требуется штатный вход Git');
  expect(screen.queryByRole('button',{name:'Повторить операцию'})).toBeNull();
  expect(screen.queryByRole('button',{name:'Открыть штатный вход'})).toBeNull();
  const submitted=h.requests.find(r=>r.body?.name==='package.submit')!;
  const waiting=h.publishingTesting!.jobs.findByCommand(String(submitted.body!.commandId),'00000000-0000-4000-8000-000000000001');
  expect(waiting).toMatchObject({status:'waiting_user',stage:'git.auth',retryAvailable:false,nextAction:null});
  native.complete();
  await screen.findByRole('link',{name:'Открыть PR в Bitbucket'},{timeout:4000});
  expect(screen.queryByText('Требуется штатный вход Git')).toBeNull();
  expect(screen.queryByRole('button',{name:'Отменить операцию'})).toBeNull();
  expect(h.publishingTesting!.jobs.findByCommand(String(submitted.body!.commandId),'00000000-0000-4000-8000-000000000001')).toMatchObject({jobId:waiting!.jobId,status:'succeeded'});
  expect(h.publishingTesting!.counts()).toMatchObject({commits:1,pushes:1,creates:1,authOpens:0});
  expect(h.requests.filter(r=>typeof r.body?.name==='string'&&['package.submit','job.retry','job.openAuth'].includes(r.body.name))).toHaveLength(1);
 }finally{native.complete();await h.publishingTesting!.commands.idle();}
});

it('does not call a pending queue read an empty package list',async()=>{
 const h=await createWorkbenchUiHarness({role:'curator',scenario:'publication-ready'},{views:{uor:WorkbenchCuratorPanel}});cleanups.push(h.close);
 const query=h.client.query.bind(h.client);let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
 vi.spyOn(h.client,'query').mockImplementation(async(name,input,options)=>{if(name==='uor.queue')await gate;return query(name,input,options);});
 await h.open('/uor');await screen.findByText('Загружаем собственные пакеты…');
 expect(screen.queryByText('Накопленных пакетов пока нет. Сохраните изменения в карточке цели или в исполнении.')).toBeNull();
 release();await screen.findByRole('button',{name:'Проверить пакет'});
 expect(screen.queryByText('Загружаем собственные пакеты…')).toBeNull();
});
