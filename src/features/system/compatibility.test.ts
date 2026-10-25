import { expect, it } from 'vitest';
import { assertCompatibleRelease, createReleaseManifest, versionAtLeast } from './compatibility';
it('rejects an unsupported release before any data can be accepted', () => {
  const manifest = { ...createReleaseManifest(), minimumApplicationVersion: '99.0.0' };
  expect(() => assertCompatibleRelease({ 'catalog/manifest.json': JSON.stringify(manifest) })).toThrow(/обнов/i);
  expect(() => assertCompatibleRelease({ 'catalog/manifest.json': '{broken' })).toThrow();
});
it('supports older catalogs explicitly but rejects unknown required features', () => {
  expect(() => assertCompatibleRelease({})).not.toThrow();
  expect(() => assertCompatibleRelease({ 'catalog/manifest.json': JSON.stringify({ ...createReleaseManifest(), requiredFeatures: ['remote-code-execution'] }) })).toThrow(/возможност/i);
  expect(versionAtLeast('0.10.0', '0.2.0')).toBe(true); expect(versionAtLeast('0.2.0', '0.2.1')).toBe(false);
});
