import { z } from 'zod';
import type { CustomFieldDef, CustomFieldValue } from '../../domain/workbench/entities';
import type { EntityRef, Header } from '../../domain/workbench/primitives';
import { entityRefSchema, versionRefSchema } from '../../domain/workbench/primitives';
import { customFieldDefSchema, customFieldValueSchema, validateCustomFieldValue } from '../../domain/workbench/schemas/extensions';
import { pageResultSchema, queryRequestSchema, WorkbenchHttpError } from '../../server/workbench/protocol';
import type { QueryRegistry } from '../../server/workbench/query-registry';
import type { WorkbenchRepository } from '../../server/storage/workbench-repository';
import { createWorkbenchReadIndex } from './workbench-read-index';
import { assertContextGraph } from './workbench-search';
const optionSchema=z.discriminatedUnion('kind',[
 z.strictObject({kind:z.literal('dashboard'),ref:versionRefSchema,title:z.string()}),
 z.strictObject({kind:z.literal('field'),ref:versionRefSchema,title:z.string(),definition:customFieldDefSchema}),
]);
export const configurationOptionsSchema=z.strictObject({items:z.array(optionSchema),page:pageResultSchema});
export const customFieldValuesReadSchema=z.strictObject({items:z.array(z.strictObject({value:customFieldValueSchema,definition:customFieldDefSchema})),page:pageResultSchema});
export type ConfigurationOptions=z.infer<typeof configurationOptionsSchema>;
export type CustomFieldValuesRead=z.infer<typeof customFieldValuesReadSchema>;
const noSort=z.array(z.never()).max(0);
const published=(repository:WorkbenchRepository,value:Header|null):boolean=>!!value?.publicationAnchorId&&repository.readPublicationAnchor({entityType:'publication_anchor',id:value.publicationAnchorId})?.publicationState==='confirmed';
const ref=(entityType:string,value:Header)=>({entityType,id:value.id,revision:value.revision});
/** Additive T37 owner reads: confirmed configuration only; never own/foreign drafts.
 * Exact stored fieldRef determines type even when the current definition changed. */
export function registerConfigurationQueries(registry:QueryRegistry,repository:WorkbenchRepository):void {
 const index=createWorkbenchReadIndex(repository);
 registry.register({name:'configuration.options',inputSchema:queryRequestSchema.extend({filter:z.strictObject({kind:z.enum(['dashboard','field'])}),sort:noSort}),outputSchema:configurationOptionsSchema,async handler(context,request){
  assertContextGraph(request.context,index);
  const items:ConfigurationOptions['items']=request.filter.kind==='dashboard'?index.list('dashboard_def').map(value=>({kind:'dashboard',ref:ref('dashboard_def',value),title:value.title})):index.list('custom_field_def').map(value=>({kind:'field',ref:ref('custom_field_def',value),title:value.name,definition:value}));
  return index.page(items,request.page,{name:'configuration.options',context:request.context,filter:request.filter},context);
 }});
 registry.register({name:'customFields.values',inputSchema:queryRequestSchema.extend({filter:z.strictObject({objectRef:entityRefSchema,fieldRef:versionRefSchema.refine(v=>v.entityType==='custom_field_def').optional(),text:z.string().max(200).optional()}),sort:noSort}),outputSchema:customFieldValuesReadSchema,async handler(context,request){
  assertContextGraph(request.context,index);
  const object=request.filter.objectRef as EntityRef;
  if(!index.read(object))throw new WorkbenchHttpError(404,'REFERENCE_NOT_FOUND','Объект не опубликован');
  const items:CustomFieldValuesRead['items']=[];
  for(const value of index.list('custom_field_value')) {
   if(value.objectRef.entityType!==object.entityType||value.objectRef.id!==object.id)continue;
   if(request.filter.fieldRef&&JSON.stringify(value.fieldRef)!==JSON.stringify(request.filter.fieldRef))continue;
   const definition=repository.readVersion<CustomFieldDef>(value.fieldRef);
   if(!published(repository,definition))throw new WorkbenchHttpError(404,'REFERENCE_NOT_FOUND','Опубликованная версия поля недоступна');
   validateCustomFieldValue(value as CustomFieldValue,definition!);
   const text=Array.isArray(value.value)?value.value.join(', '):value.value===null?'':String(value.value);
   if(request.filter.text&&!text.toLocaleLowerCase('ru').includes(request.filter.text.toLocaleLowerCase('ru')))continue;
   items.push({value,definition:definition!});
  }
  return index.page(items,request.page,{name:'customFields.values',context:request.context,filter:request.filter},context);
 }});
}
