import { z } from 'zod';
import { WorkbenchError } from '../../domain/workbench/errors';
import { QueryRegistry } from '../../server/workbench/query-registry';
import { WorkbenchHttpError, ownQueryRequestSchema, type QueryRequest } from '../../server/workbench/protocol';
import { queryOwnUor } from './workbench-own-uor-query';
import { workbenchRequestSchema, workbenchFilterSchemas } from './workbench-query-contracts';
import { queryWorkbench, workbenchOutputSchemas, type WorkbenchQueryName, type WorkbenchReadPorts } from './workbench-read-models';

export const workbenchQueryNames=Object.keys(workbenchOutputSchemas) as WorkbenchQueryName[];
/** Descriptors consume feature-owned read ports. No source/calculation command
 * is registered or invoked by this query module. */
export function registerWorkbenchQueries(registry:QueryRegistry,ports:WorkbenchReadPorts):void {
  for(const name of workbenchQueryNames) {
    const inputSchema=name==='uor.queue'||name==='uor.package'?z.union([workbenchRequestSchema(name),ownQueryRequestSchema.extend({filter:workbenchFilterSchemas[name]})]):workbenchRequestSchema(name);
    registry.register({name,inputSchema,outputSchema:workbenchOutputSchemas[name] as z.ZodType<unknown>,async handler(context,request){
      try {if(name==='uor.queue'||name==='uor.package')return await queryOwnUor(name,request,context,ports);return await queryWorkbench(name,request as QueryRequest,context,ports);}
      catch(error) {if(error instanceof WorkbenchError) throw new WorkbenchHttpError(['REFERENCE_NOT_FOUND','HISTORICAL_BASIS_UNAVAILABLE'].includes(error.code)?404:422,error.code,error.code);throw error;}
    }});
  }
}
