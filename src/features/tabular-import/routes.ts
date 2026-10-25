import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ApplicationContext } from '../../server/workspace/context';
import type { TabularFileInput, TabularPreviewInput } from './contracts';
import { probeTabularImport, previewTabularImport, commitTabularImport } from './service';
export function registerTabularImportRoutes(app: FastifyInstance, context: ApplicationContext) {
  app.post<{ Body: TabularFileInput }>('/api/import/tabular/probe', async request => probeTabularImport(context, await context.roles.requireCurator(request.cookies.uor_session ?? ''), request.body));
  app.post<{ Body: TabularPreviewInput }>('/api/import/tabular/preview', async request => previewTabularImport(context, await context.roles.requireCurator(request.cookies.uor_session ?? ''), request.body));
  app.post('/api/import/tabular/commit', async request => {
    const session = await context.roles.requireCurator(request.cookies.uor_session ?? ''), input = z.object({ previewId: z.string().uuid() }).parse(request.body);
    return commitTabularImport(context, session, input.previewId);
  });
}
