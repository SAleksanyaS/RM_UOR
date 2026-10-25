export class CodeUpdateError extends Error{code:string;constructor(code:string,message:string)}
export interface CodeUpdateConfig{repositoryUrl:string;publishedBranch:string;credentialHelper?:string}
export interface CodePreview{currentCommit:string;targetCommit:string;branch:string;available:boolean}
export function runCommand(file:string,args:string[],root:string,options?:Record<string,unknown>):Promise<{stdout:string;stderr:string}>;
export function validBranch(value:unknown):boolean;
export function inspectCodeUpdate(root:string,config:CodeUpdateConfig,options?:{fetchRemote?:boolean;expectedCommit?:string;targetCommit?:string}):Promise<CodePreview>;
export function applyCodeUpdate(root:string,config:CodeUpdateConfig,ticket:{expectedCommit:string;targetCommit:string},options?:{install?:()=>Promise<void>;stage?:(phase:string,message:string)=>Promise<void>}):Promise<CodePreview>;
export function atomicJson(file:string,value:unknown):Promise<void>;
export function readJsonFile<T=unknown>(file:string,fallback?:T|null):Promise<T|null>;
