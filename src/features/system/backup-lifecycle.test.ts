import {afterEach,expect,it,vi} from 'vitest';
import Fastify from 'fastify';
import type {ApplicationContext} from '../../server/workspace/context';
const controls=vi.hoisted(()=>({run:async():Promise<unknown>=>({})}));
vi.mock('./backup-service',async importOriginal=>({...await importOriginal<typeof import('./backup-service')>(),listBackups:vi.fn(async()=>[]),createBackup:vi.fn(()=>controls.run()),pruneBackups:vi.fn(async()=>({removed:[],invalid:[],verifiedRetained:2}))}));
import {registerSystemRoutes} from './system-routes';
import {createBackup} from './backup-service';
afterEach(()=>{vi.useRealTimers();vi.clearAllMocks();});
it('finishes an in-flight backup before database onClose hooks and cannot schedule another cycle while closing',async()=>{vi.useFakeTimers();let enter!:()=>void,release!:()=>void;const started=new Promise<void>(resolve=>{enter=resolve;}),hold=new Promise<void>(resolve=>{release=resolve;});let finished=false,dbClosed=false;controls.run=async()=>{enter();await hold;finished=true;return{};};const app=Fastify();const context={db:{get:()=>({automatic:true,keepCopies:2,intervalHours:24}),set:vi.fn()},paths:{runtimeRoot:'synthetic'},operations:{list:()=>[]},activeRequests:0,maintenance:false} as unknown as ApplicationContext;registerSystemRoutes(app,context);app.addHook('onClose',async()=>{dbClosed=true;expect(finished).toBe(true);});await app.ready();await vi.advanceTimersByTimeAsync(60000);await started;const closing=app.close();await Promise.resolve();expect(dbClosed).toBe(false);release();await closing;expect(dbClosed).toBe(true);await vi.advanceTimersByTimeAsync(120000);expect(createBackup).toHaveBeenCalledTimes(1);});
