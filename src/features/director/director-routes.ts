import type { FastifyInstance } from 'fastify';
import type { ApplicationContext } from '../../server/workspace/context';
import type { DecisionSaveInput } from './decision-schema';
import { saveDecision } from './decision-service';
import { buildDirectorModel } from './director-model';
export function registerDirectorRoutes(app: FastifyInstance, context: ApplicationContext) {
  app.get('/api/director', async (request, reply) => {
    let session = context.roles.get(request.cookies.uor_session);
    if (!session) { session = await context.roles.enterReader(); reply.setCookie('uor_session', session.id, { httpOnly: true, sameSite: 'strict', path: '/', maxAge: 86400 }); }
    return buildDirectorModel(await context.catalogs.readForSession(session), context.visibleChanges(session));
  });
  app.post<{ Body: DecisionSaveInput }>('/api/director/decisions', async request => saveDecision(context, await context.roles.requireCurator(request.cookies.uor_session ?? ''), request.body));
}
