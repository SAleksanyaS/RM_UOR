import type { GitOid } from '../../../domain/workbench/publication';
export type TerminalRunResult={status:'confirmed';exitCode:0;remoteCommit:GitOid}|{status:'cancelled';exitCode:number|null}|{status:'unknown';exitCode:number|null;reason:string}|{status:'auth_required';provider:'git'|'bitbucket'};
export type PreTransferGate=()=>Promise<void>;
export interface TerminalRunner {
  runGitPush(input:{cwd:string;args:readonly string[];preparedCommit:GitOid;preTransferGate:PreTransferGate;signal:AbortSignal}):Promise<TerminalRunResult>;
}
