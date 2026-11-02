import { z } from 'zod';
import type { QueryRegistry,QueryContext } from '../../server/workbench/query-registry';
import type { WorkbenchRepository } from '../../server/storage/workbench-repository';
import { ownQueryRequestSchema,WorkbenchHttpError } from '../../server/workbench/protocol';
import { maturitySnapshotSchema,type MaturityMaterialBundle } from './workbench-contracts';
import { createMaturitySnapshot } from './workbench-materials';
/** Selected immutable materials are clearly labelled source evidence, not active accepted facts. */
export function registerMaturityQueries(registry:QueryRegistry,{materials,materialsFor}:{repository:WorkbenchRepository;materials:MaturityMaterialBundle;materialsFor?:(context:QueryContext)=>MaturityMaterialBundle}):void{
 registry.register({name:'maturity.overview',inputSchema:ownQueryRequestSchema.extend({filter:z.strictObject({definitionRevision:z.literal(1).default(1)})}),outputSchema:maturitySnapshotSchema,async handler(context){return createMaturitySnapshot(materialsFor?.(context)??materials);}});
}
