import { readFile, mkdir, writeFile, stat, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import { safeArtifactPath } from '../../server/workspace/paths';
import { ConnectorError, scenarioSchema, stepSchema, type PrivateProfile, type BrowserScenario, type BrowserStep } from './contracts';
import { browserProfilePath, checkedUrl, withProfileQueue, type Downloaded } from './transport';
const browserLimits = new WeakMap<BrowserContext,{error?:ConnectorError}>();

export async function openBrowser(runtime: string, profile: PrivateProfile): Promise<BrowserContext> {
  const browser = profile.browser; if (!browser) throw new ConnectorError('configuration_required', 'Настройте executable/channel и приватный профиль браузера');
  const folder = await browserProfilePath(runtime, profile); await mkdir(folder, { recursive: true });
  let chromium: typeof import('playwright')['chromium'];
  try { ({ chromium } = await import('playwright')); } catch { throw new ConnectorError('configuration_required', 'Установите Playwright и Chromium либо укажите executablePath'); }
  const certs = await Promise.all((browser.clientCertificates ?? []).map(async c => ({ origin: checkedUrl(c.origin, profile).origin, cert: await readFile(c.certFile), key: await readFile(c.keyFile), ...(c.passphraseEnv ? { passphrase: process.env[c.passphraseEnv] } : {}) })));
  const downloads=await safeArtifactPath(runtime,`browser-downloads/${randomUUID()}`);await mkdir(downloads,{recursive:true});
  let context: BrowserContext;
  try { context = await chromium.launchPersistentContext(folder, { executablePath: browser.executablePath, channel: browser.channel, headless: browser.headless, serviceWorkers:'block', downloadsPath:downloads, acceptDownloads: true, ignoreHTTPSErrors: false, clientCertificates: certs }); }
  catch { await rm(downloads,{recursive:true,force:true}).catch(()=>{});throw new ConnectorError('configuration_required', 'Не удалось запустить Chromium. Проверьте executable/channel, установку браузера и занятость профиля'); }
  try{
  context.setDefaultTimeout(profile.timeoutMs); context.setDefaultNavigationTimeout(profile.timeoutMs);
  const limit:{error?:ConnectorError}={};browserLimits.set(context,limit);
  const page=context.pages()[0]??await context.newPage(),cdp=await context.newCDPSession(page);
  // Chromium response interception stops cross-origin redirects before the browser follows them.
  const protectRedirects=async(target:Page)=>{const guard=await context.newCDPSession(target);await guard.send('Fetch.enable',{patterns:[{urlPattern:'*',requestStage:'Response'}]});guard.on('Fetch.requestPaused',event=>{void(async()=>{try{checkedUrl(event.request.url,profile);const location=event.responseHeaders?.find(header=>header.name.toLowerCase()==='location')?.value;if(location&&event.responseStatusCode&&event.responseStatusCode>=300&&event.responseStatusCode<400)checkedUrl(new URL(location,event.request.url).href,profile);await guard.send('Fetch.continueRequest',{requestId:event.requestId});}catch{await guard.send('Fetch.failRequest',{requestId:event.requestId,errorReason:'BlockedByClient'}).catch(()=>{});}})();});};
  await protectRedirects(page);context.on('page',popup=>{void protectRedirects(popup).catch(()=>popup.close());});
  await cdp.send('Browser.setDownloadBehavior',{behavior:'allowAndName',downloadPath:downloads,eventsEnabled:true});
  cdp.on('Browser.downloadProgress',event=>{if(event.receivedBytes>profile.maxBytes||event.totalBytes>profile.maxBytes){limit.error=new ConnectorError('format','Браузерная выгрузка превышает допустимый размер');void cdp.send('Browser.cancelDownload',{guid:event.guid}).catch(()=>{});}});
  context.once('close',()=>{void rm(downloads,{recursive:true,force:true}).catch(()=>{});});
  await context.route('**/*', async route => { try { checkedUrl(route.request().url(), profile); await route.continue(); } catch { await route.abort('blockedbyclient'); } });
  await context.routeWebSocket('**/*',route=>{try{checkedUrl(route.url(),profile,true);route.connectToServer();}catch{route.close({code:1008,reason:'Origin not allowed'});}});
  return context;
  }catch(error){await context.close().catch(()=>{});await rm(downloads,{recursive:true,force:true}).catch(()=>{});throw error;}
}
async function assertSafeField(page: Page, selector: string) {
  const unsafe = await page.locator(selector).evaluate(el => {
    const node = el as HTMLInputElement; return node.type === 'password' || /password|token|secret|otp|saml|authorization|credential|one.time|current.password/i.test([node.name, node.id, node.autocomplete, node.getAttribute('aria-label')].join(' '));
  });
  if (unsafe) throw new ConnectorError('configuration_required', 'В сценарии запрещены поля паролей, кодов и токенов. Выполните вход вручную');
}
export async function readScenario(runtime: string, id: string): Promise<BrowserScenario> {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new ConnectorError('configuration_required', 'Некорректный идентификатор сценария');
  try { return scenarioSchema.parse(JSON.parse(await readFile(await safeArtifactPath(runtime, `connector-scenarios/${id}.json`), 'utf8'))); }
  catch { throw new ConnectorError('configuration_required', 'Сценарий не найден или содержит неподдерживаемые действия'); }
}
export async function executeBrowser(runtime: string, profile: PrivateProfile, scenario: BrowserScenario, parameters: Record<string, string>, signal: AbortSignal): Promise<Downloaded> {
  return withProfileQueue(await browserProfilePath(runtime, profile), signal, async () => {
    const context = await openBrowser(runtime, profile), abort = () => { void context.close(); }; signal.addEventListener('abort', abort, { once: true });
    const totalTimer=setTimeout(()=>{const limit=browserLimits.get(context)!;limit.error=new ConnectorError('timeout','Истекло общее время браузерного сбора');void context.close();},Math.min(120000,profile.timeoutMs*4));
    try {
      signal.throwIfAborted(); const page = context.pages()[0] ?? await context.newPage();
      await page.goto(checkedUrl(scenario.startUrl, profile).href);
      if(/login|sign.?in|sso|oauth|saml|authorize/i.test(new URL(page.url()).pathname))throw new ConnectorError('manual_login_required','Откройте профиль и завершите вход вручную');
      let downloaded: Downloaded | undefined;
      for (const step of scenario.steps) {
        signal.throwIfAborted(); checkedUrl(page.url(), profile);
        if (profile.browser?.loginUrlPattern && new RegExp(profile.browser.loginUrlPattern).test(page.url())) throw new ConnectorError('manual_login_required', 'Откройте профиль и завершите вход вручную');
        if (step.action === 'goto') { await page.goto(checkedUrl(step.url, profile).href); continue; }
        const locator = page.locator(step.selector);
        if (step.action === 'fill' || step.action === 'select') {
          await assertSafeField(page, step.selector); const value = parameters[step.parameter];
          if (value === undefined || /password|token|secret|otp|saml|credential/i.test(step.parameter)) throw new ConnectorError('configuration_required', 'Не задан безопасный параметр сценария');
          if (step.action === 'fill') await locator.fill(value); else await locator.selectOption(value);
        } else if (step.action === 'click') await locator.click();
        else if (step.action === 'check') { await assertSafeField(page, step.selector); await locator.setChecked(step.checked); }
        else if (step.action === 'wait') await locator.waitFor({ state: 'visible' });
        else {
          const [file] = await Promise.all([page.waitForEvent('download'), locator.click()]);
          if (await file.failure()) throw new ConnectorError('incomplete', 'Браузер не завершил выгрузку');
          const filePath = await file.path(); if (!filePath || (await stat(filePath)).size > profile.maxBytes) throw new ConnectorError('format', 'Выгрузка отсутствует или превышает ограничение размера');
          downloaded = { bytes: await readFile(filePath), name: file.suggestedFilename(), contentType: '' }; await file.delete();
        }
      }
      if (!downloaded) throw new ConnectorError('incomplete', 'Сценарий не получил файл. Добавьте действие download'); return downloaded;
    } catch(error){if(signal.aborted)signal.throwIfAborted();throw browserLimits.get(context)?.error??error;}
    finally { clearTimeout(totalTimer);signal.removeEventListener('abort', abort); await context.close().catch(() => {}); }
  });
}

interface Recording { id: string; owner: string; context: BrowserContext; scenario: BrowserScenario; release: () => void; expires: NodeJS.Timeout; parameters: Record<string, string>; screenshots: string[]; pendingDownload?:boolean }
const recordings = new Map<string, Recording>();
async function recorderReady(page:Page,selector:string,origin:string){try{return new URL(page.url()).origin===origin&&!/login|sign.?in|sso|oauth|saml|authorize/i.test(new URL(page.url()).pathname)&&await page.locator(selector).isVisible()&&!await page.locator('input[type="password"],input[autocomplete="one-time-code"],[data-authentication],[data-login],iframe[src*="sso"],iframe[src*="login"]').evaluateAll(elements=>elements.some(el=>el.getClientRects().length>0));}catch{return false;}}
export async function startRecording(runtime: string, owner: string, profile: PrivateProfile, startUrl: string, observe=true,authenticatedSelector?:string,onClosed?:()=>void) {
  if(observe&&!authenticatedSelector)throw new ConnectorError('configuration_required','Для записи задайте элемент, видимый только после успешного входа в источник');
  checkedUrl(startUrl, profile); const id = randomUUID();
  let ready!: (record: Recording) => void, failed!: (error: unknown) => void;
  const started = new Promise<Recording>((resolve, reject) => { ready = resolve; failed = reject; });
  const waiting=new AbortController(),signal=waiting.signal,queueTimer=setTimeout(()=>waiting.abort(),profile.timeoutMs);
  void withProfileQueue(await browserProfilePath(runtime, profile), signal, async () => {
    let context: BrowserContext | undefined;
    try {
      clearTimeout(queueTimer);
      context = await openBrowser(runtime, { ...profile, browser: { ...profile.browser!, headless: false } });
      let release!: () => void; const done = new Promise<void>(resolve => { release = resolve; });
      const record: Recording = { id, owner, context, scenario: { id: `scenario-${id}`, startUrl, steps: [] }, release, expires: setTimeout(() => release(), 15 * 60_000), parameters: {}, screenshots: [] };
      const sourceOrigin = new URL(startUrl).origin;
      if(observe){
      await context.exposeBinding('__uorRecord', async ({ page, frame }, event: unknown) => {
        if(!await recorderReady(page,authenticatedSelector!,sourceOrigin))return;
        if (frame !== page.mainFrame() || new URL(frame.url()).origin !== sourceOrigin || /login|sign.?in|sso|oauth|saml|authorize/i.test(new URL(frame.url()).pathname) || record.scenario.steps.length >= 100) return;
        const parsed = stepSchema.safeParse(event); if (!parsed.success || parsed.data.action === 'goto' || parsed.data.action === 'download') return;
        if ('selector' in parsed.data) {
          if ((await page.locator(parsed.data.selector).count()) !== 1) return;
          await assertSafeField(page, parsed.data.selector);
        }
        if(parsed.data.action==='click'&&record.pendingDownload){record.scenario.steps.push({action:'download',selector:parsed.data.selector});record.pendingDownload=false;}
        else record.scenario.steps.push(parsed.data);
        const screenshotIndex=record.scenario.steps.length;
        // Mask all editable content and common secret-bearing containers; never capture SSO origins.
        const directory = await safeArtifactPath(runtime, `connector-recordings/${id}`); await mkdir(directory, { recursive: true });
        const screenshot = path.join(directory, `${screenshotIndex}.png`);
        if(await recorderReady(page,authenticatedSelector!,sourceOrigin))await page.screenshot({ path: screenshot, mask: [page.locator('input,textarea,select,[contenteditable],[data-sensitive],iframe')], timeout: 3000 }).then(() => record.screenshots.push(screenshot)).catch(() => {});
      });
      await context.addInitScript(() => {
        const safe = (el: Element) => !/login|sign.?in|sso|oauth|saml|authorize/i.test(location.pathname) && !el.closest('form')?.querySelector('input[type="password"]') && !/password|token|secret|otp|saml|authorization|credential|one.time/i.test([el.getAttribute('type'), el.id, el.getAttribute('name'), el.getAttribute('autocomplete'), el.getAttribute('aria-label')].join(' '));
        const selector = (el: Element) => el.getAttribute('data-testid') ? `[data-testid="${CSS.escape(el.getAttribute('data-testid')!)}"]` : el.id ? `#${CSS.escape(el.id)}` : el.getAttribute('name') ? `${el.tagName.toLowerCase()}[name="${CSS.escape(el.getAttribute('name')!)}"]` : null;
        const send = (event: unknown) => { const fn = (window as unknown as { __uorRecord?: (v: unknown) => Promise<void> }).__uorRecord; void fn?.(event); };
        document.addEventListener('click', event => { const el = (event.target as Element)?.closest('button,a,[role="button"],input[type="checkbox"]'); if (!el || !safe(el)) return; const s = selector(el); if (!s) return; if ((el as HTMLInputElement).type === 'checkbox') send({ action: 'check', selector: s, checked: (el as HTMLInputElement).checked }); else send({ action: 'click', selector: s }); }, true);
        document.addEventListener('change', event => { const el = event.target as HTMLInputElement; if (!safe(el) || !['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || ['password','file','checkbox','radio','hidden'].includes(el.type)) return; const s = selector(el); if (!s) return; send({ action: el.tagName === 'SELECT' ? 'select' : 'fill', selector: s, parameter: `field_${el.id || el.name}` }); }, true);
      });
      const attach = (page: Page) => page.on('download', async file => {
        if (new URL(page.url()).origin !== sourceOrigin) { await file.cancel(); return; }
        const last = record.scenario.steps.at(-1); if (last?.action === 'click') {record.scenario.steps[record.scenario.steps.length - 1] = { action: 'download', selector: last.selector };record.pendingDownload=false;}else record.pendingDownload=true;
        await file.cancel();
      });
      context.pages().forEach(attach); context.on('page', attach);
      }
      context.on('close',()=>{release();onClosed?.();});
      const page = context.pages()[0] ?? await context.newPage(); await page.goto(startUrl); recordings.set(id, record); ready(record);
      await done;
      clearTimeout(record.expires); recordings.delete(id);
    } catch (e) { failed(e); } finally { await context?.close().catch(() => {}); }
  }).catch(failed);
  let record:Recording;try{record=await started;}finally{clearTimeout(queueTimer);} return { recordingId: record.id, message: 'Войдите вручную. Запись действий действует только на origin источника; значения полей не записываются. Завершите запись в приложении.' };
}
export async function finishRecording(runtime: string, owner: string, id: string, save: boolean) {
  const record = recordings.get(id); if (!record || record.owner !== owner) throw new ConnectorError('access_denied', 'Запись принадлежит другой сессии или завершена');
  try {
    const scenario = scenarioSchema.parse(record.scenario);
    if (save) { const directory = await safeArtifactPath(runtime, 'connector-scenarios'); await mkdir(directory, { recursive: true }); await writeFile(path.join(directory, `${scenario.id}.json`), JSON.stringify(scenario, null, 2), { flag: 'wx' }); }
    const directory=await safeArtifactPath(runtime,`connector-recordings/${id}`);await mkdir(directory,{recursive:true});
    await writeFile(path.join(directory,'manifest.json'),JSON.stringify({ownerSessionId:owner,files:record.screenshots.map(file=>path.basename(file))}));
    return { scenario, parameters: [...new Set(scenario.steps.flatMap(s => s.action === 'fill' || s.action === 'select' ? [s.parameter] : []))], screenshotCount: record.screenshots.length,screenshots:record.screenshots.map(file=>({url:`/api/connectors/recordings/${id}/screenshots/${path.basename(file,'.png')}`,label:`Шаг ${path.basename(file,'.png')}`})) };
  } finally { record.release(); await record.context.close().catch(() => {}); }
}
export async function stopAllRecordings() { for (const record of recordings.values()) { record.release(); await record.context.close().catch(() => {}); } }
