import type { FastifyInstance } from 'fastify';
import type { ApplicationContext } from '../../server/workspace/context';
import type { KnowledgeInput } from './knowledge-contracts';
import { archiveKnowledge, listKnowledge, saveKnowledge } from './knowledge-service';
import { ActionError } from '../identity/role-service';
export function registerKnowledgeRoutes(app: FastifyInstance, context: ApplicationContext) {
  app.get('/api/knowledge', async request => listKnowledge(context, context.roles.get(request.cookies.uor_session) ?? { id: '', role: 'reader', curatorId: null, name: 'Просмотр', createdAt: '' }));
  app.post<{ Body: KnowledgeInput }>('/api/knowledge', async request => {
    if (request.headers['x-uor-token'] !== context.csrfToken) throw new ActionError('Обновите страницу перед выполнением действия', 403);
    return saveKnowledge(context, await context.roles.requireCurator(request.cookies.uor_session ?? ''), request.body);
  });
  app.post<{ Params: { id: string }; Body: KnowledgeInput }>('/api/knowledge/:id', async request => {
    if (request.headers['x-uor-token'] !== context.csrfToken) throw new ActionError('Обновите страницу перед выполнением действия', 403);
    return saveKnowledge(context, await context.roles.requireCurator(request.cookies.uor_session ?? ''), request.body, request.params.id);
  });
  app.post<{ Params: { id: string }; Body: { baseRevision: string; archived: boolean } }>('/api/knowledge/:id/archive', async request => {
    if (request.headers['x-uor-token'] !== context.csrfToken) throw new ActionError('Обновите страницу перед выполнением действия', 403);
    return archiveKnowledge(context, await context.roles.requireCurator(request.cookies.uor_session ?? ''), request.params.id, request.body);
  });
}
