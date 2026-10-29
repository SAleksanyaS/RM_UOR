import { mkdir } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { createOkoLauncherHarness } from './fixtures/workbench/oko-launcher-harness';
import ExcelJS from 'exceljs';
it('runs the standard launcher and compiled UI in Chrome through XLSX export, enrichment, response loss, restart and auth recovery',async()=>{
  const h=await createOkoLauncherHarness();const page=h.page;const errors:string[]=[],diagnostics:string[]=[];page.on('pageerror',e=>errors.push(e.message));page.on('requestfailed',r=>diagnostics.push(r.url()+': '+r.failure()?.errorText));page.on('console',m=>{if(m.type()==='error')diagnostics.push(m.text());});
  let primaryFailure: unknown;
  const commands: Array<{name:string;commandId:string;payload:Record<string,unknown>}> = [];
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/v1/commands')) commands.push(request.postDataJSON()); });
  const loseResponse = async (name: string) => {
    let received!: (value: {commandId:string;jobId?:string}) => void, rejected!: (error:unknown) => void;
    const response = new Promise<{commandId:string;jobId?:string}>((resolve,reject) => { received = resolve; rejected = reject; });
    await page.route('**/api/v1/commands', async route => {
      try {
      const request = route.request().postDataJSON();
      if (request.name !== name) { await route.continue(); return; }
      const completed = await route.fetch(), body = await completed.json(); expect(completed.ok(), JSON.stringify(body)).toBe(true);
      await route.abort('failed'); await page.unroute('**/api/v1/commands'); received({commandId:request.commandId,jobId:body.data.jobId});
      } catch(error) { rejected(error); }
    });
    return {response};
  };
  try{
    await page.goto(h.url);await page.getByLabel('Режим работы',{exact:true}).selectOption('viewer');await page.getByText('Временные локальные роли',{exact:true}).waitFor();await expect.poll(()=>page.getByRole('button',{name:'Создать первый сценарий'}).count()).toBe(0);await page.getByLabel('Режим работы',{exact:true}).selectOption('curator');
    const workflowLoss = await loseResponse('source.browser.workflow.open'); await page.getByRole('button',{name:'Создать первый сценарий'}).click(); const opened = await workflowLoss.response;
    await page.getByText('Нет связи с локальной службой. Проверьте окно запуска и повторите действие.',{exact:true}).waitFor();
    const metadata = await page.evaluate(() => sessionStorage.getItem('uor.oko.pending-command.v1')); expect(JSON.parse(metadata!).commandId).toBe(opened.commandId); expect(metadata).not.toContain('payload');
    await page.reload(); await page.getByLabel('Адрес отчёта').waitFor(); expect(await page.locator('.oko-workflow-link').count()).toBe(1); expect(commands.filter(command=>command.name==='source.browser.workflow.open')).toHaveLength(1);
    await page.getByLabel('Адрес отчёта').fill(h.reportUrl);await page.getByLabel('Установленный браузер').selectOption('chrome');await page.getByRole('button',{name:'Сохранить личный профиль',exact:true}).click();
    await page.getByRole('button',{name:'Открыть браузер для входа',exact:true}).click();await h.waitReport('login');await h.reportAction('login');await page.getByRole('button',{name:'Завершить ручной вход',exact:true}).click();
    const markerLoss = await loseResponse('source.browser.marker.select'); await page.getByRole('button',{name:'Выбрать элемент отчёта в браузере',exact:true}).click(); const acceptedMarker = await markerLoss.response; expect(acceptedMarker.jobId).toBeTruthy();
    await page.getByText('Нет связи с локальной службой. Проверьте окно запуска и повторите действие.',{exact:true}).first().waitFor(); await page.reload();
    await h.waitReport('picker');await h.reportAction('marker');await page.getByText('Выбрано: ready',{exact:true}).waitFor(); expect(commands.filter(command=>command.name==='source.browser.marker.select')).toHaveLength(1);expect(h.telemetry.filter(item=>item.mode==='picker')).toHaveLength(1);
    await page.getByText('Как читать файл CSV / XLSX',{exact:true}).click();await page.locator('#source-delimiter').selectOption(';');await page.getByRole('button',{name:'Начать запись действий',exact:true}).click();await h.waitReport('recorder');await h.reportAction('record');
    await page.getByRole('heading',{name:'Сопоставление столбцов',exact:true}).waitFor();expect(await page.locator('.oko-recorded-steps li').count()).toBe(5);expect(await page.locator('.oko-recorded-steps').innerText()).not.toContain('Login');
    await page.getByLabel('Значение фильтра «field_period»').fill('October');await page.getByLabel('Значение фильтра «field_scope»').fill('dit');await page.getByLabel('ID',{exact:true}).check();await page.getByLabel('Ключ продукта для справочника',{exact:true}).selectOption('Product');await page.getByLabel('Столбец «value»',{exact:true}).selectOption('Value');await page.getByLabel('Дата данных',{exact:true}).selectOption('Date');await page.getByLabel('Единица измерения — постоянная',{exact:true}).fill('units');await page.getByRole('button',{name:'Сохранить сопоставление и фильтры',exact:true}).click();await page.getByText('Сопоставление и значения фильтров сохранены. Можно проверить сценарий.',{exact:true}).waitFor();
    const fields=['key','productId','productName','clusterId','clusterName','ditId','ditName','clusterLeaderId','clusterLeaderName','productLeaderId','productLeaderName'];const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
    const workbook=new ExcelJS.Workbook(),sheet=workbook.addWorksheet('Directory');sheet.addRow(fields);sheet.addRow(['p1',id(2),'Product One',id(3),'Cluster One',id(4),'DIT One',id(5),'Cluster Leader',id(6),'Product Leader']);const directory=Buffer.from(await workbook.xlsx.writeBuffer());
    await page.getByLabel('Файл справочника',{exact:true}).setInputFiles({name:'directory.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:directory});await page.getByRole('button',{name:'Прочитать столбцы справочника',exact:true}).click();
    const labels=['Ключ продукта в ОКО','ID продукта (UUID)','Название продукта','ID кластера (UUID)','Название кластера','ID ДИТ (UUID)','Название ДИТ','ID руководителя кластера (UUID)','Руководитель кластера','ID руководителя продукта (UUID)','Руководитель продукта'];for(let i=0;i<fields.length;i++)await page.getByLabel(labels[i],{exact:true}).selectOption(fields[i]);
    await page.getByRole('button',{name:'Применить справочник к предпросмотру',exact:true}).click();await page.getByText('Используется личный справочник для предпросмотра.',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Проверить сценарий и получить данные',exact:true}).click();await page.getByRole('link',{name:'Скачать обогащённый CSV',exact:true}).waitFor();
    const rawPromise=page.waitForEvent('download');await page.getByRole('link',{name:'Скачать исходный файл',exact:true}).click();const raw=await h.readDownloadBytes(await rawPromise);expect(raw.equals(h.exportBytes)).toBe(true);
    const enrichedPromise=page.waitForEvent('download');await page.getByRole('link',{name:'Скачать обогащённый CSV',exact:true}).click();const enriched=await h.readDownload(await enrichedPromise);expect(enriched).toContain('123456789012345.67');expect(enriched).toContain('2026-10-28');expect(enriched).toContain('Product One');expect(enriched).toContain('Cluster One');expect(enriched).toContain(id(2));
    const firstResult = await page.getByRole('link',{name:'Скачать исходный файл',exact:true}).getAttribute('href');
    await page.getByText('Окно осталось открытым или профиль занят',{exact:true}).click();await page.getByRole('button',{name:'Закрыть окна браузера и освободить профиль',exact:true}).click();await page.getByText('Собственные окна автоматизации закрыты. Профиль освобождён.',{exact:true}).waitFor();
    expect(await page.locator('.oko-recorded-steps li').count()).toBe(5);expect(await page.getByRole('link',{name:'Скачать исходный файл',exact:true}).getAttribute('href')).toBe(firstResult);
    await h.stop();await h.start();await page.reload();await page.getByRole('link',{name:'Скачать обогащённый CSV',exact:true}).waitFor();expect(await page.locator('.oko-recorded-steps li').count()).toBe(5);expect(await page.getByRole('link',{name:'Скачать исходный файл',exact:true}).getAttribute('href')).toBe(firstResult);
    h.expire(); const authTelemetryStart = h.telemetry.length;
    await page.getByRole('button',{name:'Проверить сценарий и получить данные',exact:true}).click();await page.getByRole('button',{name:'Войти в ОКО',exact:true}).waitFor();
    expect(await page.getByRole('link',{name:'Скачать исходный файл',exact:true}).getAttribute('href')).toBe(firstResult);
    const replayCommandsBeforeAuth=commands.filter(command=>command.name==='source.browser.record.test').length;
    const authCommand=commands.filter(command=>command.name==='source.browser.record.test').at(-1)!;
    const receipt=await page.evaluate(async commandId=>(await (await fetch('/api/v1/commands/'+commandId)).json()).data,authCommand.commandId);
    expect(receipt.status).toBe('accepted');expect(receipt.job.jobId).toBeTruthy();
    await page.getByRole('button',{name:'Войти в ОКО',exact:true}).click();await h.waitReport('login',authTelemetryStart);await h.reportAction('login');
    await page.getByRole('button',{name:'Вход выполнен — продолжить',exact:true}).click();
    await expect.poll(()=>page.getByRole('link',{name:'Скачать исходный файл',exact:true}).getAttribute('href'),{timeout:25000}).not.toBe(firstResult);
    expect(commands.filter(command=>command.name==='source.browser.record.test')).toHaveLength(replayCommandsBeforeAuth);
    expect(commands.find(command=>command.name==='job.openAuth')?.payload.jobId).toBe(receipt.job.jobId);expect(commands.find(command=>command.name==='job.retry')?.payload.jobId).toBe(receipt.job.jobId);
    const recoveredJob=await page.evaluate(async jobId=>(await (await fetch('/api/v1/jobs/'+jobId)).json()).data,receipt.job.jobId);expect(recoveredJob.status).toBe('succeeded');expect(recoveredJob.jobId).toBe(receipt.job.jobId);
    const recoveredPromise=page.waitForEvent('download');await page.getByRole('link',{name:'Скачать обогащённый CSV',exact:true}).click();expect(await h.readDownload(await recoveredPromise)).toBe(enriched);
    expect(h.downloads).toEqual(Array.from({length:3},()=>({period:'October',scope:'dit'})));expect(errors).toEqual([]);expect(h.telemetry.filter(item=>item.error)).toEqual([]);expect(h.logs.join('')).toContain('ОКО готово:');await mkdir('.runtime/validation/workbench/continuation',{recursive:true});await page.screenshot({path:'.runtime/validation/workbench/continuation/oko-launcher-result.png',fullPage:true});
  }catch(error){const visible=await page.locator('body').innerText().catch(()=>'<UI unavailable>');primaryFailure=new Error(String(error)+'\nBrowser errors: '+[...errors,...diagnostics].join(' | ')+'\nLauncher: '+h.logs.join('')+'\nVisible UI: '+visible.slice(-6000),{cause:error});throw primaryFailure;}finally{await h.close(primaryFailure);}
},120000);
