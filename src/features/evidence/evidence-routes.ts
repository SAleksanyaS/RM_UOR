import type {FastifyInstance,FastifyRequest,FastifyReply} from 'fastify';
import type {ApplicationContext} from '../../server/workspace/context';
import {listEvidence,readEvidenceBytes} from './evidence-service';
export function registerEvidenceLibraryRoutes(app:FastifyInstance,context:ApplicationContext){
 async function sessionFor(request:FastifyRequest,reply:FastifyReply){const existing=context.roles.get(request.cookies.uor_session);if(existing)return existing;const session=await context.roles.enterReader();reply.setCookie('uor_session',session.id,{httpOnly:true,sameSite:'strict',path:'/',maxAge:86400});return session;}
 app.get('/api/evidence',async(request,reply)=>{reply.header('cache-control','no-store');return listEvidence(context,await sessionFor(request,reply));});
 app.get<{Params:{id:string}}>('/api/evidence/:id/download',async(request,reply)=>{const {record,bytes}=await readEvidenceBytes(context,await sessionFor(request,reply),request.params.id);return reply.header('content-type','application/octet-stream').header('content-disposition',`attachment; filename="evidence-${record.id}.bin"; filename*=UTF-8''${encodeURIComponent(record.name)}`).header('x-content-type-options','nosniff').header('content-security-policy',"default-src 'none'; sandbox").header('cache-control','no-store').header('content-length',bytes.length).send(bytes);});
}
