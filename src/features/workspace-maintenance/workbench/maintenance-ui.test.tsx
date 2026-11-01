// @vitest-environment jsdom
import { File as NativeFile } from 'node:buffer';
import { beforeEach,afterEach,it,expect,vi } from 'vitest';
import { render,fireEvent,screen,waitFor,cleanup } from '@testing-library/react';
import { WorkbenchProvider } from '../../../app/workbench/context';
import { MaintenancePanel } from './MaintenancePanel';
import { createMaintenanceUiFixture } from './maintenance-ui-fixture';
import { fixtureId,makeEntityGraph,makeNumericFixture } from '../../../../tests/fixtures/workbench/factories';
import { seedGraph } from '../../../../tests/fixtures/workbench/repository';
const cleanups:Array<()=>Promise<void>>=[];
beforeEach(async()=>{sessionStorage.clear();const form=await new Response('',{headers:{'Content-Type':'application/x-www-form-urlencoded'}}).formData();vi.stubGlobal('FormData',form.constructor);vi.stubGlobal('Uint8Array',Object.getPrototypeOf(Buffer.prototype).constructor);});
afterEach(async()=>{cleanup();for(const close of cleanups.splice(0))await close();vi.unstubAllGlobals();vi.restoreAllMocks();});
async function open(){const h=await createMaintenanceUiFixture();cleanups.push(h.close);const view=render(<WorkbenchProvider client={h.client}><MaintenancePanel onClose={()=>{}} /></WorkbenchProvider>);await waitFor(()=>expect((screen.getByRole('button',{name:'Создать копию'}) as HTMLButtonElement).disabled).toBe(false));return {...h,view};}
async function archive(h:Awaited<ReturnType<typeof open>>){const backup=await h.maintenance.createBackup(h.context,{label:null,includeOriginals:true});return new NativeFile([await h.archiveBytes(backup.backupId)],'own-workspace.zip',{type:'application/zip'});}
async function preview(file:NativeFile){fireEvent.change(screen.getByLabelText('Архив рабочего места'),{target:{files:[file]}});fireEvent.click(screen.getByRole('button',{name:'Проверить архив'}));await screen.findByText('Проверенный архив',{}, {timeout:10000});}
it('rejects_stale_restore_without_losing_input',async()=>{
 const h=await open();await preview(await archive(h));h.put('Изменения после предпросмотра');
 fireEvent.click(screen.getByLabelText('Подтверждаю замену текущих данных архивом'));fireEvent.click(screen.getByRole('button',{name:'Заменить данные'}));
 expect((await screen.findByRole('alert',{}, {timeout:10000})).textContent).toContain('предпросмотр');expect(screen.getByText('own-workspace.zip')).toBeTruthy();expect(screen.getByRole('button',{name:'Проверить архив'})).toBeTruthy();expect(screen.queryByText('Восстановление завершено')).toBeNull();expect(h.activations()).toBe(0);expect(h.get()).toEqual([{value:'Изменения после предпросмотра'}]);
});
it('shows_rescue_before_replace and keeps the real same job after reopening',async()=>{
 const h=await open(),file=await archive(h);h.put('Новые данные для rescue');await preview(file);
 expect(screen.getByText(/До замены будет создана проверенная защитная копия/)).toBeTruthy();expect((screen.getByRole('button',{name:'Заменить данные'}) as HTMLButtonElement).disabled).toBe(true);
 fireEvent.click(screen.getByLabelText('Подтверждаю замену текущих данных архивом'));screen.getByRole('button',{name:'Заменить данные'}).focus();fireEvent.click(screen.getByRole('button',{name:'Заменить данные'}));
 await screen.findByText('Восстановление завершено',{}, {timeout:10000});expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);const rescue=screen.getByRole('link',{name:'Скачать защитную копию'});expect(rescue.getAttribute('href')).toMatch(/^\/api\/v1\/backups\/[a-f0-9-]+\/file$/);
 const response=await h.fetch(rescue.getAttribute('href')!);expect(response.status).toBe(200);expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);expect(h.get()).toEqual([{value:'Исходные личные данные'}]);
 const apply=h.requests.find(r=>r.body?.name==='backup.restore.apply')!.body!,job=h.jobs.findByCommand(String(apply.commandId),h.context.installationId)!;expect(job.status).toBe('succeeded');
 h.view.unmount();await h.restart();render(<WorkbenchProvider client={h.client}><MaintenancePanel onClose={()=>{}} /></WorkbenchProvider>);await screen.findByText('Восстановление завершено',{}, {timeout:10000});expect(h.requests.filter(r=>r.body?.name==='backup.restore.apply')).toHaveLength(1);expect(screen.getByText(job.jobId,{exact:false})).toBeTruthy();
});
it('reader_applies_verified_main_without_rest_timestamp preserving personal data',async()=>{
 const h=await open(),before=h.get();seedGraph(h.deps.repository,makeEntityGraph(makeNumericFixture({scope:{kind:'dit',id:fixtureId(101)}})));const history=h.deps.repository.exportWorkspaceCore();h.preferences.backup.restore({schemaVersion:1,values:{context:null,sorts:{},visual:{theme:'dark',density:'compact'},notificationPersonId:null}});const preferences=h.preferences.get(h.context.installationId);fireEvent.click(screen.getByRole('button',{name:'Проверить обновление main'}));await screen.findByRole('button',{name:'Применить проверенный main'}, {timeout:10000});fireEvent.click(screen.getByRole('button',{name:'Применить проверенный main'}));
 await screen.findByText('Проверенный main применён',{}, {timeout:10000});expect(screen.getByText('Дата принятия в Bitbucket неизвестна')).toBeTruthy();expect(h.get()).toEqual(before);expect(h.deps.repository.exportWorkspaceCore()).toEqual(history);expect(h.preferences.get(h.context.installationId)).toEqual(preferences);expect((await h.client.session()).data.role).toBe('viewer');
});
it('creates a complete backup by default and only omits originals after an explicit choice',async()=>{
 const h=await open();await h.addFile('original',Buffer.from('synthetic original'));fireEvent.click(screen.getByRole('button',{name:'Создать копию'}));await screen.findByText('Копия создана',{}, {timeout:10000});expect(h.requests.find(r=>r.body?.name==='backup.create')?.body?.payload).toMatchObject({includeOriginals:true});
 fireEvent.click(screen.getByLabelText('Создать неполную копию без исходных файлов'));expect(screen.getByText(/Исходные файлы не войдут/)).toBeTruthy();fireEvent.click(screen.getByRole('button',{name:'Создать копию'}));await waitFor(()=>expect(h.requests.filter(r=>r.body?.name==='backup.create')).toHaveLength(2));await screen.findByText('В архив не включены исходные файлы',{}, {timeout:10000});
});
it('blocks writes on RECOVERY_REQUIRED and retains the selected archive',async()=>{
 const h=await open();await preview(await archive(h));h.deps.workspace!.healthcheck=async()=>{throw Error('Synthetic healthcheck failure');};h.deps.workspace!.rollback=async()=>{throw Error('Synthetic rollback failure');};
 fireEvent.click(screen.getByLabelText('Подтверждаю замену текущих данных архивом'));fireEvent.click(screen.getByRole('button',{name:'Заменить данные'}));await screen.findByText(/Запись заблокирована: требуется безопасное восстановление/,{}, {timeout:10000});expect(h.frozen()).toBe(true);expect((screen.getByRole('button',{name:'Создать копию'}) as HTMLButtonElement).disabled).toBe(true);expect(screen.getByText('own-workspace.zip')).toBeTruthy();expect(screen.queryByText('Восстановление завершено')).toBeNull();
});
it('reconciles a lost accepted response without creating another backup',async()=>{
 const h=await open(),send=h.client.command.bind(h.client);vi.spyOn(h.client,'command').mockImplementation(async request=>{const result=await send(request);if(request.name==='backup.create')throw Error('Response lost after actual acceptance');return result;});fireEvent.click(screen.getByRole('button',{name:'Создать копию'}));await screen.findByText(/Результат операции неизвестен/);expect((screen.getByRole('button',{name:'Создать копию'}) as HTMLButtonElement).disabled).toBe(true);fireEvent.click(screen.getByRole('button',{name:'Проверить сохранённую операцию'}));await screen.findByText('Копия создана',{}, {timeout:10000});expect(h.requests.filter(r=>r.body?.name==='backup.create')).toHaveLength(1);
});
it('refreshes the same known running job after one lost GET without another mutation',async()=>{
 const h=await open();let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;}),files=h.deps.workspace!.files.bind(h.deps.workspace),read=h.client.job.bind(h.client);let lost=false,jobId='';
 h.deps.workspace!.files=async records=>{await held;return files(records);};
 vi.spyOn(h.client,'job').mockImplementation(async id=>{const response=await read(id);if(!lost){expect(response.data.status).toBe('running');lost=true;jobId=id;throw Error('One actual job GET response lost');}return response;});
 try {
  fireEvent.click(screen.getByRole('button',{name:'Создать копию'}));await screen.findByRole('alert');const refresh=screen.getByRole('button',{name:'Обновить состояние операции'});expect((screen.getByRole('button',{name:'Создать копию'}) as HTMLButtonElement).disabled).toBe(true);
  release();await h.commands.idle();expect(h.jobs.get(jobId,h.context.installationId)?.status).toBe('succeeded');expect(screen.queryByText('Копия создана')).toBeNull();
  refresh.focus();fireEvent.click(refresh);await screen.findByText('Копия создана',{}, {timeout:10000});expect(document.activeElement).toBe(refresh);expect(screen.queryByRole('alert')).toBeNull();expect(screen.getByText(jobId,{exact:false})).toBeTruthy();expect(h.requests.filter(request=>request.body?.name==='backup.create')).toHaveLength(1);expect(h.requests.filter(request=>request.url==='/api/v1/commands')).toHaveLength(1);
  expect((await h.fetch(screen.getByRole('link',{name:'Скачать созданную копию'}).getAttribute('href')!)).status).toBe(200);
 }finally{release();}
});
