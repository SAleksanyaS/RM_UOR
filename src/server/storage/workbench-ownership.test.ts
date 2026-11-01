import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { expect,it } from 'vitest';
import { createWorkbenchRepository } from './workbench-repository';
import { createWorkspaceOwnership } from './workbench-ownership';
it('retains a trusted person across installation restore and rejects person collisions',()=>{
 const repository=createWorkbenchRepository({filename:':memory:',artifactRoot:tmpdir()});
 try { const owners=createWorkspaceOwnership(repository),personId=randomUUID(),installationId=randomUUID(),key=randomUUID();
 owners.bind({moduleId:'sources',key,personId,installationId,provenance:'created'});
 expect(owners.read('sources',key)).toEqual({personId,installationId,provenance:'created'});
 const target=randomUUID();owners.bind({moduleId:'sources',key,personId,installationId:target,provenance:'restore'});
 expect(owners.read('sources',key)?.installationId).toBe(target);
 expect(()=>owners.bind({moduleId:'sources',key,personId:randomUUID(),installationId:target,provenance:'created'})).toThrow();
 expect(owners.read('sources','missing')).toBeNull();
 } finally {repository.close();}
});
