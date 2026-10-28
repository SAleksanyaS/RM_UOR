import { expect, it } from 'vitest';
import { z } from 'zod';
import { validateModules, validateRegisteredPayload, type PlatformModule } from './modules';

const module = (id: string): PlatformModule => ({ id, version: '1.0.0', platformContractVersion: 1, dependsOn: [], owns: { entityTypes: [], namespaces: [id] }, schemas: [], queries: [], commands: [], hooks: {} });
it('rejects_cycles_ownership_and_unknown_schemas', () => {
  const a = module('alpha'), b = module('beta'); a.dependsOn = ['beta']; b.dependsOn = ['alpha'];
  expect(() => validateModules([a, b])).toThrow(/depend/i);
  a.dependsOn = []; b.dependsOn = []; b.owns.namespaces = ['alpha'];
  expect(() => validateModules([a, b])).toThrow(/owner/i);
  expect(() => validateRegisteredPayload([a], { schemaId: 'alpha.unknown', schemaVersion: 1, value: {} })).toThrowError(expect.objectContaining({ code: 'SCHEMA_UNSUPPORTED' }));
  a.schemas = [{ schemaId: 'alpha.note.v1', schemaVersion: 1, ownerModuleId: 'alpha', inputSchema: z.strictObject({ note: z.string() }) }];
  expect(validateRegisteredPayload([a], { schemaId: 'alpha.note.v1', schemaVersion: 1, value: { note: 'Saved' } })).toEqual({ note: 'Saved' });
  expect(() => validateRegisteredPayload([a], { schemaId: 'alpha.note.v1', schemaVersion: 1, value: { sql: 'select' } })).toThrow();
});
it('rejects_duplicate_contracts_navigation_and_invalid_versions', () => {
  const a = module('alpha'), b = module('beta');
  b.platformContractVersion = 2;
  expect(() => validateModules([a, b])).toThrowError(expect.objectContaining({ code: 'SCHEMA_UNSUPPORTED' }));
  b.platformContractVersion = 1; b.version = 'invalid'; expect(() => validateModules([a, b])).toThrow(/version/i);
  b.version = '1.0.0'; a.hooks.navigation = [{ route: '/tool', label: 'Tool', order: 1, screen: 'tool', accessHint: 'business.read' }];
  b.hooks.navigation = a.hooks.navigation; expect(() => validateModules([a, b])).toThrow(/navigation/i);
  b.hooks.navigation = [{ route: '/overview', label: 'Another title', order: 1, screen: 'tool', accessHint: 'business.read' }];
  expect(() => validateModules([b])).toThrow(/navigation/i);
  b.hooks.navigation = [{ route: '/another', label: 'Обзор', order: 1, screen: 'tool', accessHint: 'business.read' }];
  expect(() => validateModules([b])).toThrow(/navigation/i);
});
it('rejects_unknown_manifest_fields_and_cross_owner_local_commands', () => {
  const a = module('alpha');
  expect(() => validateModules([{ ...a, loader: 'user-code' } as PlatformModule])).toThrowError(expect.objectContaining({ code: 'SCHEMA_UNSUPPORTED' }));
  a.commands = [{ name: 'beta.local.save', inputSchema: z.strictObject({}), outputSchema: z.strictObject({}), capability: 'uor.prepare', effect: 'sharedDraft', execution: 'sync', handler: async () => ({ result: {}, changedRefs: [], editToken: null }) }];
  expect(() => validateModules([a])).toThrowError(expect.objectContaining({ code: 'SCHEMA_UNSUPPORTED' }));
  const b = module('beta'); b.dependsOn = ['absent']; expect(() => validateModules([b])).toThrow(/depend/i);
});
