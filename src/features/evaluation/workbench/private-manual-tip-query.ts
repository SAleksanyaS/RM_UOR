import {z} from 'zod';
import {uuidSchema,versionRefSchema} from '../../../domain/workbench/primitives';
import {ownQueryRequestSchema} from '../../../server/workbench/protocol';
import type {QueryRegistry} from '../../../server/workbench/query-registry';
import type {DraftService} from '../../catalog/workbench-drafts';
import {privateManualTipSchema} from './private-preview-contracts';
/** Resolves the existing T17 canonical proof chain; never sorts IDs or creates events. */
export function registerPrivateManualTipQuery(registry:QueryRegistry,drafts:DraftService):void{
 registry.register({name:'manual.tip',inputSchema:ownQueryRequestSchema.extend({filter:z.strictObject({packageId:uuidSchema,assignmentRef:versionRefSchema.refine(ref=>ref.entityType==='goal_assignment'),editToken:z.string().min(1)}),sort:z.array(z.never()).max(0)}),outputSchema:privateManualTipSchema,async handler(context,{filter}){return drafts.readOwnManualTip(context,filter);}});
}
