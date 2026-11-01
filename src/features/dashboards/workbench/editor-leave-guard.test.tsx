// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { createWorkbenchUiHarness } from '../../../app/workbench/testing/ui-harness';
import { useUnsavedChanges } from '../../../app/workbench/use-unsaved-changes';
import { DashboardBuilder } from './DashboardBuilder';
import { CustomFieldsPanel } from './CustomFieldEditor';
import { fixtureId } from '../../../../tests/fixtures/workbench/factories';

const closes:Array<()=>Promise<void>>=[];
afterEach(async()=>{cleanup();for(const close of closes.splice(0))await close();vi.restoreAllMocks();window.history.replaceState(null,'','/');});
async function open(Page:()=>React.JSX.Element){const h=await createWorkbenchUiHarness({role:'curator',scenario:'scope-split'},{views:{overview:Page}});closes.push(h.close);await h.open('/overview');return h;}
function Builder(){const [visible,setVisible]=useState(true),[dirty,setDirty]=useState(false);const leave=useUnsavedChanges(dirty);return visible?<><button onClick={()=>leave(()=>setVisible(false))}>Закрыть тестовый конструктор</button><DashboardBuilder onDirtyChange={setDirty}/></>:<p>Конструктор закрыт</p>;}
it('keeps a changed dashboard after cancelled close and clears the parent guard only after save',async()=>{
 await open(Builder);const confirm=vi.spyOn(window,'confirm').mockReturnValue(false);
 fireEvent.change(await screen.findByLabelText('Название дашборда'),{target:{value:'Рабочий обзор'}});
 await waitFor(()=>expect((screen.getByRole('button',{name:'Добавить блок'}) as HTMLButtonElement).disabled).toBe(false));
 fireEvent.click(screen.getByRole('button',{name:'Добавить блок'}));
 fireEvent.click(screen.getByRole('button',{name:'Закрыть тестовый конструктор'}));
 expect(confirm).toHaveBeenCalledTimes(1);expect((screen.getByLabelText('Название дашборда') as HTMLInputElement).value).toBe('Рабочий обзор');
 fireEvent.click(screen.getByRole('button',{name:'Сохранить дашборд'}));await screen.findByText('Черновик сохранён');
 fireEvent.click(screen.getByRole('button',{name:'Закрыть тестовый конструктор'}));
 expect(screen.getByText('Конструктор закрыт')).toBeTruthy();expect(confirm).toHaveBeenCalledTimes(1);
});
it('keeps both definition and value editing guarded and releases the guard on confirmed value save',async()=>{
 await open(()=> <CustomFieldsPanel objectRef={{entityType:'core_goal_definition',id:fixtureId(11)}}/>);const confirm=vi.spyOn(window,'confirm').mockReturnValue(false);
 fireEvent.click(await screen.findByRole('button',{name:'Добавить описательное поле'}));
 fireEvent.change(await screen.findByLabelText('Имя поля'),{target:{value:'Заметка владельца'}});
 fireEvent.click(screen.getByRole('button',{name:'Закрыть поле'}));expect(confirm).toHaveBeenCalledTimes(1);
 fireEvent.click(screen.getByRole('button',{name:'Сохранить описание поля'}));await screen.findByText('Черновик сохранён');
 fireEvent.change(await screen.findByLabelText('Значение поля'),{target:{value:'Проверить источник'}});
 fireEvent.click(screen.getByRole('button',{name:'Закрыть поле'}));expect(confirm).toHaveBeenCalledTimes(2);
 expect((screen.getByLabelText('Значение поля') as HTMLInputElement).value).toBe('Проверить источник');
 fireEvent.click(screen.getByRole('button',{name:'Сохранить значение'}));
 await waitFor(()=>expect((screen.getByRole('button',{name:'Сохранить значение'}) as HTMLButtonElement).disabled).toBe(false));
 await screen.findByText('Черновик сохранён');
 fireEvent.click(screen.getByRole('button',{name:'Закрыть поле'}));
 expect(screen.queryByLabelText('Имя поля')).toBeNull();expect(confirm).toHaveBeenCalledTimes(2);
});
