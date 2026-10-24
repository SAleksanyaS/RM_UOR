import type { FastifyInstance } from 'fastify';
import type { ApplicationContext } from '../../server/workspace/context';
import type { PlanSaveInput } from './plan-contracts';
import { saveExecutionPlan } from './plan-service';

export function registerPlanRoutes(app: FastifyInstance, context: ApplicationContext) {
  app.post<{ Body: PlanSaveInput }>('/api/plans', async request => {
    const session = await context.roles.requireCurator(request.cookies.uor_session ?? '');
    return saveExecutionPlan(context, session, request.body);
  });
}
