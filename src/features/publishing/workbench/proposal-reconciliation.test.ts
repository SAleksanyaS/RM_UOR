import { afterEach,expect,it } from 'vitest';
import { draftCleanups } from '../../../../tests/fixtures/workbench/drafts';
import { proposalFixture,syntheticCapabilities } from '../../../../tests/fixtures/workbench/proposals';
import { reconcileProposal } from './proposal-reconciliation';
import { WorkbenchHttpError } from '../../../server/workbench/protocol';

afterEach(async()=>{for(const cleanup of draftCleanups.splice(0)) await cleanup();});
it('reconciles a lost create response without creating a second native proposal',async()=>{
  const f=proposalFixture(),input=f.input(),first=f.command();let intentBeforeWrite=false;
  f.fake.testing.beforeWrite=()=>{intentBeforeWrite=!!f.repository.sqlForModule('publishing').get('SELECT intent_at FROM wb_publishing_effects WHERE operation_id=?',[first.job.jobId]);};
  f.fake.testing.loseNextCreateResponse=true;
  await expect(reconcileProposal(first.context,input,f.deps)).rejects.toMatchObject({code:'REMOTE_STATE_UNKNOWN'});
  const created=await f.fake.findProposal(input.packageRevision.packageId);expect(created).not.toBeNull();expect(intentBeforeWrite).toBe(true);
  const retry=await reconcileProposal(f.command().context,input,f.deps);expect(retry.link.id).toBe(created!.link.id);expect(f.fake.testing.creates).toBe(1);
});
it('updates the same open PR for rework and preserves ordinary comments',async()=>{
  const f=proposalFixture();const first=await reconcileProposal(f.command().context,f.input(),f.deps);
  f.fake.testing.addComment(first.link,{id:'comment-1',version:'1',text:'Уточнение',createdAt:f.clock.now(),authorDisplayName:'Ревьюер',requiresRework:false});
  expect((await f.fake.readProposal(first.link)).state).toBe('open');
  f.fake.testing.setState(first.link,'needs_rework');
  const next=await reconcileProposal(f.command().context,f.input(2),f.deps);
  expect(next.link.id).toBe(first.link.id);expect(next.sourceCommit).toBe('c'.repeat(40));expect(f.fake.testing.updates).toBe(1);expect((await f.fake.readComments(first.link))[0].requiresRework).toBe(false);
});
it('never creates blindly when marker search is unsupported or ambiguous',async()=>{
  const f=proposalFixture();f.fake.testing.capabilities={...syntheticCapabilities,findByPackageMarker:false};
  await expect(reconcileProposal(f.command().context,f.input(),f.deps)).rejects.toMatchObject({code:'REMOTE_STATE_UNKNOWN'});expect(f.fake.testing.creates).toBe(0);
  f.fake.testing.capabilities=syntheticCapabilities;await f.fake.createProposal(f.input());await f.fake.createProposal(f.input());
  await expect(reconcileProposal(f.command().context,f.input(),f.deps)).rejects.toMatchObject({code:'REMOTE_STATE_UNKNOWN'});expect(f.fake.testing.creates).toBe(2);
});
it('runs a fresh job-bound gate for each write and refuses a revoked profile',async()=>{
  const f=proposalFixture(),first=f.command();const created=await reconcileProposal(first.context,f.input(),f.deps);const second=f.command();await reconcileProposal(second.context,f.input(2),f.deps);
  expect(f.gates).toEqual([first.job.jobId,second.job.jobId]);expect(created.author.externalId).toBe('synthetic-native-author');
  f.context.ownAccess={...f.context.ownAccess,role:'viewer',policyState:'revoked'};
  await expect(reconcileProposal(f.command().context,{...f.input(2),proposalCommit:'d'.repeat(40)},f.deps)).rejects.toMatchObject({code:'ACCESS_DENIED'});expect(f.fake.testing.updates).toBe(1);
});
it('does not replace an uncertain proposal when a later marker search returns no result',async()=>{
  const f=proposalFixture();f.fake.testing.loseNextCreateResponse=true;await expect(reconcileProposal(f.command().context,f.input(),f.deps)).rejects.toMatchObject({code:'REMOTE_STATE_UNKNOWN'});
  const hidden={...f.deps,bitbucket:{...f.fake,async findProposal(){return null;}}};
  await expect(reconcileProposal(f.command().context,f.input(),hidden)).rejects.toMatchObject({code:'REMOTE_STATE_UNKNOWN'});expect(f.fake.testing.creates).toBe(1);
});
it('serializes two commands for one package without duplicate creation',async()=>{
  const f=proposalFixture();const values=await Promise.all([reconcileProposal(f.command().context,f.input(),f.deps),reconcileProposal(f.command().context,f.input(),f.deps)]);
  expect(values[0].link).toEqual(values[1].link);expect(f.fake.testing.creates).toBe(1);
});
it('allows a later explicit submission after the fresh gate denied a write before dispatch',async()=>{
  const f=proposalFixture();const denied={...f.deps,accessPolicy:{...f.deps.accessPolicy,async assertFreshPublishAllowed(){throw new WorkbenchHttpError(403,'ACCESS_DENIED','Denied before dispatch');}}};
  await expect(reconcileProposal(f.command().context,f.input(),denied)).rejects.toMatchObject({code:'ACCESS_DENIED'});expect(f.fake.testing.creates).toBe(0);
  const result=await reconcileProposal(f.command().context,f.input(),f.deps);expect(result.state).toBe('open');expect(f.fake.testing.creates).toBe(1);
});
it('never repeats a successful create when readback needs separate REST authentication',async()=>{
  const f=proposalFixture();const unreadable={...f.deps,bitbucket:{...f.fake,async readProposal(){throw new WorkbenchHttpError(409,'PR_AUTH_REQUIRED','Readback requires native login');}}};
  await expect(reconcileProposal(f.command().context,f.input(),unreadable)).rejects.toMatchObject({code:'PR_AUTH_REQUIRED'});expect(f.fake.testing.creates).toBe(1);
  const hidden={...f.deps,bitbucket:{...f.fake,async findProposal(){return null;}}};
  await expect(reconcileProposal(f.command().context,f.input(),hidden)).rejects.toMatchObject({code:'REMOTE_STATE_UNKNOWN'});expect(f.fake.testing.creates).toBe(1);
});
it('refuses a marker result that replaces the previously confirmed native PR identity',async()=>{
  const f=proposalFixture();const first=await reconcileProposal(f.command().context,f.input(),f.deps);
  const replaced={...first,link:{...first.link,id:'replacement',url:'https://bitbucket.invalid/proposals/replacement'}};
  await expect(reconcileProposal(f.command().context,f.input(),{...f.deps,bitbucket:{...f.fake,async findProposal(){return replaced;}}})).rejects.toMatchObject({code:'REMOTE_STATE_UNKNOWN'});
  expect(f.fake.testing.creates).toBe(1);expect(f.fake.testing.updates).toBe(0);
});
