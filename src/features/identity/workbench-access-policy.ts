import { hostname as osHostname } from 'node:os';
import { z } from 'zod';
import { utcInstantSchema, uuidSchema, type Clock, type UUIDv4, type UtcInstant } from '../../domain/workbench/primitives';
import { ownPolicyCacheValueSchema, type OwnPolicyCache } from './workbench-policy-cache';

export type Capability = 'business.read' | 'capture.local' | 'calculation.local' | 'personal.write' | 'uor.prepare' | 'package.submit' | 'publication.apply' | 'workspace.backup';
export type OwnAccessProfile = { role: 'viewer' | 'curator' | 'chief'; displayName: string | null; personId: UUIDv4 | null; policyState: 'verified' | 'offline_cached' | 'unavailable' | 'revoked' | 'invalid' | 'local_preview'; checkedAt: UtcInstant | null };
export interface AccessPolicyService {
  resolveOwnAccess(): Promise<OwnAccessProfile>;
  assertCommandAllowed(commandName: string): Promise<OwnAccessProfile>;
  assertFreshPublishAllowed(operationId: UUIDv4): Promise<OwnAccessProfile>;
}
export interface RegistryReadPort { readAccepted(): Promise<{ commit: string; value: unknown }> }
export class RegistryReadError extends Error {
  constructor(public readonly kind: 'network' | 'timeout' | 'auth_expired' | 'forbidden' | 'invalid', message: string = kind) { super(message); this.name = 'RegistryReadError'; }
}
export class AccessPolicyError extends Error {
  constructor(public readonly code: 'ACCESS_DENIED' | 'ACCESS_RECHECK_REQUIRED' | 'LOCAL_PREVIEW_ONLY', message: string) { super(message); this.name = 'AccessPolicyError'; }
  readonly statusCode = 403;
}
export const serverHostname = osHostname;

/** BP-02 must supply a real accepted-branch reader; absence is never a verified grant. */
export function createUnavailableRegistryReadPort(): RegistryReadPort & { readiness: 'not_ready' } {
  return { readiness: 'not_ready', async readAccepted() { throw new RegistryReadError('network', 'REGISTRY_NOT_READY: accepted private registry reader is not configured'); } };
}

export function canUseCapability(profile: OwnAccessProfile, capability: Capability): boolean {
  switch (capability) {
    case 'business.read': case 'capture.local': case 'calculation.local': case 'personal.write': case 'publication.apply': case 'workspace.backup': return true;
    case 'uor.prepare': return profile.role !== 'viewer' && (profile.policyState === 'verified' || profile.policyState === 'offline_cached' || profile.policyState === 'local_preview');
    case 'package.submit': return profile.role !== 'viewer' && profile.policyState === 'verified';
    default: return false;
  }
}
/** Registry maintenance is separate from the ordinary preparation panel and from Bitbucket ACL. */
export function canEditRegistry(profile: OwnAccessProfile): boolean { return profile.role === 'chief' && profile.policyState === 'verified'; }

const hostSchema = z.string().trim().min(1).max(255).transform(value => value.toLowerCase());
const registrySchema = z.strictObject({
  schemaVersion: z.literal(1),
  profiles: z.array(z.strictObject({ hostname: hostSchema, displayName: z.string().trim().min(1).max(500), personId: uuidSchema, role: z.enum(['viewer', 'curator', 'chief']), enabled: z.boolean() })),
  serviceSettings: z.record(z.string(), z.unknown()),
}).superRefine((registry, context) => {
  const hosts = new Set<string>();
  for (const profile of registry.profiles) {
    if (hosts.has(profile.hostname)) context.addIssue({ code: 'custom', message: 'Duplicate normalized hostname' });
    hosts.add(profile.hostname);
  }
});

export function createAccessPolicyService(options: {
  hostname: () => string; registry: RegistryReadPort; cache: OwnPolicyCache; installationId: UUIDv4;
  mainRepositoryId: string; serviceRepositoryId: string; clock: Clock; capabilityFor: (name: string) => Capability;
}): AccessPolicyService {
  uuidSchema.parse(options.installationId);
  if (!options.mainRepositoryId.trim() || !options.serviceRepositoryId.trim()) throw new Error('Both repository identifiers are required');
  // A failed invalidation must never resurrect an older cache during this process.
  let cacheRevoked = false;
  const invalidate = () => { cacheRevoked = true; try { options.cache.invalidate(); } catch { /* Remain fail-closed even if the private disk is unavailable. */ } };
  const viewer = (policyState: OwnAccessProfile['policyState'], checkedAt: UtcInstant | null = null): OwnAccessProfile => ({ role: 'viewer', displayName: null, personId: null, policyState, checkedAt });

  async function resolveOwnAccess(): Promise<OwnAccessProfile> {
    let hostname: string;
    let checkedAt: UtcInstant;
    try { hostname = hostSchema.parse(options.hostname()); checkedAt = utcInstantSchema.parse(options.clock.now()); }
    catch { invalidate(); return viewer('invalid'); }
    let accepted: { commit: string; value: unknown };
    try { accepted = await options.registry.readAccepted(); }
    catch (error) {
      if (!(error instanceof RegistryReadError)) { invalidate(); return viewer('invalid', checkedAt); }
      if (error.kind === 'forbidden' || error.kind === 'invalid') { invalidate(); return viewer(error.kind === 'forbidden' ? 'revoked' : 'invalid', checkedAt); }
      if (!cacheRevoked) {
        try {
          const parsed = ownPolicyCacheValueSchema.safeParse(options.cache.read());
          if (parsed.success) {
            const cached = parsed.data;
            if (cached.hostname === hostname && cached.installationId === options.installationId && cached.mainRepositoryId === options.mainRepositoryId && cached.serviceRepositoryId === options.serviceRepositoryId && Date.parse(cached.checkedAt) <= Date.parse(checkedAt)) {
              return { role: cached.role, displayName: cached.displayName, personId: cached.personId, policyState: 'offline_cached', checkedAt: cached.checkedAt };
            }
          }
        } catch { /* A cache read failure is absence of a grant. */ }
      }
      return viewer('unavailable');
    }
    const registry = registrySchema.safeParse(accepted.value);
    if (!registry.success || typeof accepted.commit !== 'string' || !accepted.commit.trim()) { invalidate(); return viewer('invalid', checkedAt); }
    const own = registry.data.profiles.find(profile => profile.hostname === hostname);
    if (!own || !own.enabled || own.role === 'viewer') {
      invalidate();
      return { ...viewer('revoked', checkedAt), displayName: own?.enabled ? own.displayName : null, personId: own?.enabled ? own.personId : null };
    }
    try {
      options.cache.write({ hostname, personId: own.personId, displayName: own.displayName, role: own.role, enabled: true, installationId: options.installationId, mainRepositoryId: options.mainRepositoryId, serviceRepositoryId: options.serviceRepositoryId, registryCommit: accepted.commit, checkedAt });
      cacheRevoked = false;
    } catch { invalidate(); return viewer('unavailable', checkedAt); }
    return { role: own.role, displayName: own.displayName, personId: own.personId, policyState: 'verified', checkedAt };
  }

  return {
    resolveOwnAccess,
    async assertCommandAllowed(commandName) {
      // The registry supplies capabilityFor; command names never confer rights by a prefix.
      const capability = options.capabilityFor(commandName);
      const own = await resolveOwnAccess();
      if (!canUseCapability(own, capability)) throw new AccessPolicyError(capability === 'package.submit' && (own.policyState === 'unavailable' || own.policyState === 'offline_cached') ? 'ACCESS_RECHECK_REQUIRED' : 'ACCESS_DENIED', 'The current own profile does not permit this command');
      return own;
    },
    async assertFreshPublishAllowed(operationId) {
      uuidSchema.parse(operationId);
      const own = await resolveOwnAccess();
      if (!canUseCapability(own, 'package.submit')) throw new AccessPolicyError(own.policyState === 'unavailable' || own.policyState === 'offline_cached' ? 'ACCESS_RECHECK_REQUIRED' : 'ACCESS_DENIED', 'A fresh active registry check is required before each external write');
      return own;
    },
  };
}
