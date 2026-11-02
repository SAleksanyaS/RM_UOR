// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WorkbenchProvider, useWorkbench } from './context';
import { WorkbenchCuratorPanel } from '../../features/publishing/workbench/CuratorPanel';
import { AppearancePanel } from './AppearancePanel';
import { WorkbenchShell } from './WorkbenchShell';
import { createWorkbenchApiHarness } from './testing/api-harness';
import { WorkbenchClient } from './api-client';
const closes: Array<() => Promise<void>> = [];
afterEach(async () => { cleanup(); for (const close of closes.splice(0)) await close(); window.history.replaceState(null, '', '/'); });
it('opens independent data and knowledge pages without a goal catalog', async () => {
 const h=await createWorkbenchApiHarness({role:'viewer',scenario:'empty'});closes.push(h.close);
 window.history.replaceState(null,'','/data');
 render(<WorkbenchProvider client={h.client}><WorkbenchShell views={{data:()=> <p>Raw file library</p>,knowledge:()=> <p>Knowledge directory</p>}}/></WorkbenchProvider>);
 await screen.findByText('Raw file library');
 fireEvent.click(screen.getByRole('button',{name:'База знаний'}));await screen.findByText('Knowledge directory');
 expect(window.location.search).toBe('');
});
it('persists sidebar and appearance through real preferences API and remount', async()=>{
 const h=await createWorkbenchApiHarness({role:'viewer',scenario:'empty'});closes.push(h.close);
 const view=render(<WorkbenchProvider client={h.client}><WorkbenchShell/></WorkbenchProvider>);
 await waitFor(()=>expect((screen.getByRole('button',{name:'Внешний вид'}) as HTMLButtonElement).disabled).toBe(false));
 fireEvent.click(screen.getByRole('button',{name:'Внешний вид'}));
 fireEvent.change(screen.getByLabelText('Тема'),{target:{value:'dark'}});
 fireEvent.change(screen.getByLabelText('Боковое меню'),{target:{value:'compact'}});
 fireEvent.click(screen.getByRole('button',{name:'Сохранить личный вид'}));
 await screen.findByText('Личный вид сохранён');
 expect(document.querySelector('.wb-shell')?.getAttribute('data-theme')).toBe('dark');
 view.unmount();render(<WorkbenchProvider client={h.client}><WorkbenchShell/></WorkbenchProvider>);
 await waitFor(()=>expect(document.querySelector('.wb-shell')?.getAttribute('data-navigation')).toBe('compact'));
});
it('reconciles a lost appearance receipt without submitting a second mutation',async()=>{
 const h=await createWorkbenchApiHarness({role:'viewer',scenario:'empty'});closes.push(h.close);
 const client=new WorkbenchClient({fetch:async(input,init)=>{const response=await h.fetch(input,init);if(String(input).endsWith('/commands'))throw Error('Lost receipt');return response;}});
 render(<WorkbenchProvider client={client}><WorkbenchShell/></WorkbenchProvider>);
 await waitFor(()=>expect((screen.getByRole('button',{name:'Внешний вид'}) as HTMLButtonElement).disabled).toBe(false));
 fireEvent.click(screen.getByRole('button',{name:'Внешний вид'}));fireEvent.change(screen.getByLabelText('Тема'),{target:{value:'dark'}});fireEvent.click(screen.getByRole('button',{name:'Сохранить личный вид'}));
 fireEvent.click(await screen.findByRole('button',{name:'Проверить сохранение личного вида'}));
 await screen.findByText('Личный вид сохранён');
 expect(h.requests.filter(r=>r.body?.name==='preferences.set')).toHaveLength(1);
 expect(document.querySelector('.wb-shell')?.getAttribute('data-theme')).toBe('dark');
});
it('opens quick navigation by keyboard without catalog and restores focus on Escape',async()=>{
 const h=await createWorkbenchApiHarness({role:'viewer',scenario:'empty'});closes.push(h.close);
 render(<WorkbenchProvider client={h.client}><WorkbenchShell views={{data:()=> <p>Raw file library</p>}}/></WorkbenchProvider>);
 const trigger=await screen.findByRole('button',{name:'Быстрый переход'});await waitFor(()=>expect((trigger as HTMLButtonElement).disabled).toBe(false));trigger.focus();
 fireEvent.keyDown(window,{key:'k',ctrlKey:true});
 const input=await screen.findByRole('searchbox',{name:'Найти раздел'});expect(document.activeElement).toBe(input);
 fireEvent.change(input,{target:{value:'Данные'}});fireEvent.keyDown(input,{key:'Enter'});await screen.findByText('Raw file library');expect(window.location.pathname).toBe('/data');
 trigger.focus();fireEvent.click(trigger);fireEvent.keyDown(await screen.findByRole('dialog',{name:'Быстрый переход'}),{key:'Escape'});await waitFor(()=>expect(document.activeElement).toBe(trigger));
});

it('opens own curator package queue before receiving a published catalog',async()=>{
 const h=await createWorkbenchApiHarness({role:'curator',scenario:'empty'});closes.push(h.close);window.history.replaceState(null,'','/uor');
 render(<WorkbenchProvider client={h.client}><WorkbenchShell views={{uor:WorkbenchCuratorPanel}}/></WorkbenchProvider>);
 await screen.findByText(/Накопленных пакетов пока нет/);
 expect(h.requests.find(r=>r.url.endsWith('/queries/uor.queue'))?.body?.context).toBeNull();
});

it('shows durable favorites and recent destinations with a persisted start selector',async()=>{
 const h=await createWorkbenchApiHarness({role:'viewer',scenario:'empty'});closes.push(h.close);
 const view=render(<WorkbenchProvider client={h.client}><WorkbenchShell/></WorkbenchProvider>);
 const trigger=await screen.findByRole('button',{name:'Быстрый переход'});await waitFor(()=>expect((trigger as HTMLButtonElement).disabled).toBe(false));fireEvent.click(trigger);
 fireEvent.click(screen.getByRole('button',{name:'В избранное: Данные'}));await screen.findByRole('button',{name:'Убрать из избранного: Данные'});expect(screen.getByRole('heading',{name:'Избранное'})).toBeTruthy();
 fireEvent.change(screen.getByLabelText('Стартовый раздел'),{target:{value:'/data'}});await waitFor(()=>expect((screen.getByLabelText('Стартовый раздел') as HTMLSelectElement).disabled).toBe(false));
 const input=screen.getByRole('searchbox',{name:'Найти раздел'});fireEvent.change(input,{target:{value:'База знаний'}});fireEvent.keyDown(input,{key:'Enter'});
 await waitFor(()=>expect(h.requests.filter(r=>r.body?.name==='preferences.set').at(-1)?.body?.payload).toMatchObject({values:{navigation:{recent:['/knowledge']}}}));
 view.unmount();window.history.replaceState(null,'','/');render(<WorkbenchProvider client={h.client}><WorkbenchShell/></WorkbenchProvider>);
 await waitFor(()=>expect(window.location.pathname).toBe('/data'));fireEvent.click(screen.getByRole('button',{name:'Быстрый переход'}));
 expect(screen.getByRole('heading',{name:'Недавние'})).toBeTruthy();expect(screen.getByRole('button',{name:'Убрать из избранного: Данные'})).toBeTruthy();
});

it('saves only edited appearance fields after the sidebar is independently saved',async()=>{
 const h=await createWorkbenchApiHarness({role:'viewer',scenario:'empty'});closes.push(h.close);window.history.replaceState(null,'','/settings');
 render(<WorkbenchProvider client={h.client}><WorkbenchShell views={{settings:AppearancePanel}}/></WorkbenchProvider>);
 fireEvent.change(await screen.findByLabelText('Тема'),{target:{value:'dark'}});fireEvent.click(screen.getByRole('button',{name:'Свернуть меню'}));
 await screen.findByRole('button',{name:'Развернуть меню'});fireEvent.click(screen.getByRole('button',{name:'Сохранить личный вид'}));await screen.findByText('Личный вид сохранён');
 expect(document.querySelector('.wb-shell')?.getAttribute('data-navigation')).toBe('compact');expect(document.querySelector('.wb-shell')?.getAttribute('data-theme')).toBe('dark');
});
it('moves native focus with arrow navigation and keeps the favorite separately operable',async()=>{
 const h=await createWorkbenchApiHarness({role:'viewer',scenario:'empty'});closes.push(h.close);
 render(<WorkbenchProvider client={h.client}><WorkbenchShell/></WorkbenchProvider>);const trigger=await screen.findByRole('button',{name:'Быстрый переход'});await waitFor(()=>expect((trigger as HTMLButtonElement).disabled).toBe(false));fireEvent.click(trigger);
 const input=screen.getByRole('searchbox',{name:'Найти раздел'});fireEvent.keyDown(input,{key:'ArrowDown'});expect(document.activeElement?.textContent).toContain('Обзор');
 fireEvent.keyDown(document.activeElement!,{key:'ArrowDown'});expect(document.activeElement?.textContent).toContain('Данные');
 const favorite=screen.getByRole('button',{name:'В избранное: Данные'});favorite.focus();expect(document.activeElement).toBe(favorite);
 fireEvent.keyDown(favorite,{key:'Escape'});await waitFor(()=>expect(document.activeElement).toBe(trigger));
});

it('does not acknowledge a dirty appearance form when recovery belongs to the sidebar',async()=>{
 const h=await createWorkbenchApiHarness({role:'viewer',scenario:'empty'});closes.push(h.close);window.history.replaceState(null,'','/settings');let lost=false;
 const client=new WorkbenchClient({fetch:async(input,init)=>{const r=await h.fetch(input,init);if(String(input).endsWith('/commands')&&!lost){lost=true;throw Error('lost sidebar receipt');}return r;}});
 render(<WorkbenchProvider client={client}><WorkbenchShell views={{settings:AppearancePanel}}/></WorkbenchProvider>);
 fireEvent.change(await screen.findByLabelText('Тема'),{target:{value:'dark'}});fireEvent.click(screen.getByRole('button',{name:'Свернуть меню'}));
 const check=await screen.findByRole('button',{name:'Проверить сохранение личного вида'});fireEvent.click(check);
 await screen.findByText(/Изменения этой формы ещё не сохранены/);expect(screen.queryByText('Личный вид сохранён')).toBeNull();expect((screen.getByLabelText('Тема') as HTMLSelectElement).value).toBe('dark');
 fireEvent.click(screen.getByRole('button',{name:'Сохранить личный вид'}));await screen.findByText('Личный вид сохранён');
 expect(document.querySelector('.wb-shell')?.getAttribute('data-theme')).toBe('dark');expect(document.querySelector('.wb-shell')?.getAttribute('data-navigation')).toBe('compact');expect(h.requests.filter(r=>r.body?.name==='preferences.set')).toHaveLength(2);
});
