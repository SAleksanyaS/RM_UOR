import type { FastifyInstance } from 'fastify';
import type { ApplicationContext } from '../../server/workspace/context';
import type { Session } from '../../domain/contracts';
import { ActionError } from '../identity/role-service';
import { listWeeklyReports, saveWeeklyBrief } from './service';

const reader: Session = { id: '', role: 'reader', curatorId: null, name: 'Просмотр', createdAt: '' };
export function registerWeeklyReportRoutes(app: FastifyInstance, context: ApplicationContext) {
  app.get<{ Querystring: { weekStart?: string } }>('/api/weekly-reports', async request =>
    listWeeklyReports(context, context.roles.get(request.cookies.uor_session) ?? reader, request.query.weekStart));
  app.post('/api/weekly-reports', async request => {
    if (request.headers['x-uor-token'] !== context.csrfToken) throw new ActionError('Обновите страницу перед выполнением действия', 403);
    return saveWeeklyBrief(context, await context.roles.requireCurator(request.cookies.uor_session ?? ''), request.body);
  });
}
