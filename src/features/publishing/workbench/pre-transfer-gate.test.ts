import { expect,it } from 'vitest';
import { fixtureId } from '../../../../tests/fixtures/workbench/factories';
import { buildPackageManifest } from './package-manifest';
import { createPreTransferGate } from './pre-transfer-gate';
import { WorkbenchHttpError } from '../../../server/workbench/protocol';
import type { CommandContext } from '../../../server/workbench/command-registry';
import type { PreparedProposal } from './git-port';

function fixture() {
  const person=fixtureId(17),installationId=fixtureId(1),commandId=fixtureId(250001),jobId=fixtureId(250002),files=new Map<string,Uint8Array>();
  const revision=buildPackageManifest({package:{schemaVersion:1,packageId:fixtureId(250003),cycleId:fixtureId(250004),curatorPersonId:person,revision:1,baseCommit:'a'.repeat(40),targetBranch:'main',createdAt:'2026-10-30T08:00:00Z'},files}).packageRevision;
  const context={installationId,commandId,actor:{installationId,hostname:'synthetic-host',profilePersonId:person},ownAccess:{role:'curator',personId:person,displayName:'Синтетический куратор',policyState:'verified',checkedAt:'2026-10-30T08:00:00Z'}} as CommandContext;
  const prepared:PreparedProposal={packageRevision:revision,branch:`uor/${person}/${revision.packageId}`,checkout:'C:/synthetic-only/private',commit:'b'.repeat(40),expectedRemoteHead:null};
  const trace:string[]=[];let revoked=false,changed=false;const operations:string[]=[];
  const deps={operationId:jobId,accessPolicy:{async resolveOwnAccess(){return context.ownAccess;},async assertCommandAllowed(){return context.ownAccess;},async assertFreshPublishAllowed(id:string){trace.push('fresh_registry');operations.push(id);return {...context.ownAccess,role:revoked?'viewer' as const:'curator' as const,policyState:revoked?'revoked' as const:'verified' as const};}},git:{async readMain(){return {repositoryId:'synthetic',commit:revision.baseCommit,files};},async prepare(){return prepared;},async inspectRemote(){return null;},async verifyPrepared(){trace.push('prepared');}},artifacts:{async readRevision(){trace.push('artifacts');return files;},async writeRevision(){}},async assertPreview(){trace.push('preview');if(changed) throw new WorkbenchHttpError(409,'PREVIEW_STALE','Changed during native wait');}};
  return {context,prepared,deps,trace,operations,revoke:()=>{revoked=true;},change:()=>{changed=true;}};
}
it('repeats preview, files and prepared checks and ends with a fresh job-bound grant',async()=>{
  const f=fixture(),gate=createPreTransferGate(f.context,f.prepared,f.deps);await gate();await gate();
  expect(f.trace.slice(-1)).toEqual(['fresh_registry']);expect(f.trace.filter(value=>value==='preview')).toHaveLength(4);expect(f.operations).toEqual([fixtureId(250002),fixtureId(250002)]);
});
it('rejects revocation and changed preview after a native authentication wait',async()=>{
  const f=fixture(),gate=createPreTransferGate(f.context,f.prepared,f.deps);await gate();f.revoke();await expect(gate()).rejects.toMatchObject({code:'ACCESS_DENIED'});
  const changed=fixture(),other=createPreTransferGate(changed.context,changed.prepared,changed.deps);await other();changed.change();await expect(other()).rejects.toMatchObject({code:'PREVIEW_STALE'});
});
it('refuses a gate without the actual preview check or without its real operation id',async()=>{
  const f=fixture();await expect(createPreTransferGate(f.context,f.prepared,{...f.deps,assertPreview:undefined})()).rejects.toMatchObject({code:'PREVIEW_RECHECK_REQUIRED'});
  await expect(createPreTransferGate(f.context,f.prepared,{...f.deps,operationId:undefined})()).rejects.toMatchObject({code:'COMMAND_JOB_MISSING'});
});
