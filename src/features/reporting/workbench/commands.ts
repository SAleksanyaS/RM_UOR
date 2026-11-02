import type { CommandRegistry } from '../../../server/workbench/command-registry';
import { reportSaveInputSchema, reportSaveResultSchema } from './contracts';
import type { ReportService } from './service';
export function registerReportCommands(registry: CommandRegistry, service: ReportService) { registry.register({ name: 'report.save', inputSchema: reportSaveInputSchema, outputSchema: reportSaveResultSchema, capability: 'uor.prepare', ownership: 'person', effect: 'local', execution: 'sync', async handler(context, input) { return service.save(context, input); } }); }
