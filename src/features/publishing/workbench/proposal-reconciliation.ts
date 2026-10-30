import type { CommandContext } from '../../../server/workbench/command-registry';
import type { JobStore } from '../../../server/workbench/jobs';
import type { WorkbenchRepository } from '../../../server/storage/workbench-repository';
import { WorkbenchHttpError } from '../../../server/workbench/protocol';
import { canUseCapability,type AccessPolicyService } from '../../identity/workbench-access-policy';
import { bitbucketCapabilitiesSchema,proposalWriteSchema,proposalSnapshotSchema } from './contracts';
import { canonicalBytes,hashBytes } from './package-manifest';
import type { BitbucketPort,ProposalWrite,ProposalSnapshot,ProposalLink } from './bitbucket-port';

type Dependencies={bitbucket:BitbucketPort;accessPolicy:AccessPolicyService;repository:WorkbenchRepository;jobs:JobStore;repositoryId?:string;proposal?:ProposalLink|null};
const queues=new WeakMap<WorkbenchRepository,Map<string,Promise<unknown>>>();
const fail=(code='REMOTE_STATE_UNKNOWN',status=409):never=>{throw new WorkbenchHttpError(status,code,code);};
export async function reconcileProposal(context:CommandContext,unparsed:ProposalWrite,deps:Dependencies):Promise<ProposalSnapshot> {
  const input=proposalWriteSchema.parse(unparsed),revision=input.packageRevision,owner=context.actor.profilePersonId;
  if(context.repository!==deps.repository||context.actor.installationId!==context.installationId||!owner||context.ownAccess.personId!==owner||owner!==revision.curatorPersonId) return fail('COMMAND_CONTEXT_MISMATCH');
  if(input.branch!==`uor/${owner}/${revision.packageId}`||input.marker!==`uor-package:${revision.packageId}`) return fail('INTEGRITY_MISMATCH',422);
  const job=deps.jobs.findByCommand(context.commandId,context.installationId);if(!job) return fail('COMMAND_JOB_MISSING');
  const sql=deps.repository.sqlForModule('publishing',{trackStateRevision:false});
  sql.execMigration('effects-001',`CREATE TABLE wb_publishing_effects(operation_id TEXT NOT NULL,stage TEXT NOT NULL,package_id TEXT NOT NULL,revision INTEGER NOT NULL,installation_id TEXT NOT NULL,person_id TEXT NOT NULL,input_hash TEXT NOT NULL,intent_at TEXT NOT NULL,phase TEXT NOT NULL,external_json TEXT,PRIMARY KEY(operation_id,stage,package_id,revision));CREATE INDEX wb_publishing_effect_package ON wb_publishing_effects(installation_id,person_id,package_id);`);
  const key=context.installationId+'/'+revision.packageId;let queue=queues.get(deps.repository);if(!queue){queue=new Map();queues.set(deps.repository,queue);}const previous=queue.get(key)??Promise.resolve();
  const run=previous.catch(()=>undefined).then(async()=>{
    const capabilities=bitbucketCapabilitiesSchema.parse(await deps.bitbucket.capabilities());
    if(!capabilities.nativePullRequests||!capabilities.findByPackageMarker) return fail();
    let found:ProposalSnapshot|null;try {const value=await deps.bitbucket.findProposal(revision.packageId);found=value===null?null:proposalSnapshotSchema.parse(value);}catch{return fail();}
    if(found&&(found.packageId!==revision.packageId||found.state==='unknown'||deps.repositoryId&&found.link.repositoryId!==deps.repositoryId)) return fail();
    const prior=sql.all<{phase:string;external_json:string|null}>('SELECT phase,external_json FROM wb_publishing_effects WHERE installation_id=? AND person_id=? AND package_id=?',[context.installationId,owner,revision.packageId]);
    const knownLinks=[...(deps.proposal?[deps.proposal]:[]),...prior.filter(row=>row.external_json).map(row=>proposalSnapshotSchema.parse(JSON.parse(row.external_json!)).link)];
    const sameLink=(a:ProposalLink,b:ProposalLink)=>hashBytes(canonicalBytes(a))===hashBytes(canonicalBytes(b));
    if(found&&knownLinks.some(link=>!sameLink(link,found!.link))) return fail();
    if(!found&&(knownLinks.length||prior.some(row=>!['intent','not_started','auth_required'].includes(row.phase)))) return fail();
    const binding=hashBytes(canonicalBytes(input));
    const old=sql.get<{input_hash:string}>('SELECT input_hash FROM wb_publishing_effects WHERE operation_id=? AND stage=? AND package_id=? AND revision=?',[job.jobId,'PR.write',revision.packageId,revision.revision]);if(old&&old.input_hash!==binding) return fail('IDEMPOTENCY_CONFLICT');
    if(found&&['merged','declined'].includes(found.state)) return fail('PACKAGE_CLOSED');
    if(found&&found.sourceCommit===input.proposalCommit) {if(found.targetCommit!==revision.baseCommit) return fail('PREVIEW_STALE');return found;}
    if(found&&(!capabilities.updateOpenProposal||found.targetCommit!==revision.baseCommit)) return fail();
    deps.repository.transaction(()=>{sql.run('INSERT OR IGNORE INTO wb_publishing_effects(operation_id,stage,package_id,revision,installation_id,person_id,input_hash,intent_at,phase,external_json) VALUES(?,?,?,?,?,?,?,?,?,NULL)',[job.jobId,'PR.write',revision.packageId,revision.revision,context.installationId,owner,binding,context.clock.now(),'intent']);});
    const update=(phase:string,value:ProposalSnapshot|null)=>deps.repository.transaction(()=>sql.run('UPDATE wb_publishing_effects SET phase=?,external_json=? WHERE operation_id=? AND stage=? AND package_id=? AND revision=?',[phase,value?JSON.stringify(value):null,job.jobId,'PR.write',revision.packageId,revision.revision]));
    try {const fresh=await deps.accessPolicy.assertFreshPublishAllowed(job.jobId);if(fresh.personId!==owner||!canUseCapability(fresh,'package.submit')) return fail('ACCESS_DENIED',403);context.ownAccess=fresh;}
    catch(error) {update('not_started',null);throw error;}
    update('dispatched',null);let response:ProposalSnapshot;
    try {
      response=proposalSnapshotSchema.parse(await (found?deps.bitbucket.updateProposal(found.link,input):deps.bitbucket.createProposal(input)));
    } catch(error) {const auth=error instanceof WorkbenchHttpError&&error.code==='PR_AUTH_REQUIRED';update(auth?'auth_required':'unknown',null);if(auth) return fail('PR_AUTH_REQUIRED');return fail();}
    update('awaiting_readback',response);
    try {
      const verified=proposalSnapshotSchema.parse(await deps.bitbucket.readProposal(response.link));
      if(!sameLink(response.link,verified.link)||verified.packageId!==revision.packageId||verified.sourceCommit!==input.proposalCommit||verified.targetCommit!==revision.baseCommit||deps.repositoryId&&verified.link.repositoryId!==deps.repositoryId||!['open','needs_rework'].includes(verified.state)||found&&!sameLink(found.link,verified.link)) return fail();
      update('confirmed',verified);return verified;
    } catch(error) {update('unknown',response);if(error instanceof WorkbenchHttpError&&error.code==='PR_AUTH_REQUIRED') return fail('PR_AUTH_REQUIRED');return fail();}
  });
  queue.set(key,run);try{return await run;}finally{if(queue.get(key)===run) queue.delete(key);}
}
