import { z } from 'zod';
import type { WorkbenchRepository } from '../../server/storage/workbench-repository';
import { ownQueryRequestSchema,WorkbenchHttpError } from '../../server/workbench/protocol';
import type { QueryRegistry,QueryContext } from '../../server/workbench/query-registry';
import { uuidSchema } from '../../domain/workbench/primitives';
import { directoryEntitySchema,directoryLinkSchema } from '../../domain/workbench/schemas';
import type { DraftService } from '../catalog/workbench-drafts';
import type { MaturityMaterialBundle } from '../maturity/workbench-contracts';
import {createKnowledgeService} from './workbench-service';
import {knowledgeListSchema,knowledgeImportInputSchema,knowledgePreviewSchema} from './workbench-contracts';
export function registerKnowledgeQueries(registry:QueryRegistry,options:{repository:WorkbenchRepository;drafts:DraftService;materials:MaturityMaterialBundle;materialsFor?:(context:Pick<QueryContext,'repository'|'installationId'|'ownAccess'|'clock'>)=>MaturityMaterialBundle}):void{
 const service=createKnowledgeService(options);
 const filter=z.strictObject({packageId:uuidSchema.nullable().default(null),text:z.string().max(200).default(''),kind:z.string().default('all'),includeArchived:z.boolean().default(false)});
 registry.register({name:'knowledge.list',inputSchema:ownQueryRequestSchema.extend({filter}),outputSchema:knowledgeListSchema,async handler(context,input){const all=service.list(context,input.filter);const start=input.page.cursor?Number(input.page.cursor):0;if(!Number.isSafeInteger(start)||start<0)throw new WorkbenchHttpError(422,'CURSOR_INVALID','Некорректная страница');return {...all,items:all.items.slice(start,start+input.page.limit),nextCursor:start+input.page.limit<all.items.length?String(start+input.page.limit):null};}});
 registry.register({name:'knowledge.quality',inputSchema:ownQueryRequestSchema.extend({filter}),outputSchema:knowledgeListSchema,async handler(context,input){return service.list(context,input.filter);}});
 registry.register({name:'knowledge.hierarchy',inputSchema:ownQueryRequestSchema.extend({filter:z.strictObject({packageId:uuidSchema.nullable().default(null),includeArchived:z.boolean().default(false)})}),outputSchema:knowledgeListSchema,async handler(context,input){return service.list(context,input.filter);}});
 registry.register({name:'knowledge.detail',inputSchema:ownQueryRequestSchema.extend({filter:z.strictObject({id:uuidSchema,packageId:uuidSchema.nullable().default(null)})}),outputSchema:z.strictObject({item:knowledgeListSchema.shape.items.element,links:z.array(directoryLinkSchema),history:z.array(directoryEntitySchema)}),async handler(context,input){const all=service.list(context,{packageId:input.filter.packageId,includeArchived:true}),item=all.items.find(i=>i.value.id===input.filter.id);if(!item)throw new WorkbenchHttpError(404,'REFERENCE_NOT_FOUND','Объект не найден');const history=options.repository.exportWorkspaceCore().filter(e=>e.entityType==='directory_entity'&&e.value.id===item.value.id&&'publicationAnchorId' in e.value&&!!e.value.publicationAnchorId&&options.repository.readPublicationAnchor({entityType:'publication_anchor',id:e.value.publicationAnchorId})?.publicationState==='confirmed').map(e=>directoryEntitySchema.parse(e.value));return {item,links:all.links.filter(l=>l.kind==='leader'?l.personId===item.value.id||l.scope.id===item.value.id:l.from.id===item.value.id||l.to.id===item.value.id),history};}});
 registry.register({name:'knowledge.importPreview',inputSchema:ownQueryRequestSchema.extend({filter:knowledgeImportInputSchema}),outputSchema:knowledgePreviewSchema,async handler(context,input){return service.preview(context,input.filter);}});
}
