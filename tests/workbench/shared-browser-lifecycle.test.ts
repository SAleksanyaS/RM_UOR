import { afterEach, expect, it } from 'vitest';
import { chromium, type BrowserContext } from 'playwright';
import { createServer } from 'node:http';
import { createLocalRuntime } from './helpers/runtime';
import { chromeExecutable } from './helpers/browser';
import { fixtureId, makeEntityGraph, makeHeader } from '../fixtures/workbench/factories';
import { seedGraph } from '../fixtures/workbench/repository';
import type { SourceDefinition } from '../../src/domain/workbench/entities';
const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
async function fixture(){
 const server=createServer((_req,res)=>{res.setHeader('content-type','text/html');res.end('<!doctype html><div id="ready">Synthetic report</div><button id="export">Export</button>');});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));cleanup.push(()=>new Promise<void>(r=>server.close(()=>r())));
 const origin='http://127.0.0.1:'+(server.address() as any).port, contexts:BrowserContext[]=[], active=new Set<BrowserContext>(), folders:string[]=[];
 const executablePath=await chromeExecutable();
 const f=await createLocalRuntime({browserLauncher:{async launchPersistent(_profile,folder,options){const context=await chromium.launchPersistentContext(folder,{...options,executablePath,headless:true});contexts.push(context);folders.push(folder);active.add(context);context.once('close',()=>active.delete(context));return context;}}});
 cleanup.push(async()=>{await Promise.all([...active].map(c=>c.close()));await f.close();});
 const graph=makeEntityGraph();seedGraph(f.runtime.deps.repository,graph);
 const source=f.runtime.deps.repository.readPublishedHead<SourceDefinition>({entityType:'source_definition',id:graph.input.goal.sourceId})!;
 const scenario={...makeHeader(991001,{publicationAnchorId:source.publicationAnchorId}),sourceId:source.id,startUrl:origin+'/report',authenticatedSelector:'#ready',steps:[{action:'download' as const,locator:{kind:'css' as const,selector:'#export'}}],parameters:{},expectedExport:{format:'csv' as const,requiredColumns:['Value']}};
 f.runtime.deps.repository.transaction(()=>{f.runtime.deps.repository.append('browser_scenario',scenario,null);f.runtime.deps.repository.append('source_definition',{...source,revision:2,browserScenarioRef:{entityType:'browser_scenario',id:scenario.id,revision:1}},1);});
 await f.request.session();await f.request.command('workbench.role.set',{role:'curator'});
 await f.request.command('source.browser.profile.set',{sourceId:source.id,profileId:'shared-lifecycle',profile:{allowedOrigins:[origin],timeoutMs:10000,maxBytes:100000,browser:{executablePath,profileDirectory:'shared-lifecycle'}},expectedRevision:null});
 const start=async(mode:'record'|'login')=>{const sourceRef={entityType:'source_definition',id:source.id,revision:2};return f.request.settle(await f.request.command('source.browser.'+mode+'.'+(mode==='record'?'start':'open'),{sourceRef,...(mode==='record'?{startUrl:origin+'/report',authenticatedSelector:'#ready'}:{})}));};
 return {...f,start,active,contexts,folders};
}
it.each(['record','login'] as const)('final_I2_shared_only_%s_closes_before_same_profile_restart',async mode=>{
 const f=await fixture();await f.start(mode);expect(f.active.size).toBe(1);
 await f.stop();expect(f.active.size).toBe(0);expect(f.contexts[0].pages()).toHaveLength(0);
 await f.restart();await f.request.session();await f.start(mode);expect(f.active.size).toBe(1);expect(f.folders[1]).toBe(f.folders[0]);await f.stop();expect(f.active.size).toBe(0);
},60000);
it('final_I2_maintenance_drains_actual_shared_recording',async()=>{
 const f=await fixture();await f.start('record');expect(f.active.size).toBe(1);
 await f.runtime.services.archive.lifecycle!.quiesce(fixtureId(991002));expect(f.active.size).toBe(0);
 await f.runtime.services.archive.lifecycle!.resume();await f.start('record');expect(f.active.size).toBe(1);await f.stop();expect(f.active.size).toBe(0);
},60000);
