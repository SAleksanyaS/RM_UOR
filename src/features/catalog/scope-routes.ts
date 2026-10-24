import type { FastifyInstance } from 'fastify';
import type { ApplicationContext } from '../../server/workspace/context';
import type { AssignmentScopeInput } from './scope-contracts';
import { saveAssignmentScope } from './assignment-scope';

export function registerScopeRoutes(app: FastifyInstance, context: ApplicationContext) {
  app.post<{ Params: { id: string }; Body: AssignmentScopeInput }>('/api/assignments/:id/scope', async request => {
    const session = await context.roles.requireCurator(request.cookies.uor_session ?? '');
    return saveAssignmentScope(context, session, request.params.id, request.body);
  });
}
