import {expect,it} from 'vitest';
import {createLocalRuntime,codeRoot} from './helpers/runtime';
import {createServer} from 'vite';
import {chromium} from 'playwright';
import path from 'node:path';
import {mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
// Explicit synthetic CI only. Production browser adapters keep their sandbox policy.
it.skipIf(!process.env.UOR_TEST_BROWSER_EXECUTABLE)('real raw API and production UI filter beyond preview without any goal',async()=>{
 const f=await createLocalRuntime();let host:Awaited<ReturnType<typeof createServer>>|undefined,browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
 try{
  await f.request.session();await f.request.command('raw.capture.manual',{title:'Синтетический отчёт',columns:['Команда','Значение'],rows:Array.from({length:123},(_,i)=>['Команда '+i,String(i)])});
  host=await createServer({configFile:path.join(codeRoot,'vite.config.ts'),root:codeRoot,cacheDir:path.join(f.root,'.runtime/vite-cache'),server:{host:'127.0.0.1',port:f.ui,strictPort:true,proxy:{'/api':f.origin}}});await host.listen();
  browser=await chromium.launch({executablePath:process.env.UOR_TEST_BROWSER_EXECUTABLE!,headless:true,chromiumSandbox:process.env.UOR_SYNTHETIC_CI!=='1'});const page=await browser.newPage({viewport:{width:1366,height:768}});page.setDefaultTimeout(15000);
  await page.goto('http://127.0.0.1:'+f.ui+'/data');await page.getByRole('button',{name:/Синтетический отчёт/}).click();await page.getByRole('table',{name:'Строки исходного файла'}).waitFor();
  await page.getByLabel('Поиск по строкам').fill('Команда 122');await page.getByRole('cell',{name:'Команда 122',exact:true}).waitFor();expect(await page.getByRole('cell',{name:'Команда 0',exact:true}).count()).toBe(0);
  const downloadPromise=page.waitForEvent('download');await page.getByRole('link',{name:'Скачать исходник'}).click();const download=await downloadPromise;const stream=await download.createReadStream();const chunks:Buffer[]=[];for await(const chunk of stream!)chunks.push(Buffer.from(chunk));const list=await f.request.query('raw.files.list');expect(createHash('sha256').update(Buffer.concat(chunks)).digest('hex')).toBe(list.items[0].sha256);
  if(process.env.UOR_UI_ARTIFACT_DIR){await mkdir(process.env.UOR_UI_ARTIFACT_DIR,{recursive:true});await page.getByLabel('Поиск по строкам').fill('');await page.getByRole('cell',{name:'Команда 0',exact:true}).waitFor();for(const theme of ['light','dark']){const prefs=await f.request.query('preferences.get');await f.request.command('preferences.set',{values:{...prefs.values,visual:{...prefs.values.visual,theme}}},prefs.editToken);await page.reload();await page.getByRole('table',{name:'Строки исходного файла'}).waitFor();for(const width of [1366,320]){await page.setViewportSize({width,height:900});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);await page.screenshot({path:path.join(process.env.UOR_UI_ARTIFACT_DIR,'raw-'+theme+'-'+width+'.png'),fullPage:true});}}}
  await page.setViewportSize({width:1366,height:900});
  await page.getByRole('button',{name:'Быстрый переход',exact:true}).click();
  await page.getByRole('button',{name:'В избранное: Данные',exact:true}).click();await page.getByRole('button',{name:'Убрать из избранного: Данные',exact:true}).waitFor();
  await page.getByLabel('Стартовый раздел').selectOption('/data');
  await expect.poll(()=>page.getByLabel('Стартовый раздел').isEnabled()).toBe(true);
  await page.getByRole('searchbox',{name:'Найти раздел'}).fill('База знаний');await page.getByRole('searchbox',{name:'Найти раздел'}).press('Enter');
  await page.waitForURL('**/knowledge');
  await expect.poll(async()=>(await f.request.query('preferences.get')).values.navigation.recent).toContain('/knowledge');
  await page.goto('http://127.0.0.1:'+f.ui+'/');await page.waitForURL('**/data');
  await page.getByRole('button',{name:'Быстрый переход',exact:true}).click();await page.getByRole('heading',{name:'Недавние',exact:true}).waitFor();expect(await page.getByRole('button',{name:'Убрать из избранного: Данные'}).count()).toBe(1);
  if(process.env.UOR_UI_ARTIFACT_DIR){for(const width of [1366,320]){await page.setViewportSize({width,height:900});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);await page.screenshot({path:path.join(process.env.UOR_UI_ARTIFACT_DIR,'navigation-completed-'+width+'.png'),fullPage:true});}}
  await page.getByRole('button',{name:'Закрыть быстрый переход'}).click();await page.goto('http://127.0.0.1:'+f.ui+'/data#personal-oko');
  await page.getByRole('button',{name:'Создать первый сценарий'}).click();await page.getByLabel('Источник сценария').selectOption('confluence');await page.getByLabel('Название отчёта').fill('Синтетическое вложение');
  await page.getByText('Происхождение вложения (необязательно)',{exact:true}).click();await page.getByLabel('URL страницы').fill('https://wiki.example.org/pages/viewpage.action?pageId=123');await page.getByLabel('Идентификатор вложения').fill('456');await page.getByLabel('Версия вложения').fill('7');
  if(process.env.UOR_UI_ARTIFACT_DIR){expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);await page.screenshot({path:path.join(process.env.UOR_UI_ARTIFACT_DIR,'confluence-creation-320.png'),fullPage:true});}
  await page.getByRole('button',{name:'Создать сценарий',exact:true}).click();await page.getByLabel('Адрес отчёта').waitFor();
  expect((await f.request.session()).defaultContext).toBeNull();expect(f.runtime.deps.repository.readPublishedCatalog()).toEqual([]);
 }finally{await browser?.close();await host?.close();await f.close();}
},90000);
