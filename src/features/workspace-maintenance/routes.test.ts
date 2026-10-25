import {afterEach,expect,it} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {scryptSync} from 'node:crypto';import type {FastifyInstance} from 'fastify';
import {createApp} from '../../server/app';import type {CatalogSnapshot} from '../../domain/contracts';import {validateWorkspaceBundle} from './bundle-service';
const apps:FastifyInstance[]=[],roots:string[]=[];afterEach(async()=>{for(const app of apps.splice(0))await app.close();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
const catalog:CatalogSnapshot={schemaVersion:1,id:'api-demo',name:'API проверка',classification:'demo',importedAt:'2026-10-25T00:00:00Z',goals:[],leaders:[],assignments:[],sources:[],comments:[],entities:[]};
it('protects every maintenance route, exports an actual ZIP, validates upload and raises its own body limit',async()=>{
 const root=await mkdtemp(join(tmpdir(),'uor-maintenance-api-'));roots.push(root);const app=await createApp({projectRoot:root,initialCatalog:catalog,startupCheck:false,registry:[{id:'c',name:'Куратор примера',salt:'fixture',hash:scryptSync('fixture-only','fixture',64).toString('hex')}]});apps.push(app);
 const first=await app.inject({method:'GET',url:'/api/state'}),token=first.json().csrfToken,readerCookie=first.cookies.find(c=>c.name==='uor_session')!.value;
 expect((await app.inject({method:'GET',url:'/api/workspace-maintenance',headers:{cookie:`uor_session=${readerCookie}`}})).statusCode).toBe(403);
 const login=await app.inject({method:'POST',url:'/api/login',headers:{'x-uor-token':token},payload:{role:'curator',code:'fixture-only'}}),cookie=login.cookies.find(c=>c.name==='uor_session')!.value,headers={cookie:`uor_session=${cookie}`,'x-uor-token':token};
 expect((await app.inject({method:'POST',url:'/api/workspace-maintenance/export',headers:{cookie:headers.cookie},payload:{}})).statusCode).toBe(403);
 const exported=await app.inject({method:'POST',url:'/api/workspace-maintenance/export',headers,payload:{includeOriginals:false,includeReports:false}});expect(exported.statusCode).toBe(200);expect(exported.headers['content-disposition']).toContain('attachment');expect((await validateWorkspaceBundle(exported.rawPayload)).summary.goals).toBe(0);
 const preview=await app.inject({method:'POST',url:'/api/workspace-maintenance/restore/preview',headers,payload:{base64:exported.rawPayload.toString('base64')}});expect(preview.statusCode).toBe(200);expect(preview.json().actor).toBe('Куратор примера');
 const largeInvalid=await app.inject({method:'POST',url:'/api/workspace-maintenance/restore/preview',headers,payload:{base64:'A'.repeat(22_000_004)}});expect(largeInvalid.statusCode).toBe(400);expect(largeInvalid.json().message).toMatch(/ZIP/);
});
