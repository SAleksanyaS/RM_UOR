import { randomUUID } from 'node:crypto';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { utcInstantSchema, uuidSchema, type Clock, type UUIDv4 } from '../../domain/workbench/primitives';
import { AccessPolicyError, canUseCapability, type AccessPolicyService, type Capability, type OwnAccessProfile } from '../../features/identity/workbench-access-policy';
import { safeArtifactPath } from '../workspace/paths';

const roleSchema = z.enum(['viewer', 'curator']);
const savedRoleSchema = z.strictObject({ schemaVersion: z.literal(1), role: roleSchema });
export type LocalPreviewRole = z.infer<typeof roleSchema>;
export type LocalPreviewPolicy = AccessPolicyService & { setRole(role: LocalPreviewRole): Promise<void> };

/** This isolated Oko preview never creates an accepted-registry grant. */
export function createLocalPreviewPolicy(options: { directory: string; personId: UUIDv4; clock: Clock; capabilityFor(name: string): Capability }): LocalPreviewPolicy {
  const directory = path.resolve(options.directory);
  const personId = uuidSchema.parse(options.personId);
  const file = () => safeArtifactPath(directory, 'oko-local-role.json');
  const readRole = async (): Promise<LocalPreviewRole> => {
    try { return savedRoleSchema.parse(JSON.parse(await readFile(await file(), 'utf8'))).role; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'curator';
      throw new AccessPolicyError('ACCESS_DENIED', 'Local preview role file is invalid or unavailable');
    }
  };
  const resolveOwnAccess = async (): Promise<OwnAccessProfile> => ({
    role: await readRole(), personId, displayName: null, policyState: 'local_preview', checkedAt: utcInstantSchema.parse(options.clock.now()),
  });
  return {
    resolveOwnAccess,
    async assertCommandAllowed(name) {
      const capability = options.capabilityFor(name);
      if (capability === 'package.submit' || capability === 'publication.apply') throw new AccessPolicyError('LOCAL_PREVIEW_ONLY', 'Publication is unavailable in local preview');
      const own = await resolveOwnAccess();
      if (!canUseCapability(own, capability)) throw new AccessPolicyError('ACCESS_DENIED', 'The local preview role does not permit this command');
      return own;
    },
    async assertFreshPublishAllowed() { throw new AccessPolicyError('LOCAL_PREVIEW_ONLY', 'Publication is unavailable in local preview'); },
    async setRole(role) {
      const value = savedRoleSchema.parse({ schemaVersion: 1, role });
      const target = await file();
      const temporary = await safeArtifactPath(directory, `oko-local-role-${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
        await rename(temporary, target);
      } finally { await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); }
    },
  };
}
