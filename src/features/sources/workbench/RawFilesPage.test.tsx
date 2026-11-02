// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WorkbenchProvider } from '../../../app/workbench/context';
import { createWorkbenchApiHarness } from '../../../app/workbench/testing/api-harness';
import { RawFilesPage } from './RawFilesPage';
import type { CommandRequest } from '../../../server/workbench/protocol';

const closes:Array<()=>Promise<void>>=[];
afterEach(async()=>{cleanup();vi.restoreAllMocks();for(const close of closes.splice(0))await close();window.history.replaceState(null,'','/');});

it.each(['not_found','interrupted','completed','pending'] as const)('recovers raw manual %s without silently resubmitting or dropping inputs',async(status)=>{
 const h=await createWorkbenchApiHarness({role:'viewer',scenario:'empty'});closes.push(h.close);
 const base=await h.client.session();
 vi.spyOn(h.client,'session').mockResolvedValue({...base,data:{...base.data,allowedCommands:[...base.data.allowedCommands,'raw.capture.manual']}});
 const originalQuery=h.client.query.bind(h.client);let failRead=false;
 vi.spyOn(h.client,'query').mockImplementation(async(name,input)=>{
  if(name==='raw.files.list'){if(failRead)throw Error('readback failed');return {...base,data:{items:[],page:{limit:50,total:0,nextCursor:null,hasMore:false},hiddenCount:0}} as any;}
  return originalQuery(name,input);
 });
 const attempts:CommandRequest[]=[];
 vi.spyOn(h.client,'command').mockImplementation(async request=>{attempts.push(request);if(attempts.length===1)throw Error('transport lost');return {...base,data:{commandId:request.commandId,result:{},changedRefs:[],editToken:null}} as any;});
 vi.spyOn(h.client,'reconcileCommand').mockImplementation(async commandId=>({...base,data:{commandId,name:'raw.capture.manual',status,job:null,result:null}}));
 render(<WorkbenchProvider client={h.client}><RawFilesPage/></WorkbenchProvider>);
 fireEvent.click(await screen.findByRole('button',{name:'Ввести таблицу'}));fireEvent.change(screen.getByLabelText('Название'),{target:{value:'Моя таблица'}});fireEvent.change(screen.getByLabelText('Столбцы и строки'),{target:{value:'A\n1'}});fireEvent.click(screen.getByRole('button',{name:'Сохранить исходную таблицу'}));
 const check=await screen.findByRole('button',{name:'Проверить сохранение файла'});
 if(status==='completed'||status==='interrupted')failRead=true;
 fireEvent.click(check);
 if(status==='not_found'){
  const retry=await screen.findByRole('button',{name:'Повторить исходное сохранение файла'});expect(attempts).toHaveLength(1);fireEvent.click(retry);
  await waitFor(()=>expect(attempts).toHaveLength(2));expect(attempts[1]).toEqual(attempts[0]);await waitFor(()=>expect(screen.queryByLabelText('Название')).toBeNull());
 }else if(status==='pending'){
  await screen.findByText(/ещё выполняется/);expect(attempts).toHaveLength(1);expect((screen.getByRole('button',{name:'Сохранить исходную таблицу'}) as HTMLButtonElement).disabled).toBe(true);
 }else{
  await screen.findByText(/Результат операции неизвестен/);expect((screen.getByLabelText('Название') as HTMLInputElement).value).toBe('Моя таблица');failRead=false;fireEvent.click(screen.getByRole('button',{name:'Проверить сохранение файла'}));
  if(status==='completed')await waitFor(()=>expect(screen.queryByLabelText('Название')).toBeNull());
  else{await screen.findByText(/прервано/);expect((screen.getByRole('button',{name:'Сохранить исходную таблицу'}) as HTMLButtonElement).disabled).toBe(false);expect((screen.getByLabelText('Название') as HTMLInputElement).value).toBe('Моя таблица');fireEvent.click(screen.getByRole('button',{name:'Сохранить исходную таблицу'}));await waitFor(()=>expect(attempts).toHaveLength(2));expect(attempts[1].commandId).not.toBe(attempts[0].commandId);}
 }
});
