import { describe, expect, it } from 'vitest';
import { browserScenarioDefinitionSchema, recordedBrowserStepSchema, stableBrowserLocatorSchema } from './browser-scenario';

const scenario = () => ({ schemaVersion: 1, id: '00000000-0000-4000-8000-000000000001', revision: 1,
  recordedAt: '2026-10-28T09:00:00Z', actor: { hostname: 'fixture', installationId: '00000000-0000-4000-8000-000000000002', profilePersonId: null }, publicationAnchorId: null,
  sourceId: '00000000-0000-4000-8000-000000000003', startUrl: 'https://report.example.invalid/report', authenticatedSelector: '#report',
  steps: [{ action: 'download', locator: { kind: 'role', role: 'button', name: 'Export', exact: true } }], parameters: {}, expectedExport: { format: 'csv', requiredColumns: ['Value'] } });
describe('browser scenario owner schema', () => {
  it('requires one final download and rejects unsupported actions and roles', () => {
    expect(browserScenarioDefinitionSchema.safeParse(scenario()).success).toBe(true);
    expect(browserScenarioDefinitionSchema.safeParse({ ...scenario(), steps: [] }).success).toBe(false);
    expect(browserScenarioDefinitionSchema.safeParse({ ...scenario(), steps: [...scenario().steps, ...scenario().steps] }).success).toBe(false);
    expect(browserScenarioDefinitionSchema.safeParse({ ...scenario(), steps: [...scenario().steps, { action: 'wait', locator: { kind: 'css', selector: '#ready' } }] }).success).toBe(false);
    expect(recordedBrowserStepSchema.safeParse({ action: 'evaluate', script: 'return 1' }).success).toBe(false);
    expect(stableBrowserLocatorSchema.safeParse({ kind: 'role', role: 'invented', name: 'Export', exact: true }).success).toBe(false);
  });
  it('rejects credentials, unsafe parameters, ambiguous export contract and oversized recordings', () => {
    for (const startUrl of ['file:///tmp/report', 'https://person:password@report.example.invalid/', 'https://report.example.invalid/?access_token=secret'])
      expect(browserScenarioDefinitionSchema.safeParse({ ...scenario(), startUrl }).success).toBe(false);
    expect(browserScenarioDefinitionSchema.safeParse({ ...scenario(), parameters: { password: 'synthetic' } }).success).toBe(false);
    expect(browserScenarioDefinitionSchema.safeParse({ ...scenario(), expectedExport: { format: 'csv', requiredColumns: ['Value', 'Value'] } }).success).toBe(false);
    expect(browserScenarioDefinitionSchema.safeParse({ ...scenario(), steps: Array(101).fill(scenario().steps[0]) }).success).toBe(false);
    expect(recordedBrowserStepSchema.safeParse({ action: 'click', locator: { kind: 'css', selector: '#export' }, framePath: [] }).success).toBe(false);
  });
});
