import { randomUUID } from 'node:crypto';

const stepLimit = 12;

export class BrowserRecordingError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// This listener runs in a named Chromium isolated world, so page scripts cannot call its binding.
function attachListener({ origin, bindingName, cleanupName, authPattern }) {
  if (window !== window.top || location.origin !== origin) return 'wrong-origin';
  if (globalThis[cleanupName]) return 'ready';
  const authentication = new RegExp(
    authPattern + '|sign[\\s_-]*(?:in|on)|log[\\s_-]*in|oauth|авторизац|код\\s+подтверждения|(?:^|[^\\p{L}])(?:вход|войти)(?:$|[^\\p{L}])',
    'iu',
  );
  const privateAttribute = /auth|session|login|sso|employee|account|password|token|secret|\d{6,}|[a-f0-9]{16,}/iu;
  const credentialInput = 'input[type="password"], input[autocomplete="username"], input[autocomplete="one-time-code"], ' +
    'input[autocomplete="current-password"], input[autocomplete="new-password"]';
  const actionable = 'button, a[href], summary, [role="button"], [role="link"], [role="menuitem"], [role="option"], [role="tab"]';
  const textControl = 'input, textarea, select, label, [contenteditable]:not([contenteditable="false"])';
  const authFieldsVisible = () => [...document.querySelectorAll(credentialInput)].some(field => field.getClientRects().length > 0);
  if (authFieldsVisible()) return 'sign-in';
  if (typeof globalThis[bindingName] !== 'function') return 'unsupported';

  const attributeText = element => ['id', 'name', 'type', 'autocomplete', 'aria-label', 'placeholder']
    .map(name => element.getAttribute(name) ?? '').join(' ');
  function authenticationControl(element) {
    if (authentication.test(attributeText(element))) return true;
    const form = element.closest('form');
    return Boolean(form && (authentication.test(attributeText(form)) || form.querySelector(credentialInput) ||
      [...form.querySelectorAll('input, textarea')].some(field => authentication.test(attributeText(field)))));
  }

  function unique(selector, element) {
    const matches = document.querySelectorAll(selector);
    return matches.length === 1 && matches[0] === element;
  }

  function stableSelector(element) {
    for (const attr of ['id', 'data-testid', 'data-test', 'data-qa']) {
      const value = element.getAttribute(attr);
      if (!value || !/^[A-Za-z_][A-Za-z0-9_-]{0,59}$/u.test(value) || privateAttribute.test(value) ||
          authentication.test(value)) continue;
      const selector = attr === 'id' ? '#' + value : '[' + attr + '="' + value + '"]';
      if (unique(selector, element)) return selector;
    }
    return null;
  }

  function selectorFor(target) {
    const segments = [];
    for (let element = target; element && segments.length < 8; element = element.parentElement) {
      const anchor = element === document.body ? 'body' : stableSelector(element);
      if (anchor) {
        const selector = [anchor, ...segments].join(' > ');
        return selector.length <= 220 && unique(selector, target) ? selector : null;
      }
      const tag = element.localName;
      if (!/^[a-z][a-z0-9-]{0,30}$/u.test(tag)) return null;
      let position = 1;
      for (let sibling = element.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
        if (sibling.localName === tag) position++;
      }
      segments.unshift(tag + ':nth-of-type(' + position + ')');
    }
    return null;
  }

  const listener = event => {
    if (!event.isTrusted || event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
        location.origin !== origin || authFieldsVisible() || !(event.target instanceof Element) ||
        event.target.closest(textControl)) return;
    const target = event.target.closest(actionable);
    if (!target || authenticationControl(target)) return;
    const anchor = target instanceof HTMLAnchorElement;
    if (anchor && target.origin !== origin) return;
    const selector = selectorFor(target);
    if (selector) globalThis[bindingName](JSON.stringify({ selector, download: anchor && target.hasAttribute('download') }));
  };
  window.addEventListener('click', listener, { capture: true, passive: true });
  globalThis[cleanupName] = () => {
    window.removeEventListener('click', listener, true);
    delete globalThis[cleanupName];
  };
  return 'ready';
}

export async function startBrowserClickRecorder(cdp, { origin, authPattern, validateSelector }) {
  const nonce = randomUUID().replace(/-/gu, '');
  const worldName = 'uor_report_world_' + nonce;
  const bindingName = 'uor_record_click_' + nonce;
  const cleanupName = 'uor_remove_click_' + nonce;
  const settings = { origin, bindingName, cleanupName, authPattern };
  const source = '(' + attachListener.toString() + ')(' + JSON.stringify(settings) + ')';
  const contexts = new Set();
  const actions = [];
  let mainFrame;
  let scriptId;
  let downloadSelector;
  let overflow = false;
  let leftOrigin = false;
  let active = true;
  let cleanup;

  const onContext = ({ context }) => {
    if (context.name === worldName && context.auxData?.frameId === mainFrame) contexts.add(context.id);
  };
  const onDestroyed = ({ executionContextId }) => { contexts.delete(executionContextId); };
  const onCleared = () => contexts.clear();
  const onNavigation = ({ frame }) => {
    if (frame.parentId) return;
    mainFrame = frame.id;
    try {
      if (new URL(frame.url).origin !== origin) leftOrigin = true;
    } catch {
      leftOrigin = true;
    }
  };
  const onBinding = event => {
    if (!active || leftOrigin || downloadSelector || event.name !== bindingName || !contexts.has(event.executionContextId) ||
        typeof event.payload !== 'string' || event.payload.length > 500) return;
    try {
      const payload = JSON.parse(event.payload);
      if (!payload || Object.keys(payload).length !== 2 || typeof payload.selector !== 'string' ||
          typeof payload.download !== 'boolean') return;
      const selector = validateSelector(payload.selector);
      if (!selector) return;
      if (actions.length >= stepLimit) {
        overflow = true;
      } else if (payload.download) {
        downloadSelector = selector;
      } else {
        actions.push({ type: 'click', selector });
      }
    } catch {
      // Treat a malformed signal as no recorded action.
    }
  };
  const listeners = [
    ['Runtime.executionContextCreated', onContext], ['Runtime.executionContextDestroyed', onDestroyed],
    ['Runtime.executionContextsCleared', onCleared], ['Runtime.bindingCalled', onBinding],
    ['Page.frameNavigated', onNavigation],
  ];

  function dispose() {
    if (cleanup) return cleanup;
    active = false;
    cleanup = (async () => {
      for (const [event, listener] of listeners) cdp.off(event, listener);
      if (scriptId) await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: scriptId }).catch(() => {});
      await cdp.send('Runtime.removeBinding', { name: bindingName }).catch(() => {});
      const expression = 'globalThis[' + JSON.stringify(cleanupName) + ']?.()';
      await Promise.all([...contexts].map(contextId => cdp.send('Runtime.evaluate', { expression, contextId }).catch(() => {})));
      contexts.clear();
    })();
    return cleanup;
  }

  try {
    const tree = await cdp.send('Page.getFrameTree');
    mainFrame = tree.frameTree.frame.id;
    for (const [event, listener] of listeners) cdp.on(event, listener);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Runtime.addBinding', { name: bindingName, executionContextName: worldName });
    const script = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source, worldName });
    scriptId = script.identifier;
    const context = await cdp.send('Page.createIsolatedWorld', { frameId: mainFrame, worldName });
    const contextId = context.executionContextId;
    contexts.add(contextId);
    const result = await cdp.send('Runtime.evaluate', { expression: source, contextId, returnByValue: true });
    if (result.result?.value === 'sign-in' || result.result?.value === 'wrong-origin') {
      throw new BrowserRecordingError('BROWSER_LOGIN_REQUIRED', 'Завершите вход и откройте отчёт перед записью.');
    }
    if (result.result?.value !== 'ready' || leftOrigin) throw new Error('isolated recording not ready');
  } catch (error) {
    await dispose();
    if (error instanceof BrowserRecordingError) throw error;
    throw new BrowserRecordingError('BROWSER_RECORD_FAILED', 'Браузер не смог начать запись действий в открытом отчёте.');
  }

  return {
    dispose,
    async stop() {
      await dispose();
      if (leftOrigin) throw new BrowserRecordingError('BROWSER_RECORD_ORIGIN', 'Адрес отчёта изменился. Откройте отчёт и повторите запись.');
      if (overflow) throw new BrowserRecordingError('BROWSER_RECORD_LIMIT', 'За одну запись выполните до 12 действий.');
      return downloadSelector ? { actions, downloadSelector } : { actions };
    },
  };
}
