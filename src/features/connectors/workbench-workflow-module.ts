import { z } from 'zod';
import { uuidSchema } from '../../domain/workbench/primitives';
import { browserScenarioDefinitionSchema } from '../../domain/workbench/browser-scenario';
import type { PlatformModule } from '../../server/workbench/modules';
import type { CommandDescriptor } from '../../server/workbench/command-registry';
import { privateProfileSchema } from './private-profile-schema';
import { okoWorkflowViewSchema, okoWorkspaceViewSchema, okoWorkspaceQuerySchema, okoWorkflowIdSchema, okoWorkflowCasSchema, okoParsingProfileSchema, okoMappingSchema, okoDictionaryMappingSchema } from './workbench-workflow-contracts';
import type { OkoWorkflowService } from './workbench-workflow-service';
export function createOkoWorkflowModule({ service }: {
    service: OkoWorkflowService;
}): PlatformModule {
    const command = <P, R>(name: string, inputSchema: z.ZodType<P>, outputSchema: z.ZodType<R>, handler: (context: Parameters<OkoWorkflowService['open']>[0], payload: P) => Promise<R>, capability: 'personal.write' | 'uor.prepare' = 'uor.prepare', execution: 'sync' | 'async' = 'sync'): CommandDescriptor<P, R> => ({ name, inputSchema, outputSchema, capability, execution, ownership: 'person', effect: 'local', resourceKey: payload => 'oko:' + String((payload as {
            workflowId?: string;
        }).workflowId ?? 'new'), handler: async (context, payload) => ({ result: await handler(context, payload), changedRefs: [], editToken: null }) });
    return { id: 'oko-workflow', version: '1.0.0', platformContractVersion: 1, dependsOn: [], owns: { entityTypes: [], namespaces: ['oko-workflow'] }, schemas: [], hooks: {}, queries: [{ name: 'source.browser.workspace', inputSchema: okoWorkspaceQuerySchema, outputSchema: okoWorkspaceViewSchema, handler: (context, input) => service.workspace(context, input.filter.workflowId) }], commands: [
            command('source.browser.workflow.open', z.strictObject({ workflowId: uuidSchema.optional(), title: z.string().trim().min(1).max(200).optional() }), okoWorkflowViewSchema, service.open),
            command('source.browser.profile.set', okoWorkflowCasSchema.extend({ profile: privateProfileSchema, reportUrl: z.string().url().max(4000) }), okoWorkflowViewSchema, service.setProfile, 'personal.write'),
            command('source.browser.login.open', okoWorkflowIdSchema, z.strictObject({ loginId: uuidSchema, windowOpened: z.literal(true) }), service.loginOpen, 'personal.write'),
            command('source.browser.login.finish', okoWorkflowIdSchema.extend({ loginId: uuidSchema }), z.strictObject({ closed: z.literal(true) }), service.loginFinish, 'personal.write'),
            command('source.browser.marker.select', okoWorkflowIdSchema.extend({ reportUrl: z.string().url().max(4000) }), okoWorkflowViewSchema, service.marker, 'uor.prepare', 'async'),
            command('source.browser.record.start', okoWorkflowCasSchema.extend({ reportUrl: z.string().url().max(4000), parsingProfile: okoParsingProfileSchema }), okoWorkflowViewSchema, service.start),
            command('source.browser.record.finish', okoWorkflowIdSchema.extend({ recordingId: uuidSchema }), okoWorkflowViewSchema, service.finish),
            command('source.browser.record.cancel', okoWorkflowIdSchema, okoWorkflowViewSchema, service.cancel, 'personal.write'),
            command('source.browser.mapping.save', okoWorkflowCasSchema.extend({ mapping: okoMappingSchema, parameters: browserScenarioDefinitionSchema.shape.parameters, parsingProfile: okoParsingProfileSchema }), okoWorkflowViewSchema, service.saveMapping),
            command('source.browser.directory.preview', okoWorkflowIdSchema.extend({ fileHandle: uuidSchema, parsingProfile: okoParsingProfileSchema }), okoWorkflowViewSchema, service.directoryPreview),
            command('source.browser.directory.apply', okoWorkflowCasSchema.extend({ mapping: okoDictionaryMappingSchema }), okoWorkflowViewSchema, service.directoryApply),
            command('source.browser.record.test', okoWorkflowCasSchema, okoWorkflowViewSchema, service.test, 'uor.prepare', 'async'),
        ] };
}
