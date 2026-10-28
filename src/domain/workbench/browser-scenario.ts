import { z } from 'zod';
import { headerShape, uuidSchema } from './primitives';

const secret = /password|passwd|pwd|secret|token|authorization|cookie|session|credential|saml|otp|api.?key/i;
const text = z.string().trim().min(1).max(1000).refine(value => !secret.test(value), 'Secret locator or parameter forbidden');
const endpoint = z.string().max(4000).url().refine(value => {
  const url = new URL(value);
  return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && ![...url.searchParams.keys()].some(key => secret.test(key) || /^(code|ticket|assertion)$/i.test(key));
}, 'Expected HTTP(S) URL without credentials');
export const browserAriaRoles = ['button', 'link', 'combobox', 'textbox', 'checkbox', 'option', 'tab', 'menuitem', 'radio', 'dialog', 'heading', 'table', 'row', 'cell', 'listbox'] as const;
export type BrowserAriaRole = typeof browserAriaRoles[number];
export const stableBrowserLocatorSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('css'), selector: text }),
  z.strictObject({ kind: z.literal('role'), role: z.enum(browserAriaRoles), name: text, exact: z.literal(true) }),
  z.strictObject({ kind: z.literal('label'), text, exact: z.literal(true) }),
]);
export type StableBrowserLocator = z.infer<typeof stableBrowserLocatorSchema>;
const located = { locator: stableBrowserLocatorSchema, framePath: z.array(stableBrowserLocatorSchema).min(1).max(8).optional() };
export const recordedBrowserStepSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('goto'), url: endpoint }),
  z.strictObject({ action: z.literal('click'), ...located }),
  z.strictObject({ action: z.literal('wait'), ...located }),
  z.strictObject({ action: z.literal('download'), ...located }),
  z.strictObject({ action: z.literal('fill'), ...located, parameter: text }),
  z.strictObject({ action: z.literal('select'), ...located, parameter: text }),
  z.strictObject({ action: z.literal('check'), ...located, checked: z.boolean() }),
]);
export type RecordedBrowserStep = z.infer<typeof recordedBrowserStepSchema>;
export const browserScenarioDefinitionSchema = z.strictObject({
  ...headerShape, sourceId: uuidSchema, startUrl: endpoint, authenticatedSelector: text,
  steps: z.array(recordedBrowserStepSchema).min(1).max(100).refine(steps => steps.at(-1)?.action === 'download' && steps.filter(step => step.action === 'download').length === 1, 'Exactly one final download required'),
  parameters: z.record(text, z.string().max(2000).refine(value => !/^\s*(Bearer|Basic)\s+\S|-----BEGIN .*PRIVATE KEY-----/i.test(value), 'Secret value forbidden')),
  expectedExport: z.strictObject({ format: z.enum(['csv', 'xlsx']), requiredColumns: z.array(z.string().trim().min(1).max(1000)).min(1).max(1000).refine(columns => new Set(columns).size === columns.length) }),
});
export type BrowserScenarioDefinition = z.infer<typeof browserScenarioDefinitionSchema>;
