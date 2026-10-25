export class CodeUpdateError extends Error{code:string;constructor(code:string,message:string)}
export interface CodeUpdateConfig{repositoryUrl:string;publishedBranch:string;credentialHelper?:string}
export interface CodePreview{currentCommit:string;targetCommit:string;branch:string;available:boolean}
export interface CodeUpdateResult extends CodePreview{rolledBack:boolean;error?:string;untouched?:boolean;committed?:boolean;recoveredActivation?:boolean}
export interface DatabaseReturn{ id:string;sha256:string;bytes:number }
export interface UpdateLifecycle{install?:(stageRoot:string)=>Promise<void>;quiesce?:()=>Promise<DatabaseReturn|void>;resume?:()=>Promise<unknown>;stop?:()=>Promise<void>;start?:(mode?:'candidate'|'rollback'|'committed')=>Promise<void>;ready?:()=>Promise<boolean>;activate?:()=>Promise<unknown>;stage?:(phase:string,message:string)=>Promise<void>}
export function runCommand(file:string,args:string[],root:string,options?:Record<string,unknown>):Promise<{stdout:string;stderr:string}>;
export function validBranch(value:unknown):boolean;
export function inspectCodeUpdate(root:string,config:CodeUpdateConfig,options?:{fetchRemote?:boolean;expectedCommit?:string;targetCommit?:string}):Promise<CodePreview>;
export function executeCodeUpdate(root:string,config:CodeUpdateConfig,ticket:{id?:string;expectedCommit:string;targetCommit:string},options?:UpdateLifecycle):Promise<CodeUpdateResult>;
export function applyCodeUpdate(root:string,config:CodeUpdateConfig,ticket:{expectedCommit:string;targetCommit:string},options?:UpdateLifecycle):Promise<CodeUpdateResult>;
export function recoverCodeUpdate(root:string):Promise<CodeUpdateResult|null>;
export function atomicJson(file:string,value:unknown):Promise<void>;
export function readJsonFile<T=unknown>(file:string,fallback?:T|null):Promise<T|null>;
