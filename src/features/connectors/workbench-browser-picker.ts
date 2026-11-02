import { browserScenarioDefinitionSchema, stableBrowserLocatorSchema } from '../../domain/workbench/browser-scenario';
import type { BrowserContext, Frame, Page } from 'playwright';
import { openBrowser, type BrowserLauncherPort } from './browser';
import { browserOwnerRoot, type BrowserOwner } from './workbench-browser-runtime';
import { browserProfilePath, checkedUrl, withProfileQueue } from './transport';
import { ConnectorError, type PrivateProfile } from './contracts';
import { assertRecordedField, recordingReady } from './workbench-browser-recorder';

type PickerHandler = (source: { page: Page; frame: Frame }, payload: unknown) => Promise<unknown>;
const pickerBindings = new WeakMap<BrowserContext, { current?: PickerHandler }>();

export async function selectBrowserReportMarker(input: { runtimeRoot: string; owner: BrowserOwner; profile: PrivateProfile; startUrl: string; signal: AbortSignal; launcher?: BrowserLauncherPort; existingContext?: BrowserContext }): Promise<{ selector: string; label: string }> {
  const { profile, signal } = input, origin = checkedUrl(input.startUrl, profile).origin;
  const root = await browserOwnerRoot(input.runtimeRoot, input.owner);
  const select = async () => {
    signal.throwIfAborted();
    // A retained login already owns the profile queue. Picking is still an
    // interactive authentication phase; the report barrier belongs to recording.
    const context = input.existingContext ?? await openBrowser(root, { ...profile, browser: { ...profile.browser!, headless: false } }, { launcher: input.launcher, signal, phase: 'login' });
    let active = true;
    let resolve!: (value: { selector: string; label: string }) => void, reject!: (error: unknown) => void;
    const result = new Promise<{ selector: string; label: string }>((yes, no) => { resolve = yes; reject = no; });
    void result.catch(() => {});
    const abort = () => { reject(new DOMException('Выбор маркера отменён', 'AbortError')); void context.close().catch(() => {}); };
    const timeout = setTimeout(() => reject(new ConnectorError('timeout', 'Выбор маркера ограничен 15 минутами')), 15 * 60_000);
    signal.addEventListener('abort', abort, { once: true });
    const closed = () => reject(new ConnectorError('cancelled', 'Окно выбора маркера закрыто'));
    context.once('close', closed);
    let binding = pickerBindings.get(context);
    try {
      if (!binding) {
        binding = {}; pickerBindings.set(context, binding);
        const currentBinding = binding;
        await context.exposeBinding('__uorPickMarker', (source, payload: unknown) => currentBinding.current?.(source, payload));
      }
      binding.current = async ({ page, frame }, payload: unknown) => {
        if (frame !== page.mainFrame()) return;
        if (payload && typeof payload === 'object' && (payload as { queryActive?: unknown }).queryActive === true) return { active };
        if (!active) return { accepted: false };
        if (!payload || typeof payload !== 'object' || typeof (payload as {selector?: unknown}).selector !== 'string') return;
        const selector = (payload as {selector: string}).selector;
        if (selector.length > 500 || !await recordingReady(page, selector, origin)) return;
        const locator = page.locator(selector); await assertRecordedField(locator);
        const marker = await locator.evaluate(el => {
          if (el.matches('input,textarea,select,[contenteditable],iframe') || el.closest('[data-uor-marker-picker],[data-sensitive]')) return null;
          const expected = el.getAttribute('data-testid') ? `[data-testid="${CSS.escape(el.getAttribute('data-testid')!)}"]` : el.id ? `#${CSS.escape(el.id)}` : el.getAttribute('aria-label') ? `[aria-label="${CSS.escape(el.getAttribute('aria-label')!)}"]` : null;
          const label = (el.getAttribute('aria-label') || el.getAttribute('data-testid') || el.id || el.tagName).replace(/[\u0000-\u001f]/g, '').slice(0, 120);
          return expected ? { selector: expected, label } : null;
        });
        if (marker?.selector !== selector || !stableBrowserLocatorSchema.safeParse({ kind: 'css', selector: marker.selector }).success || !browserScenarioDefinitionSchema.shape.authenticatedSelector.safeParse(marker.selector).success) {
          return { accepted: false, message: 'Выберите другой элемент: этот маркер не подходит для безопасного повторения сценария.' };
        }
        active = false; resolve(marker); return { accepted: true };
      };
      const installPicker = ({ reportOrigin }: { reportOrigin: string }) => {
        if (window.top !== window) return;
        // Object methods stay self-contained when tsx/esbuild preserves function names.
        const picker = { install() {
          (window as unknown as { __uorMarkerStop?: () => void }).__uorMarkerStop?.();
          let selecting = true;
          const hint = document.createElement('div'); hint.setAttribute('data-uor-marker-picker', '');
          hint.textContent = 'УОР: войдите вручную, затем нажмите устойчивый элемент отчёта (заголовок или панель). Поля входа не записываются. Маркер внутри фрейма не поддерживается.';
          Object.assign(hint.style, { pointerEvents: 'none', position: 'fixed', top: '0', left: '0', right: '0', zIndex: '2147483647', padding: '14px', background: '#123c36', color: '#fff', font: '16px sans-serif' }); document.body.append(hint);
          (window as unknown as { __uorMarkerStop?: () => void }).__uorMarkerStop = () => { selecting = false; hint.remove(); };
          document.addEventListener('click', event => {
            if (!selecting) return;
            if (location.origin !== reportOrigin) return;
            const target = event.target as Element;
            if (!target || target.closest('[data-uor-marker-picker],input,textarea,select,[contenteditable],[data-sensitive],[data-authentication],[data-login]')) return;
            if (/login|sign.?in|sso|oauth|saml|authorize/i.test(location.pathname) || [...document.querySelectorAll('input[type="password"],input[autocomplete="one-time-code"],[data-authentication],[data-login]')].some(el => el.getClientRects().length)) return;
            const el = target.closest('[data-testid],[id],[aria-label]'); if (!el) return;
            const selector = el.getAttribute('data-testid') ? `[data-testid="${CSS.escape(el.getAttribute('data-testid')!)}"]` : el.id ? `#${CSS.escape(el.id)}` : `[aria-label="${CSS.escape(el.getAttribute('aria-label')!)}"]`;
            if (document.querySelectorAll(selector).length !== 1) { hint.textContent = 'Выберите другой элемент: маркер должен быть уникальным.'; return; }
            event.preventDefault(); event.stopImmediatePropagation();
            void (window as unknown as { __uorPickMarker(value: {selector: string}): Promise<{ accepted: boolean; message?: string }> }).__uorPickMarker({ selector }).then(result => { if (result?.accepted) { selecting = false; hint.textContent = 'УОР: маркер выбран. Оставьте это окно открытым, вернитесь в приложение и начните запись.'; } else hint.textContent = result?.message ?? 'Выберите другой элемент отчёта.'; }).catch(() => { hint.textContent = 'Выберите другой элемент: поля входа и чувствительные элементы не поддерживаются.'; });
          }, true);
        } };
        // Init scripts persist for this native context. After the one selection,
        // later report documents must not inherit a click-stealing picker.
        void (window as unknown as { __uorPickMarker(value: { queryActive: true }): Promise<{ active: boolean }> }).__uorPickMarker({ queryActive: true }).then(result => {
          if (!result?.active) return;
          if (document.body) picker.install(); else document.addEventListener('DOMContentLoaded', () => picker.install(), { once: true });
        }).catch(() => {});
      };
      await context.addInitScript(installPicker, { reportOrigin: origin });
      if (input.existingContext) for (const current of context.pages()) await current.evaluate(installPicker, { reportOrigin: origin }).catch(() => {});
      const page: Page = context.pages()[0] ?? await context.newPage(); signal.throwIfAborted();
      if (!input.existingContext) await Promise.race([page.goto(input.startUrl), result]);
      return await result;
    } finally { active = false; if (binding) binding.current = undefined; clearTimeout(timeout); signal.removeEventListener('abort', abort); context.removeListener('close', closed); if (!input.existingContext) await context.close().catch(() => {}); }
  };
  return input.existingContext ? select() : withProfileQueue(await browserProfilePath(root, profile), signal, select);
}
