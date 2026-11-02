import { readlink,rm,lstat,readFile,open } from 'node:fs/promises';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
const names=['SingletonLock','SingletonSocket','SingletonCookie'];
function alive(pid:number):boolean {try{process.kill(pid,0);return true;}catch(e){return (e as NodeJS.ErrnoException).code!=='ESRCH';}}
const parse=(target:string)=>{const match=/^(.+)-(\d+)$/.exec(target);if(!match)return null;const pid=Number(match[2]);return Number.isSafeInteger(pid)&&pid>0?{host:match[1],pid}:null;};
const leaseName='.uor-browser-lease.json';
type Lease={schemaVersion:1;host:string;pid:number;profilePath:string;token:string};
async function readLease(folder:string):Promise<Lease|null>{try{const name=path.join(folder,leaseName),info=await lstat(name);if(info.isSymbolicLink()||!info.isFile())return null;const lease=JSON.parse(await readFile(name,'utf8')) as Lease;return lease.schemaVersion===1&&lease.host===hostname()&&lease.profilePath===path.resolve(folder)&&Number.isSafeInteger(lease.pid)&&lease.pid>0&&typeof lease.token==='string'?lease:null;}catch{return null;}}
/** No process signals without a verified instance/UID/executable/start-time identity. This platform adapter fails closed. */
export async function terminateProfileProcesses(_profilePath:string):Promise<number[]>{return [];}
export async function pruneOrphanBrowserSockets(_root='/tmp'):Promise<number>{return 0;}
export async function profileLockedByLiveProcess(folder:string):Promise<number|null>{const lock=await readlink(path.join(folder,'SingletonLock')).catch(()=>null);const owner=lock?parse(lock):null;return owner&&alive(owner.pid)?owner.pid:null;}
/** All Singleton entries belong to one lock set. Unknown/foreign/live owners retain every entry. */
export async function releaseStaleProfileLocks(folder:string):Promise<string[]>{
 const lease=await readLease(folder);if(!lease||alive(lease.pid))return [];
 const snapshots=await Promise.all(names.map(async name=>{const file=path.join(folder,name);try{const info=await lstat(file);return {name,file,symlink:info.isSymbolicLink(),target:info.isSymbolicLink()?await readlink(file):null};}catch{return null;}}));
 const lock=snapshots.find(v=>v?.name==='SingletonLock');const owner=lock?.target?parse(lock.target):null;if(!owner||owner.host!==hostname()||alive(owner.pid)||snapshots.some(v=>v&&!v.symlink))return [];
 for(const item of snapshots)if(item&&(await readlink(item.file).catch(()=>null))!==item.target)return [];
 const released:string[]=[];for(const item of snapshots)if(item){await rm(item.file);released.push(item.name);}return released;
}
/** Exclusive app lease: no heuristic takeover of a live or ambiguous process. */
export async function acquireBrowserProfileLease(folder:string):Promise<()=>Promise<void>>{
 const file=path.join(folder,leaseName),lease:Lease={schemaVersion:1,host:hostname(),pid:process.pid,profilePath:path.resolve(folder),token:randomUUID()};
 try{const handle=await open(file,'wx',0o600);try{await handle.writeFile(JSON.stringify(lease));await handle.sync();}finally{await handle.close();}}
 catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;const previous=await readLease(folder);if(!previous||alive(previous.pid))throw Error('PROFILE_LOCKED');const lock=await lstat(path.join(folder,'SingletonLock')).catch(()=>null);if(lock)throw Error('PROFILE_LOCKED');await rm(file);return acquireBrowserProfileLease(folder);}
 return async()=>{const current=await readLease(folder);if(current?.token===lease.token)await rm(file,{force:true});};
}
