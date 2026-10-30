import { afterEach,expect,it } from 'vitest';
import { draftCleanups } from '../../../../tests/fixtures/workbench/drafts';
import { proposalFixture,syntheticCapabilities } from '../../../../tests/fixtures/workbench/proposals';
import { createUnavailableBitbucketPort } from './bitbucket-port';

afterEach(async()=>{for(const cleanup of draftCleanups.splice(0)) await cleanup();});
it('keeps native author independent and exposes no application merge operation',async()=>{
  const f=proposalFixture(),input=f.input();const created=await f.fake.createProposal(input);
  expect(created.packageId).toBe(input.packageRevision.packageId);expect(created.author.externalId).toBe('synthetic-native-author');
  expect(created.author.externalId).not.toBe(input.packageRevision.curatorPersonId);expect('merge' in f.fake).toBe(false);
  expect(await f.fake.findProposal(created.packageId)).toEqual(created);
});
it('uses stable package markers and rejects ambiguous matches',async()=>{
  const f=proposalFixture();await f.fake.createProposal(f.input());await f.fake.createProposal({...f.input(),summary:'Другой заголовок'});
  await expect(f.fake.findProposal(f.input().packageRevision.packageId)).rejects.toMatchObject({code:'REMOTE_STATE_UNKNOWN'});
});
it('defaults production capabilities to unavailable rather than a synthetic success',async()=>{
  const port=createUnavailableBitbucketPort();const capabilities=await port.capabilities();
  expect(capabilities.nativePullRequests).toBe(false);expect(capabilities.terminalAuthProfileId).toBeNull();expect(capabilities.profileId).not.toBe(syntheticCapabilities.profileId);
  await expect(port.findProposal('00000000-0000-4000-8000-000000000001')).rejects.toMatchObject({code:'BITBUCKET_NOT_READY'});expect('merge' in port).toBe(false);
});
