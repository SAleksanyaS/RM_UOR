import { describe, expect, it } from 'vitest';
import type { Page } from 'playwright';
import { privateProfileSchema } from './contracts';
import { resolveRecordedLocator } from './workbench-browser-locators';

const profile = privateProfileSchema.parse({ allowedOrigins: ['https://report.example.invalid', 'https://sso.example.invalid'] });
function fixture() {
  const calls: unknown[] = [];
  const targets = new Map<string, ReturnType<typeof target>>();
  function target(count = 1, frame?: ReturnType<typeof surface>) {
    return { count: async () => count, elementHandle: async () => ({ contentFrame: async () => frame ?? null }) };
  }
  function surface(url: string) {
    return {
      url: () => url,
      locator: (selector: string) => { calls.push(['css', selector]); return targets.get(selector) ?? target(); },
      getByRole: (role: string, options: unknown) => { calls.push(['role', role, options]); return target(); },
      getByLabel: (text: string, options: unknown) => { calls.push(['label', text, options]); return target(); },
    };
  }
  const page = surface('https://report.example.invalid/report');
  return { page: page as unknown as Page, calls, targets, target, surface };
}

describe('recorded browser locator resolution', () => {
  it('uses exact role and label matching and refuses ambiguous selectors', async () => {
    const f = fixture();
    await resolveRecordedLocator(f.page, undefined, { kind: 'role', role: 'button', name: 'Export', exact: true }, profile);
    await resolveRecordedLocator(f.page, undefined, { kind: 'label', text: 'Period', exact: true }, profile);
    expect(f.calls).toEqual([['role', 'button', { name: 'Export', exact: true }], ['label', 'Period', { exact: true }]]);
    for (const count of [0, 2]) {
      f.targets.set('#export', f.target(count));
      await expect(resolveRecordedLocator(f.page, undefined, { kind: 'css', selector: '#export' }, profile)).rejects.toThrow(/однознач/);
    }
  });

  it('resolves nested report frames only when each frame belongs to the report origin', async () => {
    const f = fixture();
    const reportFrame = f.surface('https://report.example.invalid/sheet');
    f.targets.set('#report', f.target(1, reportFrame));
    await resolveRecordedLocator(f.page, [{ kind: 'css', selector: '#report' }], { kind: 'css', selector: '#export' }, profile);
    expect(f.calls).toEqual([['css', '#report'], ['css', '#export']]);
    f.targets.set('#report', f.target(1, f.surface('https://sso.example.invalid/authorize')));
    await expect(resolveRecordedLocator(f.page, [{ kind: 'css', selector: '#report' }], { kind: 'css', selector: '#export' }, profile)).rejects.toThrow(/фрейм/);
    f.targets.set('#report', f.target(1, f.surface('https://report.example.invalid/login')));
    await expect(resolveRecordedLocator(f.page, [{ kind: 'css', selector: '#report' }], { kind: 'css', selector: '#export' }, profile)).rejects.toThrow(/вход/);
    f.targets.set('#report', f.target(1));
    await expect(resolveRecordedLocator(f.page, [{ kind: 'css', selector: '#report' }], { kind: 'css', selector: '#export' }, profile)).rejects.toThrow(/фрейм/);
  });
});
