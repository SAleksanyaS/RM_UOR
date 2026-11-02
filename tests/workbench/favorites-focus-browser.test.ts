import { expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createLocalBrowserRun } from './helpers/browser';
import type { PreferencesRead } from '../../src/features/system/workbench-preferences-query';

it.skipIf(!process.env.UOR_TEST_BROWSER_EXECUTABLE)('keeps keyboard focus through favorite reorder boundaries, visibility, removal and reset',async()=>{
 const f=await createLocalBrowserRun(),proof:Record<string,unknown>={},output=process.env.UOR_UI_ARTIFACT_DIR;
 try{
  const preferences=()=>f.request.query<PreferencesRead>('preferences.get'),initial=await preferences();
  await f.request.command('preferences.set',{values:{...initial.values,navigation:{favorites:['/data','/knowledge','/reports'],recent:[],startPage:'/overview'}}},initial.editToken);
  const page=f.page;await page.setViewportSize({width:320,height:900});await page.goto(f.origin+'/overview');
  const open=async()=>{await page.getByRole('button',{name:'Быстрый переход',exact:true}).click();return page.getByRole('dialog',{name:'Быстрый переход',exact:true});};
  const focus=()=>page.evaluate(()=>({tag:document.activeElement?.tagName,label:document.activeElement?.getAttribute('aria-label'),text:document.activeElement?.textContent,inside:!!document.activeElement?.closest('[role="dialog"]')}));
  let dialog=await open();const up=dialog.getByRole('button',{name:'Выше: Отчёты',exact:true});
  await up.focus();await page.keyboard.press('Enter');
  await expect.poll(async()=>(await preferences()).values.navigation?.favorites).toEqual(['/data','/reports','/knowledge']);
  await page.getByText('Порядок избранного сохранён',{exact:true}).waitFor();proof.afterMove=await focus();
  await expect.poll(async()=>(await focus()).label).toBe('Выше: Отчёты');
  // No manual focus repair: Enter must still activate the original reorder control.
  await page.keyboard.press('Enter');
  await expect.poll(async()=>(await preferences()).values.navigation?.favorites).toEqual(['/reports','/data','/knowledge']);
  await expect.poll(async()=>(await focus()).text).toBe('Отчёты');proof.afterBoundary=await focus();
  await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});

  dialog=await open();const display=dialog.getByLabel('Показывать избранное');await display.focus();await page.keyboard.press('Space');
  await expect.poll(()=>display.isChecked()).toBe(false);await expect.poll(()=>display.evaluate(node=>node===document.activeElement)).toBe(true);proof.afterHide=await focus();
  await page.keyboard.press('Space');await expect.poll(()=>display.isChecked()).toBe(true);await expect.poll(()=>display.evaluate(node=>node===document.activeElement)).toBe(true);
  const remove=dialog.getByRole('button',{name:'Убрать из избранного: Отчёты',exact:true});await remove.focus();await page.keyboard.press('Enter');
  await expect.poll(async()=>(await preferences()).values.navigation?.favorites).toEqual(['/data','/knowledge']);await expect.poll(async()=>(await focus()).inside).toBe(true);proof.afterRemove=await focus();
  await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});

  dialog=await open();await dialog.getByText('Стандартный личный вид',{exact:true}).click();const reset=dialog.getByRole('button',{name:'Восстановить стандартный вид',exact:true});await reset.focus();await page.keyboard.press('Enter');
  await expect.poll(async()=>(await preferences()).values.navigation?.favorites).toEqual([]);await expect.poll(async()=>(await focus()).inside).toBe(true);proof.afterReset=await focus();
  await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});

  // A real command response can be delayed while the user intentionally moves focus.
  dialog=await open();let release!:()=>void,arrived!:()=>void;const gate=new Promise<void>(r=>release=r),held=new Promise<void>(r=>arrived=r);
  await page.route('**/api/v1/commands',async route=>{const response=await route.fetch();arrived();await gate;await route.fulfill({response});},{times:1});
  const star=dialog.getByRole('button',{name:'В избранное: Данные',exact:true});await star.focus();await page.keyboard.press('Enter');await held;
  const search=dialog.getByRole('searchbox',{name:'Найти раздел',exact:true});await search.focus();release();
  await dialog.getByRole('button',{name:'Убрать из избранного: Данные',exact:true}).waitFor();await expect.poll(()=>search.evaluate(node=>node===document.activeElement)).toBe(true);proof.intentionalFocus=await focus();
  expect(f.errors).toEqual([]);proof.pageErrors=f.errors;
 }finally{if(output){await mkdir(output,{recursive:true});await writeFile(path.join(output,'favorites-focus-proof.json'),JSON.stringify(proof,null,2));}await f.close();}
},60000);
