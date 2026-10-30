import { afterEach, expect, it } from 'vitest';
import { createWorkbenchTestApplication } from '../../../server/workbench/testing/test-application';

const cleanups:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0).reverse()) await cleanup();});
it('does not expose legacy publication, sync or password writes through the new application factory',async()=>{
  const f=await createWorkbenchTestApplication({role:'curator',scenario:'scope-split'});cleanups.push(f.close);const before=f.repository.getStateRevision();
  const session=await f.app.inject({method:'GET',url:'/api/v1/session',headers:{origin:'http://127.0.0.1:5173'}});
  const headers={origin:'http://127.0.0.1:5173',cookie:session.cookies.map(cookie=>cookie.name+'='+cookie.value).join('; '),'x-csrf-token':session.json().data.csrfToken};
  for(const url of ['/api/publishing/publish','/api/publishing/sync','/api/publishing/credentials','/api/auth/login','/api/release/current','/api/v1/publishing/publish']) {
    const result=await f.app.inject({method:'POST',url,headers,payload:{password:'synthetic-only'}});expect([404,410]).toContain(result.statusCode);
  }
  expect(f.repository.getStateRevision()).toBe(before);
});
