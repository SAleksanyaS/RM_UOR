import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { Clock, UUIDv4 } from '../../domain/workbench';
import { uuidSchema } from '../../domain/workbench';
import type { WorkbenchRepository } from '../../server/storage/workbench-repository';
import type { CommandContext } from '../../server/workbench/command-registry';
import type { QueryContext } from '../../server/workbench/query-registry';
import { WorkbenchHttpError } from '../../server/workbench/protocol';
import { safeArtifactPath } from '../../server/workspace/paths';
import { ConnectorError, privateProfileSchema, type PrivateProfile } from './contracts';
import { readPrivateProfiles, savePrivateProfile } from './private-config';
import { browserProfilePath, withProfileQueue } from './transport';
import { browserOwnerRoot } from './workbench-browser-runtime';
export type BrowserProfileBinding = { sourceId: UUIDv4; profileId: string };
export type BrowserProfileView = { sourceId: UUIDv4; profileId: string | null; profile: PrivateProfile | null; revision: string | null; configured: boolean; sessionState: 'closed' | 'open' | 'authentication_required' | 'authenticated' };
export interface BrowserProfileService {
  set(context: CommandContext, input: { sourceId: UUIDv4; profileId: string; profile: PrivateProfile; expectedRevision: string | null }): Promise<{ profileId: string; revision: string }>;
  getOwn(context: QueryContext, sourceId: UUIDv4): Promise<BrowserProfileView>;
}
const profileIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/);
const bindingsSchema = z.record(uuidSchema, profileIdSchema);
function revision(profileRevision: string | null, sourceBindings: Record<string, string>): string | null {
  return profileRevision === null && Object.keys(sourceBindings).length === 0 ? null : createHash('sha256').update(JSON.stringify({ profileRevision, bindings: Object.entries(sourceBindings).sort(([a], [b]) => a.localeCompare(b)) })).digest('hex');
}
const owner = (context: QueryContext) => ({ installationId: context.installationId, profilePersonId: context.ownAccess.personId });
async function bindings(root: string) {
  const file = await safeArtifactPath(root, 'local-config/browser-sources.json');
  try { return bindingsSchema.parse(JSON.parse(await readFile(file, 'utf8'))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error; }
}
/** Personal bindings deliberately live outside portable business SQLite and packages. */
export function createBrowserProfileService({ runtimeRoot, observeSession }: { runtimeRoot: string; repository: WorkbenchRepository; clock: Clock;
  observeSession?: (owner: { installationId: string; profilePersonId: string | null }, profileId: string) => BrowserProfileView['sessionState'] }): BrowserProfileService {
  return {
    async set(context, input) {
      uuidSchema.parse(input.sourceId); profileIdSchema.parse(input.profileId);
      const profile = privateProfileSchema.parse(input.profile);
      if (!profile.browser || !profile.allowedOrigins.every(value => { const url = new URL(value); return url.origin === value; }))
        throw new WorkbenchHttpError(422, 'BROWSER_CONFIGURATION_INVALID', 'Configure a browser and exact origins');
      if (profile.browser.executablePath) {
        try { if (!path.isAbsolute(profile.browser.executablePath) || !(await stat(profile.browser.executablePath)).isFile()) throw Error(); }
        catch { throw new WorkbenchHttpError(422, 'BROWSER_CONFIGURATION_INVALID', 'Browser executable must be an existing local file'); }
      } else if (!profile.browser.channel) throw new WorkbenchHttpError(422, 'BROWSER_CONFIGURATION_INVALID', 'Configure an executable or installed browser channel');
      const root = await browserOwnerRoot(runtimeRoot, owner(context)); await browserProfilePath(root, profile);
      return withProfileQueue(`${root}:browser-bindings`, AbortSignal.timeout(10000), async () => {
        const current = await readPrivateProfiles(root);
        const value = await bindings(root);
        if (revision(current.revision, value) !== input.expectedRevision) throw new WorkbenchHttpError(409, 'REVISION_CONFLICT', 'Personal browser settings changed');
        let saved;
        try { saved = await savePrivateProfile(root, input.profileId, profile, current.revision); }
        catch (error) { if (error instanceof ConnectorError && error.message.includes('уже изменились')) throw new WorkbenchHttpError(409, 'REVISION_CONFLICT', 'Personal browser settings changed'); throw error; }
        value[input.sourceId] = input.profileId;
        const directory = await safeArtifactPath(root, 'local-config'); await mkdir(directory, { recursive: true });
        const target = await safeArtifactPath(root, 'local-config/browser-sources.json'), temporary = path.join(directory, `browser-sources-${randomUUID()}.tmp`);
        await writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 }); await rename(temporary, target);
        return { profileId: input.profileId, revision: revision(saved.revision, value)! };
      });
    },
    async getOwn(context, sourceId) {
      uuidSchema.parse(sourceId); const own = owner(context), root = await browserOwnerRoot(runtimeRoot, own);
      const current = await readPrivateProfiles(root), sourceBindings = await bindings(root), profileId = sourceBindings[sourceId] ?? null, profile = profileId ? current.profiles[profileId] ?? null : null;
      return { sourceId, profileId, profile, revision: revision(current.revision, sourceBindings), configured: profile !== null, sessionState: profileId ? observeSession?.(own, profileId) ?? 'closed' : 'closed' };
    },
  };
}
