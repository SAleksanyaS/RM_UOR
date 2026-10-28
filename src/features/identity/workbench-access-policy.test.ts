import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canEditRegistry, canUseCapability, createAccessPolicyService, createUnavailableRegistryReadPort, RegistryReadError, type Capability } from './workbench-access-policy';
import { createOwnPolicyCache, type OwnPolicyCacheValue } from './workbench-policy-cache';

const installationId = '11111111-1111-4111-8111-111111111111';
const personId = '22222222-2222-4222-8222-222222222222';
const now = '2026-10-28T04:00:00Z';
function fixture() {
  let hostname = ' DEMO-CURATOR-02 ';
  let role = 'curator';
  let enabled = true;
  let failure: unknown;
  let extra: Record<string, unknown>[] = [];
  let cached: OwnPolicyCacheValue | null = null;
  const readAccepted = vi.fn(async () => {
    if (failure) throw failure;
    return { commit: 'a'.repeat(40), value: { schemaVersion: 1, profiles: [{ hostname: 'demo-curator-02', displayName: 'Synthetic curator', personId, role, enabled }, ...extra], serviceSettings: {} } };
  });
  const cache = { read: vi.fn(() => cached), write: vi.fn((value: OwnPolicyCacheValue) => { cached = value; }), invalidate: vi.fn(() => { cached = null; }) };
  const capabilities: Record<string, Capability> = { 'goal.draft.save': 'uor.prepare', 'file.import': 'uor.prepare', 'package.submit': 'package.submit', 'source.capture': 'capture.local', 'calculation.prepare': 'calculation.local', 'preferences.save': 'personal.write', 'test-tool.local.save': 'personal.write', 'publication.apply': 'publication.apply', 'backup.create': 'workspace.backup', 'backup.restore.apply': 'workspace.backup' };
  const options = { hostname: () => hostname, registry: { readAccepted }, cache, installationId, mainRepositoryId: 'synthetic-main', serviceRepositoryId: 'synthetic-private', clock: { now: () => now }, capabilityFor: (name: string) => { if (!capabilities[name]) throw new Error('unregistered'); return capabilities[name]; } };
  return { options, policy: createAccessPolicyService(options), cache, readAccepted, role: (value: string) => { role = value; }, enabled: (value: boolean) => { enabled = value; }, hostname: (value: string) => { hostname = value; }, failure: (value: unknown) => { failure = value; }, extra: (value: Record<string, unknown>[]) => { extra = value; }, cached: () => cached };
}

describe('hostname access policy', () => {
  it('normalizes own hostname and returns only the own projection', async () => {
    const f = fixture();
    f.extra([{ hostname: 'other-host', displayName: 'Private other person', personId, role: 'chief', enabled: true }]);
    const own = await f.policy.resolveOwnAccess();
    expect(own).toEqual({ role: 'curator', displayName: 'Synthetic curator', personId, policyState: 'verified', checkedAt: now });
    expect(f.cached()?.hostname).toBe('demo-curator-02');
    expect(JSON.stringify(own)).not.toMatch(/profiles|other-host|Private other/);
    expect(JSON.stringify(f.cached())).not.toMatch(/profiles|other-host|account/i);
  });
  it.each(['duplicate', 'role', 'person', 'boolean', 'version', 'account'])('rejects invalid registry globally: %s', async kind => {
    const f = fixture();
    await f.policy.resolveOwnAccess();
    if (kind === 'duplicate') f.extra([{ hostname: ' DEMO-CURATOR-02 ', displayName: 'Conflict', personId, role: 'chief', enabled: true }]);
    else if (kind === 'role') f.role('admin');
    else f.readAccepted.mockImplementationOnce(async () => ({ commit: 'b'.repeat(40), value: kind === 'version' ? { schemaVersion: 2, profiles: [], serviceSettings: {} } : { schemaVersion: 1, profiles: [{ hostname: 'demo-curator-02', displayName: 'Synthetic', personId: kind === 'person' ? 'invalid' : personId, role: 'curator', enabled: kind === 'boolean' ? 'true' : true, ...(kind === 'account' ? { accountId: 'forbidden-binding' } : {}) }], serviceSettings: {} } }));
    expect(await f.policy.resolveOwnAccess()).toMatchObject({ role: 'viewer', policyState: 'invalid' });
    expect(f.cached()).toBeNull();
  });
  it.each(['network', 'timeout', 'auth_expired'] as const)('permits only own previously verified local drafts on %s', async kind => {
    const f = fixture();
    f.failure(new RegistryReadError(kind));
    expect(await f.policy.resolveOwnAccess()).toMatchObject({ role: 'viewer', policyState: 'unavailable' });
    f.failure(undefined); await f.policy.resolveOwnAccess(); f.failure(new RegistryReadError(kind));
    expect(await f.policy.assertCommandAllowed('goal.draft.save')).toMatchObject({ role: 'curator', policyState: 'offline_cached', checkedAt: now });
    await expect(f.policy.assertFreshPublishAllowed(installationId)).rejects.toMatchObject({ code: 'ACCESS_RECHECK_REQUIRED', statusCode: 403 });
    f.hostname('other-laptop');
    expect(await f.policy.resolveOwnAccess()).toMatchObject({ role: 'viewer' });
  });
  it.each(['disabled', 'viewer', 'unknown', 'forbidden', 'invalid'] as const)('revokes cached preparation on explicit %s', async kind => {
    const f = fixture(); await f.policy.resolveOwnAccess();
    if (kind === 'disabled') f.enabled(false);
    if (kind === 'viewer') f.role('viewer');
    if (kind === 'unknown') f.hostname('unknown');
    if (kind === 'forbidden' || kind === 'invalid') f.failure(new RegistryReadError(kind));
    await expect(f.policy.assertFreshPublishAllowed(installationId)).rejects.toMatchObject({ statusCode: 403 });
    f.failure(new RegistryReadError('timeout'));
    expect(await f.policy.resolveOwnAccess()).toMatchObject({ role: 'viewer' });
  });
  it('reads registry again for each external write and retry, including after auth wait', async () => {
    const f = fixture();
    await f.policy.assertFreshPublishAllowed(installationId);
    await f.policy.assertFreshPublishAllowed(installationId);
    f.enabled(false);
    await expect(f.policy.assertFreshPublishAllowed(installationId)).rejects.toMatchObject({ statusCode: 403 });
    expect(f.readAccepted).toHaveBeenCalledTimes(3);
  });
  it('binds cache to installation and both repositories; restore cannot activate an old grant', async () => {
    const f = fixture(); await f.policy.resolveOwnAccess(); f.failure(new RegistryReadError('network'));
    for (const changed of [{ installationId: personId }, { mainRepositoryId: 'other-main' }, { serviceRepositoryId: 'other-service' }]) {
      expect(await createAccessPolicyService({ ...f.options, ...changed }).resolveOwnAccess()).toMatchObject({ role: 'viewer' });
    }
    f.cache.invalidate();
    expect(await f.policy.resolveOwnAccess()).toMatchObject({ role: 'viewer' });
  });
  it('fails closed on cache errors and unclassified registry failures', async () => {
    const f = fixture(); await f.policy.resolveOwnAccess();
    f.failure(new RegistryReadError('timeout')); f.cache.read.mockImplementation(() => { throw new Error('IO'); });
    expect(await f.policy.resolveOwnAccess()).toMatchObject({ role: 'viewer' });
    f.failure(new Error('unknown not a typed network outage'));
    expect(await f.policy.resolveOwnAccess()).toMatchObject({ role: 'viewer', policyState: 'invalid' });
  });
  it('never treats a cache write or invalidation failure as a new grant', async () => {
    const f = fixture(); await f.policy.resolveOwnAccess();
    f.cache.write.mockImplementation(() => { throw new Error('disk write failed'); });
    f.cache.invalidate.mockImplementation(() => { throw new Error('disk invalidation failed'); });
    expect(await f.policy.resolveOwnAccess()).toMatchObject({ role: 'viewer', policyState: 'unavailable' });
    f.failure(new RegistryReadError('timeout'));
    expect(await f.policy.resolveOwnAccess()).toMatchObject({ role: 'viewer' });
  });
  it('viewer can use local portal commands but cannot import, prepare, or submit', async () => {
    const f = fixture(); f.role('viewer');
    for (const name of ['source.capture', 'calculation.prepare', 'preferences.save', 'test-tool.local.save', 'publication.apply', 'backup.create', 'backup.restore.apply']) await expect(f.policy.assertCommandAllowed(name)).resolves.toMatchObject({ role: 'viewer' });
    for (const name of ['file.import', 'goal.draft.save', 'package.submit']) await expect(f.policy.assertCommandAllowed(name)).rejects.toMatchObject({ statusCode: 403 });
    await expect(f.policy.assertCommandAllowed('unregistered.local.save')).rejects.toThrow('unregistered');
  });
  it('curator and chief have equal preparation capabilities; only verified chief can maintain registry', async () => {
    const f = fixture(); const curator = await f.policy.resolveOwnAccess(); f.role('chief'); const chief = await f.policy.resolveOwnAccess();
    for (const capability of ['business.read', 'capture.local', 'calculation.local', 'personal.write', 'uor.prepare', 'package.submit', 'publication.apply', 'workspace.backup'] as Capability[]) expect(canUseCapability(curator, capability)).toBe(canUseCapability(chief, capability));
    expect(canEditRegistry(curator)).toBe(false); expect(canEditRegistry(chief)).toBe(true); expect(canEditRegistry({ ...chief, policyState: 'offline_cached' })).toBe(false);
  });
  it('unconfigured corporate adapter explicitly remains not_ready', async () => {
    const registry = createUnavailableRegistryReadPort(); expect(registry.readiness).toBe('not_ready');
    const f = fixture(); expect(await createAccessPolicyService({ ...f.options, registry }).resolveOwnAccess()).toMatchObject({ role: 'viewer', policyState: 'unavailable' });
  });
});

const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });
describe('private own-policy cache adapter', () => {
  it('persists strictly own verified profile separately and invalidates without an export hook', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'uor-own-policy-')); temporary.push(directory);
    const cache = createOwnPolicyCache({ directory }); const f = fixture(); await f.policy.resolveOwnAccess();
    cache.write(f.cached()!);
    expect(createOwnPolicyCache({ directory }).read()).toEqual(f.cached());
    expect(Object.keys(cache).sort()).toEqual(['invalidate', 'read', 'write']);
    expect(readFileSync(join(directory, 'own-policy.json'), 'utf8')).not.toContain('profiles');
    writeFileSync(join(directory, 'own-policy.json'), '{broken', 'utf8'); expect(cache.read()).toBeNull();
    cache.invalidate(); expect(cache.read()).toBeNull();
  });
  it('rejects relative private paths and symlink directories', () => {
    expect(() => createOwnPolicyCache({ directory: 'relative-private' })).toThrow();
    const root = mkdtempSync(join(tmpdir(), 'uor-own-policy-')); temporary.push(root);
    const target = join(root, 'target'); mkdirSync(target); const link = join(root, 'link'); symlinkSync(target, link, 'junction');
    expect(() => createOwnPolicyCache({ directory: link })).toThrow(/link|junction/i);
  });
});
