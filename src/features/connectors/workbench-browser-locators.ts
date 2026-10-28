import type { Frame, Locator, Page } from 'playwright';
import type { StableBrowserLocator } from '../../domain/workbench/browser-scenario';
import { ConnectorError, type PrivateProfile } from './contracts';
import { checkedUrl } from './transport';

type Surface = Page | Frame;
const authPath = /login|sign.?in|sso|oauth|saml|authorize/i;

function locate(surface: Surface, locator: StableBrowserLocator): Locator {
  if (locator.kind === 'role') return surface.getByRole(locator.role, { name: locator.name, exact: true });
  if (locator.kind === 'label') return surface.getByLabel(locator.text, { exact: true });
  return surface.locator(locator.selector);
}

function reportUrl(surface: Surface, profile: PrivateProfile, origin: string) {
  const url = checkedUrl(surface.url(), profile);
  if (url.origin !== origin) throw new ConnectorError('configuration_required', 'Сценарий поддерживает только фрейм источника с тем же origin');
  if (authPath.test(url.pathname)) throw new ConnectorError('manual_login_required', 'Завершите вход вручную перед выполнением сценария');
}

async function unique(surface: Surface, locator: StableBrowserLocator): Promise<Locator> {
  const resolved = locate(surface, locator);
  if (await resolved.count() !== 1) throw new ConnectorError('configuration_required', 'Элемент сценария не найден однозначно. Повторите запись этого действия');
  return resolved;
}

/** Resolve one declared target without guessing indices or crossing into an SSO frame. */
export async function resolveRecordedLocator(page: Page, framePath: StableBrowserLocator[] | undefined, locator: StableBrowserLocator, profile: PrivateProfile): Promise<Locator> {
  const origin = checkedUrl(page.url(), profile).origin;
  reportUrl(page, profile, origin);
  let surface: Surface = page;
  for (const frameLocator of framePath ?? []) {
    const element = await (await unique(surface, frameLocator)).elementHandle();
    const frame = await element?.contentFrame();
    if (!frame) throw new ConnectorError('configuration_required', 'Не найден поддерживаемый фрейм отчёта');
    reportUrl(frame, profile, origin);
    surface = frame;
  }
  return unique(surface, locator);
}
