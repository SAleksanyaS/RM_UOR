import type { FastifyInstance } from 'fastify';
import type { ApplicationContext } from '../../server/workspace/context';
import { getGoalHistory } from './history-service';

export function registerHistoryRoutes(app: FastifyInstance, context: ApplicationContext) {
  app.get<{ Params: { id: string }; Querystring: { leaderId?: string } }>('/api/goals/:id/history', async (request, reply) => {
    let session = context.roles.get(request.cookies.uor_session);
    if (!session) {
      session = await context.roles.enterReader();
      reply.setCookie('uor_session', session.id, { httpOnly: true, sameSite: 'strict', path: '/', maxAge: 86400 });
    }
    return getGoalHistory(context, session, request.params.id, request.query.leaderId || null);
  });
}
