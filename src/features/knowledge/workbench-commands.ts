import { z } from 'zod';
import type { CommandRegistry } from '../../server/workbench/command-registry';
import { createCommandStore } from '../../server/workbench/command-store';
import type { DraftService } from '../catalog/workbench-drafts';
import type { KnowledgeService } from './workbench-service';
import {knowledgeImportInputSchema,knowledgePrepareInputSchema,knowledgePrepareResultSchema} from './workbench-contracts';
export function registerKnowledgeCommands(registry:CommandRegistry,{service}:{drafts:DraftService;service:KnowledgeService}):void{
 const receipt=(context:Parameters<KnowledgeService['prepare']>[0])=>JSON.parse(createCommandStore(context.repository).get(context.installationId,context.commandId)!.receipt_json!);
 registry.register({name:'knowledge.materials.prepare',inputSchema:knowledgePrepareInputSchema,outputSchema:knowledgePrepareResultSchema,capability:'uor.prepare',ownership:'person',effect:'sharedDraft',execution:'sync',async handler(context,input){service.prepare(context,input);return receipt(context);}});
 const applySchema=z.strictObject({input:knowledgeImportInputSchema,previewDigest:z.string().regex(/^[a-f0-9]{64}$/)});
 registry.register({name:'knowledge.import.apply',inputSchema:applySchema,outputSchema:knowledgePrepareResultSchema,capability:'uor.prepare',ownership:'person',effect:'sharedDraft',execution:'sync',async handler(context,input){await service.apply(context,{...input.input,previewDigest:input.previewDigest});return receipt(context);}});
}
