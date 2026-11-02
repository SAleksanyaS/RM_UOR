import {afterEach,it,expect} from 'vitest';
import {draftFixture,draftCleanups} from '../../../tests/fixtures/workbench/drafts';
import {createWorkbenchReadIndex} from './workbench-read-index';
import {contextForScope,assertContextGraph} from './workbench-search';
import {materialDirectoryEntries} from '../knowledge/workbench-service';
import {loadMaturityMaterials} from '../maturity/workbench-materials';
import {globalContextSchema,type GlobalContext} from '../../server/workbench/protocol';
import {stableJson} from '../../server/workbench/command-store';
afterEach(async()=>{while(draftCleanups.length)await draftCleanups.pop()!();});
it('navigates actual block tribe cluster team and rejects unrelated root without inventing a DIT',()=>{
 const f=draftFixture(),b=loadMaturityMaterials();f.repository.transaction(()=>{for(const e of materialDirectoryEntries(b))f.repository.append(e.entityType,{schemaVersion:1,id:e.id,revision:1,recordedAt:f.clock.now(),actor:f.context.actor,publicationAnchorId:f.input.goal.publicationAnchorId,...e.definition} as never,null);});
 const index=createWorkbenchReadIndex(f.repository),block=b.organizations.find(o=>o.kind==='block')!;
 const base={scopePath:{ditId:block.id,rootKind:'block',clusterId:null,productId:null,teamId:null},goalId:null,time:{kind:'as_of',date:'2026-10-30'},resultMode:'current',snapshotId:null} as GlobalContext;
 const target=contextForScope({kind:'team',id:b.teams[0].id},index,base);
 expect(target?.scopePath).toEqual({ditId:block.id,rootKind:'block',clusterId:b.teams[0].clusterId,productId:null,teamId:b.teams[0].id});expect(globalContextSchema.safeParse(target).success).toBe(true);expect(()=>assertContextGraph(target!,index)).not.toThrow();
 expect(()=>assertContextGraph({...target!,scopePath:{...target!.scopePath,ditId:f.input.assignment.scope.id}},index)).toThrow();
 expect(index.list('directory_entity').filter(e=>e.kind==='dit').some(e=>e.id===block.id)).toBe(false);
});
it('preserves old context wire shape and hash input without inserting optional defaults',()=>{
 const old={scopePath:{ditId:'00000000-0000-4000-8000-000000000001',clusterId:null,productId:null,teamId:null},goalId:null,time:{kind:'as_of',date:'2026-10-30'},resultMode:'current',snapshotId:null};
 expect(stableJson(globalContextSchema.parse(old))).toBe(stableJson(old));
});
