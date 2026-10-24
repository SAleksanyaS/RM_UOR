import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ApplicationContext } from '../../server/workspace/context';
import type { MaturityImportInput } from './import-contracts';
import { previewMaturityImport, commitMaturityImport } from './import-service';

export function registerMaturityImportRoutes(app: FastifyInstance, context: ApplicationContext) {
  app.post<{ Body: MaturityImportInput }>('/api/import/maturity/preview', async request => {
    const session = await context.roles.requireCurator(request.cookies.uor_session ?? '');
    return previewMaturityImport(context, session, request.body);
  });
  app.post('/api/import/maturity/commit', async request => {
    const session = await context.roles.requireCurator(request.cookies.uor_session ?? '');
    const input = z.object({ previewId: z.string().uuid() }).parse(request.body);
    return commitMaturityImport(context, session, input.previewId);
  });
}
