import { z } from 'zod';
import { browserOwnDraftSchema, resolveBrowserSource } from './workbench-browser-binding';
import type { DraftService } from '../catalog/workbench-drafts';
import { browserScenarioDefinitionSchema, recordedBrowserStepSchema } from '../../domain/workbench/browser-scenario';
import { uuidSchema, versionRefSchema } from '../../domain/workbench/primitives';
import { WorkbenchError } from '../../domain/workbench/errors';
import type { CommandContext, CommandDescriptor, CommandOutcome, CommandRegistry } from '../../server/workbench/command-registry';
import { createCommandStore } from '../../server/workbench/command-store';
import { queryRequestSchema, ownQueryRequestSchema, WorkbenchHttpError } from '../../server/workbench/protocol';
import type { QueryRegistry } from '../../server/workbench/query-registry';
import { partialSchema } from '../catalog/workbench-drafts';
import { draftSaveResultSchema } from '../catalog/workbench-draft-commands';
import { canUseCapability } from '../identity/workbench-access-policy';
import { ConnectorError, privateProfileSchema } from './contracts';
import type { BrowserProfileService } from './workbench-browser-profile';
import type { BrowserRecorderService } from './workbench-browser-recorder';
import { browserScenarioTestResultSchema, type BrowserScenarioService } from './workbench-browser-scenarios';

/** T45 supplies the real login owner. Registration never invents an authenticated session. */
export interface BrowserLoginService {
  open(context: CommandContext, input: { sourceRef: import('../../domain/workbench/primitives').VersionRef }): Promise<{ loginId: string; windowOpened: true }>;
  finish(context: CommandContext, input: { loginId: string }): Promise<{ loginId: string; authenticated: boolean }>;
}
export type BrowserServices = { profiles: BrowserProfileService; recorder: BrowserRecorderService; login: BrowserLoginService; scenarios: BrowserScenarioService };
const sourceRefSchema = versionRefSchema.refine(ref => ref.entityType === 'source_definition');
export const browserProfileViewSchema = z.strictObject({ sourceId: uuidSchema, profileId: z.string().nullable(), profile: privateProfileSchema.nullable(), revision: z.string().nullable(), configured: z.boolean(), sessionState: z.enum(['closed', 'open', 'authentication_required', 'authenticated']) });
const recordedScenarioSchema = z.strictObject({ recordingId: uuidSchema, startUrl: browserScenarioDefinitionSchema.shape.startUrl, authenticatedSelector: browserScenarioDefinitionSchema.shape.authenticatedSelector, steps: z.array(recordedBrowserStepSchema), parameterNames: z.array(z.string()), screenshotHandles: z.array(uuidSchema), hasDownload: z.boolean(), bindingProblem: z.string().nullable().optional() });

export function registerBrowserCommands(registry: CommandRegistry, services: BrowserServices): void {
  const bind = <I, O>(name: string, inputSchema: z.ZodType<I>, outputSchema: z.ZodType<O>, capability: CommandDescriptor<I, O>['capability'], execution: 'sync' | 'async', action: (context: CommandContext, input: I) => Promise<O>, shared = false) => {
    registry.register({ name, inputSchema, outputSchema, capability, execution, effect: shared ? 'sharedDraft' : 'local', ownership: capability === 'uor.prepare' ? 'person' : 'person-if-present', resourceKey: () => 'browser:owned-profile', async handler(context, payload) {
      let result: O;
      try { result = await action(context, payload); }
      catch (error) {
        if (error instanceof ConnectorError) {
          const code = 'diagnosticCode' in error && (error.diagnosticCode === 'SELECTOR_NOT_FOUND' || error.diagnosticCode === 'SELECTOR_NOT_UNIQUE') ? error.diagnosticCode : ({ configuration_required: 'BROWSER_CONFIGURATION_REQUIRED', manual_required: 'AUTH_REQUIRED', manual_login_required: 'AUTH_REQUIRED', access_denied: 'SOURCE_ACCESS_DENIED', network: 'SOURCE_UNAVAILABLE', certificate: 'SOURCE_CERTIFICATE_REQUIRED', timeout: 'SOURCE_TIMEOUT', format: 'SOURCE_SCHEMA_CHANGED', incomplete: 'DOWNLOAD_REQUIRED', cancelled: 'SOURCE_CANCELLED', browser_launch: 'BROWSER_LAUNCH_FAILED' } as const)[error.code];
          throw new WorkbenchHttpError(422, code, error.message, error.detail ? [{ path: '/cause', code: error.reason ?? code, message: error.detail, ref: null }] : []);
        }
        if (error instanceof WorkbenchError) throw new WorkbenchHttpError(['REFERENCE_NOT_FOUND','BROKEN_REFERENCE'].includes(error.code) ? 404 : 422, error.code, 'Browser definition validation failed'); throw error;
      }
      const receipt = createCommandStore(context.repository).get(context.installationId, context.commandId)?.receipt_json;
      if (receipt) return JSON.parse(receipt) as CommandOutcome<O>;
      if (shared) throw Error('Scenario save did not commit an atomic draft receipt');
      return { result, changedRefs: [], editToken: null };
    } });
  };
  bind('source.browser.profile.set', z.strictObject({ sourceId: uuidSchema, profileId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/), profile: privateProfileSchema, expectedRevision: z.string().nullable() }), z.strictObject({ profileId: z.string(), revision: z.string().min(1) }), 'personal.write', 'sync', (context, input) => services.profiles.set(context, input));
  bind('source.browser.login.open', z.strictObject({ sourceRef: sourceRefSchema }), z.strictObject({ loginId: uuidSchema, windowOpened: z.literal(true) }), 'capture.local', 'async', (context, input) => services.login.open(context, input));
  bind('source.browser.login.finish', z.strictObject({ loginId: uuidSchema }), z.strictObject({ loginId: uuidSchema, authenticated: z.boolean() }), 'capture.local', 'sync', (context, input) => services.login.finish(context, input));
  bind('source.browser.record.start', z.strictObject({ sourceRef: sourceRefSchema, ownDraft: browserOwnDraftSchema.optional(), startUrl: browserScenarioDefinitionSchema.shape.startUrl, authenticatedSelector: browserScenarioDefinitionSchema.shape.authenticatedSelector }), z.strictObject({ recordingId: uuidSchema, state: z.literal('recording') }), 'uor.prepare', 'async', (context, input) => services.recorder.start(context, input));
  bind('source.browser.marker.select', z.strictObject({ sourceRef: sourceRefSchema, ownDraft: browserOwnDraftSchema.optional(), startUrl: browserScenarioDefinitionSchema.shape.startUrl }), z.strictObject({ selector: z.string().min(1), label: z.string().min(1) }), 'uor.prepare', 'async', (context, input) => services.recorder.selectMarker(context, input));
  bind('source.browser.record.cancel', z.strictObject({ recordingId: uuidSchema }), z.strictObject({ recordingId: uuidSchema, cancelled: z.literal(true) }), 'personal.write', 'sync', (context, input) => services.recorder.cancel(context, input.recordingId));
  bind('source.browser.record.finish', z.strictObject({ recordingId: uuidSchema, save: z.boolean() }), recordedScenarioSchema, 'personal.write', 'sync', (context, input) => services.recorder.finish(context, input));
  bind('source.browserScenario.draft.save', z.strictObject({ draftId: uuidSchema, definition: partialSchema(browserScenarioDefinitionSchema, true) }), draftSaveResultSchema, 'uor.prepare', 'sync', (context, input) => services.scenarios.save(context, input as Parameters<BrowserScenarioService['save']>[1]), true);
  bind('source.browser.record.test', z.strictObject({ draftId: uuidSchema, assignmentRef: versionRefSchema.refine(value => value.entityType === 'goal_assignment').optional() }), browserScenarioTestResultSchema, 'uor.prepare', 'async', (context, input) => services.scenarios.test(context, input));
}

export function registerBrowserQueries(registry: QueryRegistry, { profiles, recorder, drafts }: Pick<BrowserServices, 'profiles'> & { recorder?: BrowserRecorderService; drafts?: DraftService }): void {
  const filter = z.strictObject({ sourceRef: sourceRefSchema, ownDraft: browserOwnDraftSchema.optional() });
  registry.register({ name: 'source.browser.own', inputSchema: z.union([queryRequestSchema.extend({ filter }), ownQueryRequestSchema.extend({ filter })]), outputSchema: browserProfileViewSchema, async handler(context, input) {
    if (!canUseCapability(context.ownAccess, 'business.read')) throw new WorkbenchHttpError(403, 'ACCESS_DENIED', 'Own browser settings require business access');
    const source = resolveBrowserSource(context, input.filter, drafts); return profiles.getOwn(context, source.id);
  } });
  if (recorder) registry.register({ name: 'source.browser.record.status', inputSchema: ownQueryRequestSchema.extend({ filter: z.strictObject({ recordingId: uuidSchema }) }), outputSchema: z.strictObject({ state: z.enum(['idle', 'recording', 'completed', 'failed', 'interrupted']), problem: z.strictObject({ code: z.string(), message: z.string() }).nullable() }), async handler(context, input) {
    if (!canUseCapability(context.ownAccess, 'business.read')) throw new WorkbenchHttpError(403, 'ACCESS_DENIED', 'Own browser state requires business access');
    return recorder.status(context, input.filter.recordingId);
  } });
}
