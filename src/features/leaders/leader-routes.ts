import type { FastifyInstance } from 'fastify';
import type { ApplicationContext } from '../../server/workspace/context';
import type { LeaderInput } from './leader-contracts';
import { saveLeader } from './leader-service';

/** Relies on the application's loopback/origin/CSRF hook, and enforces the role on every mutation. */
export function registerLeaderRoutes(app: FastifyInstance, context: ApplicationContext) {
  app.post<{ Body: LeaderInput }>('/api/leaders', async request => saveLeader(context,
    await context.roles.requireCurator(request.cookies.uor_session ?? ''), null, request.body));
  app.post<{ Params: { id: string }; Body: LeaderInput }>('/api/leaders/:id', async request => saveLeader(context,
    await context.roles.requireCurator(request.cookies.uor_session ?? ''), request.params.id, request.body));
}
