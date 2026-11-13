import { validateBrowserConfig } from './browser-connector.mjs';

const format = 'rm-uor-browser-scenario';
const version = 1;
const maxSteps = 12;
export const maxBrowserScenarioBytes = 16 * 1024;

const fields = new Set(['format', 'version', 'actions', 'downloadSelector']);
const name = '[A-Za-z_][A-Za-z0-9_-]{0,79}';
const attributeValue = '[A-Za-z0-9_][A-Za-z0-9_-]{0,79}';
const quotedValue = '(?:"' + attributeValue + '"|\\x27' + attributeValue + '\\x27|' + name + ')';
const attribute = '\\[ *(?:data-testid|data-test|data-qa|type) *= *' + quotedValue + ' *\\]';
const position = ':nth-(?:child|of-type)\\([1-9][0-9]{0,3}\\)';
const modifier = '(?:[.#]' + name + '|' + attribute + '|' + position + ')';
const compound = '(?:' + name + modifier + '*|' + modifier + '+)';
const structuralSelector = new RegExp('^' + compound + '(?:(?: *> *| +)' + compound + ')*$', 'u');
const credentialSelector = /(?:^|[^a-z0-9])(?:auth|authorization|cookie|token|secret|credentials?|session|api[_-]?key)(?:$|[^a-z0-9])/iu;

export class BrowserScenarioError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BrowserScenarioError';
    this.code = 'BROWSER_SCENARIO_INVALID';
    this.status = 400;
  }
}

function problem(message) {
  return new BrowserScenarioError(message);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function portableSelector(value) {
  if (typeof value !== 'string' || value.length > 220 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw problem('В переносимом сценарии нужен короткий структурный CSS-селектор.');
  }
  const selector = value.trim();
  if (!structuralSelector.test(selector) || credentialSelector.test(selector)) {
    throw problem('Для переносимого сценария используйте ID, классы, тестовые атрибуты или структурный путь CSS.');
  }
  return selector;
}

function normalize(input) {
  if (!isRecord(input) || Object.keys(input).some(key => !fields.has(key))
      || input.format !== format || input.version !== version) {
    throw problem('Поддерживается JSON-сценарий браузера версии 1.');
  }
  if (!Array.isArray(input.actions) || input.actions.length > maxSteps) {
    throw problem('В переносимом сценарии допустимо до 12 шагов.');
  }
  const actions = input.actions.map(action => {
    if (!isRecord(action) || !['click', 'wait'].includes(action.type)
        || Object.keys(action).some(key => key !== 'type' && key !== 'selector')) {
      throw problem('В переносимый сценарий входят только клики и ожидания.');
    }
    return { type: action.type, selector: portableSelector(action.selector) };
  });
  const downloadSelector = input.downloadSelector === undefined || input.downloadSelector === ''
    ? undefined : portableSelector(input.downloadSelector);
  if (!actions.length && !downloadSelector) throw problem('Добавьте шаг или кнопку выгрузки.');
  try {
    // Validate the same replay fields without carrying a real target or origin into the file.
    validateBrowserConfig({ id: 'portable-scenario', url: 'https://example.invalid/', actions, downloadSelector });
  } catch {
    throw problem('Проверьте селекторы сценария. Поля входа используются вручную.');
  }
  return { format, version, actions, ...(downloadSelector ? { downloadSelector } : {}) };
}

export function parseBrowserScenario(input) {
  const bytes = typeof input === 'string' ? Buffer.byteLength(input) : input instanceof Uint8Array ? input.byteLength : -1;
  if (bytes <= 0 || bytes > maxBrowserScenarioBytes) throw problem('Выберите файл сценария JSON размером до 16 КБ.');
  let value;
  try {
    const text = typeof input === 'string' ? input : new TextDecoder('utf-8', { fatal: true }).decode(input);
    value = JSON.parse(text.replace(/^\ufeff/u, ''));
  } catch {
    throw problem('Не удалось прочитать файл сценария JSON.');
  }
  return normalize(value);
}

export function serializeBrowserScenario(input) {
  if (!isRecord(input)) throw problem('Проверьте шаги сценария.');
  const envelope = Object.hasOwn(input, 'format') || Object.hasOwn(input, 'version')
    ? input : { format, version, ...input };
  return JSON.stringify(normalize(envelope), null, 2) + '\n';
}
