import { canUseCapability } from '../identity/workbench-access-policy';
import type { EntityRef } from '../../domain/workbench/primitives';
import type { QueryContext } from '../../server/workbench/query-registry';
import { WorkbenchHttpError, type AnyQueryRequest } from '../../server/workbench/protocol';
import type { WorkbenchReadPorts } from './workbench-read-models';
import { packageZones } from '../publishing/workbench/package-zones';
/** Preparing the first catalog must not require that catalog to be published already. */
export async function queryOwnUor(name:'uor.queue'|'uor.package',request:AnyQueryRequest,context:QueryContext,ports:WorkbenchReadPorts){
 if(context.repository!==ports.repository)throw new WorkbenchHttpError(409,'COMMAND_CONTEXT_MISMATCH','Repository context differs');
 if(!canUseCapability(context.ownAccess,'uor.prepare'))throw new WorkbenchHttpError(403,'ACCESS_DENIED','A curator profile is required');
 const packages=name==='uor.package'?[ports.drafts.readOwnPackage(context,(request.filter.packageRef as EntityRef).id)]:ports.drafts.listOwnPackages(context);
 const running=ports.jobs.recoveryCandidates(context.installationId);
 const summaries=packages.map(pkg=>({packageRef:{entityType:'publication_package',id:pkg.packageId},revision:pkg.revision,editToken:`draft:${pkg.packageId}:${pkg.revision}`,incomplete:pkg.entries.filter(e=>!e.complete).length,publication:ports.publishing.readOwnPackage(context,pkg.packageId),activeJob:running.find(job=>job.resourceKey==='package:'+pkg.packageId)?.snapshot??null,previewCurrent:null,delivery:ports.publishing.readOwnDelivery?.(context,pkg.packageId)??null,retainedDelivery:ports.publishing.readOwnRetainedDelivery?.(context,pkg.packageId)??null,zones:packageZones(pkg.entries,ports.index)}));
 if(name==='uor.package')return{summary:summaries[0],entries:packages[0].entries.map(({draftId,entityRef,versionRef,baseRef,definition,complete,problems})=>({draftId,entityRef,versionRef,baseRef,definition,complete,problems}))};
 const value=(item:typeof summaries[number],field:string)=>field==='title'?item.packageRef.id:field==='status'?item.publication?.state??'':field==='recordedAt'?item.publication?.recordedAt??'':item.packageRef.id;
 summaries.sort((a,b)=>{for(const sort of request.sort){const delta=String(value(a,sort.field)).localeCompare(String(value(b,sort.field)));if(delta)return delta*(sort.direction==='desc'?-1:1);}return a.packageRef.id.localeCompare(b.packageRef.id);});
 return ports.index.page(summaries,request.page,{name,context:null,filter:request.filter,sort:request.sort},context);
}
