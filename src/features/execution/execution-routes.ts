import type { FastifyInstance } from 'fastify';
import type { ApplicationContext } from '../../server/workspace/context';
import type { ConfigInput, PackageInput } from './execution-contracts';
import { baselinePackage, checkRetention, completePackage, getExecutionView, saveExecutionConfig, saveWorkPackage } from './execution-service';
import { baselineInputSchema } from './execution-schema';
export function registerExecutionRoutes(app: FastifyInstance, context: ApplicationContext) {
  app.get('/api/execution', async (request, reply) => {
    let session = context.roles.get(request.cookies.uor_session);
    if (!session) { session = await context.roles.enterReader(); reply.setCookie('uor_session', session.id, { httpOnly: true, sameSite: 'strict', path: '/', maxAge: 86400 }); }
    return getExecutionView(context, session);
  });
  const curator = (request: { cookies: Partial<Record<string, string>> }) => context.roles.requireCurator(request.cookies.uor_session ?? '');
  app.post<{ Body: PackageInput }>('/api/execution/packages', async request => saveWorkPackage(context, await curator(request), request.body));
  app.post<{ Body: ConfigInput }>('/api/execution/config', async request => saveExecutionConfig(context, await curator(request), request.body));
  app.post<{ Params: { id: string }; Body: { baseRevision: string } }>('/api/execution/packages/:id/baseline', async request => baselinePackage(context, await curator(request), request.params.id, baselineInputSchema.parse(request.body).baseRevision));
  app.post<{ Params: { id: string } }>('/api/execution/packages/:id/completion', async request => completePackage(context, await curator(request), request.params.id, request.body));
  app.post<{ Params: { id: string } }>('/api/execution/config/:id/check', async request => checkRetention(context, await curator(request), request.params.id, request.body));
}
