import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ApplicationContext } from '../../server/workspace/context';
import type { GoalSetupInput } from './goal-setup-contracts';
import { previewGoalSetup, commitGoalSetup } from './goal-setup-service';
import { ActionError } from '../identity/role-service';

export function registerGoalSetupRoutes(app: FastifyInstance, context: ApplicationContext) {
  app.post<{ Body: GoalSetupInput }>('/api/goal-setup/preview', async request => {
    if (request.headers['x-uor-token'] !== context.csrfToken) throw new ActionError('Обновите страницу перед выполнением действия', 403);
    const session = await context.roles.requireCurator(request.cookies.uor_session ?? '');
    return previewGoalSetup(context, session, request.body);
  });
  app.post('/api/goal-setup/commit', async request => {
    if (request.headers['x-uor-token'] !== context.csrfToken) throw new ActionError('Обновите страницу перед выполнением действия', 403);
    const session = await context.roles.requireCurator(request.cookies.uor_session ?? '');
    const input = z.object({ previewId: z.string().uuid() }).strict().parse(request.body);
    return commitGoalSetup(context, session, input.previewId);
  });
}
