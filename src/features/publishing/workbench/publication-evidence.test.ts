import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach,expect,it } from 'vitest';
import { draftFixture,draftCleanups } from '../../../../tests/fixtures/workbench/drafts';
import { fixtureId,makeHeader,makeNumericFixture } from '../../../../tests/fixtures/workbench/factories';
import { createPackageArtifactStore } from './package-artifacts';
import { buildPackageManifest,canonicalBytes } from './package-manifest';
import { PublishingService } from './publishing-service';
import { registerPublishingCommands } from './register-commands';
import type { Evidence } from '../../../domain/workbench/entities';

afterEach(async()=>{for(const cleanup of draftCleanups.splice(0))await cleanup();});
it('downloads an imported evidence attachment through the actual reader service with exact bytes and hash',async()=>{
  const f=draftFixture({input:makeNumericFixture({scope:{kind:'dit',id:fixtureId(101)}})});
  const bytes=Buffer.from('Verified published evidence\n'),hash=createHash('sha256').update(bytes).digest('hex'),packageId=fixtureId(269200),artifactId=fixtureId(269202);
  const evidence:Evidence={...makeHeader(269201,{publicationAnchorId:packageId}),kind:'file',file:{artifactId,hash:'sha256:'+hash,mimeType:'text/plain',bytes:bytes.length}};
  const files=new Map([[`records/evidence/${evidence.id}/1.json`,canonicalBytes(evidence)],['artifacts/'+hash,bytes]]);
  const manifest=buildPackageManifest({package:{schemaVersion:1,packageId,cycleId:fixtureId(269203),curatorPersonId:fixtureId(17),revision:1,baseCommit:'a'.repeat(40),targetBranch:'main',createdAt:f.clock.now()},files});
  const prefix=`published/workbench/packages/${packageId}/1/`,main={repositoryId:'synthetic-main',commit:'b'.repeat(40),files:new Map([...files].map(([name,value])=>[prefix+name,value]))};main.files.set(prefix+'manifest.json',canonicalBytes(manifest));
  const publishing=new PublishingService({repository:f.repository,clock:f.clock,drafts:f.service,git:{async readMain(){return main;}},artifacts:createPackageArtifactStore({artifactRoot:path.join(f.root,'packages')}),accessPolicy:f.policy,jobs:f.jobs,jobSink:f.jobs,evidence:f.evidence,publication:{mode:'internal',classifyRecord:()=>true,classifyEvidence:async()=>true}});
  registerPublishingCommands(f.registry,publishing);f.context.ownAccess={...f.context.ownAccess,role:'viewer'};
  const commandId=fixtureId(269204),accepted=await f.registry.execute({commandId,name:'publication.apply',baseRevision:null,payload:{mainCommit:main.commit}},{...f.context,commandId});
  if(!('jobId'in accepted))throw Error('Expected async apply');await f.registry.idle();const job=f.jobs.get(accepted.jobId,f.context.installationId)!;
  expect(job.error).toBeNull();expect(job.status).toBe('succeeded');
  const downloaded=await f.evidence.readArtifactForContext(f.context,artifactId),chunks:Buffer[]=[];
  for await(const chunk of downloaded.stream)chunks.push(Buffer.from(chunk));
  expect(Buffer.concat(chunks)).toEqual(bytes);expect(downloaded.sha256).toBe(hash);expect(downloaded.bytes).toBe(bytes.length);
});
