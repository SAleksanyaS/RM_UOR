import type { CommandOutcome, CommandRegistry } from '../../../server/workbench/command-registry';
import { createCommandStore } from '../../../server/workbench/command-store';
import { WorkbenchHttpError } from '../../../server/workbench/protocol';
import { WorkbenchError } from '../../../domain/workbench/errors';
import { packagePreviewInputSchema, packagePreviewResultSchema, packageSubmitInputSchema,packageSubmitResultSchema,packageStatusResultSchema,type PackagePreviewResult } from './contracts';
import type { PublishingService } from './publishing-service';

export function registerPublishingCommands(registry:CommandRegistry,service:PublishingService):void {
  registry.register({name:'package.submit',inputSchema:packageSubmitInputSchema,outputSchema:packageSubmitResultSchema,capability:'package.submit',effect:'external',execution:'async',ownership:'person',explicitRecovery:'reconcile-on-user-retry',resourceKey:input=>'package:'+input.packageId,
    async handler(context,input){await service.submit(context,input);return JSON.parse(createCommandStore(context.repository).get(context.installationId,context.commandId)!.receipt_json!) as CommandOutcome<unknown> as CommandOutcome<import('./contracts').PackageSubmitResult>;},
  });
  registry.register({name:'package.refreshStatus',inputSchema:packagePreviewInputSchema,outputSchema:packageStatusResultSchema,capability:'uor.prepare',effect:'local',execution:'async',ownership:'person',resourceKey:input=>'package:'+input.packageId,
    async handler(context,input){await service.refreshStatus(context,input.packageId);return JSON.parse(createCommandStore(context.repository).get(context.installationId,context.commandId)!.receipt_json!) as CommandOutcome<import('./contracts').PackageStatusResult>;},
  });
  registry.register({name:'package.preview',inputSchema:packagePreviewInputSchema,outputSchema:packagePreviewResultSchema,capability:'uor.prepare',effect:'local',execution:'async',ownership:'person',resourceKey:input=>'package:'+input.packageId,
    async handler(context,input) {
      try {await service.preview(context,input);} catch(error) {if(error instanceof WorkbenchError) throw new WorkbenchHttpError(422,error.code,error.code);throw error;}
      const receipt=createCommandStore(context.repository).get(context.installationId,context.commandId)?.receipt_json;
      if(!receipt) throw Error('Package preview did not commit its receipt');
      return JSON.parse(receipt) as CommandOutcome<PackagePreviewResult>;
    },
  });
}
