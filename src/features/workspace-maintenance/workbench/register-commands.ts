import type { CommandRegistry } from '../../../server/workbench/command-registry';
import { backupCreateInputSchema, backupCreateResultSchema, restorePreviewInputSchema, restorePreviewResultSchema, restoreApplyInputSchema, restoreApplyResultSchema } from './contracts';
import type { MaintenanceService } from './maintenance-service';

export function registerMaintenanceCommands(registry: CommandRegistry, service: MaintenanceService): void {
  registry.register({ name: 'backup.create', inputSchema: backupCreateInputSchema, outputSchema: backupCreateResultSchema, capability: 'workspace.backup', execution: 'async', effect: 'local', ownership: 'person-if-present', resourceKey: () => 'workspace-maintenance', async handler(context, input) { return { result: await service.createBackup(context, input), changedRefs: [], editToken: null }; } });
  registry.register({ name: 'backup.restore.preview', inputSchema: restorePreviewInputSchema, outputSchema: restorePreviewResultSchema, capability: 'workspace.backup', execution: 'async', effect: 'local', ownership: 'person-if-present', resourceKey: () => 'workspace-maintenance', async handler(context, input) { return { result: await service.previewRestore(context, input), changedRefs: [], editToken: null }; } });
  registry.register({ name: 'backup.restore.apply', inputSchema: restoreApplyInputSchema, outputSchema: restoreApplyResultSchema, capability: 'workspace.backup', execution: 'async', effect: 'local', ownership: 'person-if-present', resourceKey: () => 'workspace-maintenance', async handler(context, input) { const result = await service.applyRestore(context, input); return { result, changedRefs: [], editToken: result.stateRevision }; } });
}
