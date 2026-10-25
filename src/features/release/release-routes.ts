import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ApplicationContext } from '../../server/workspace/context';
import { previewRelease,resolveReleaseConflict } from './release-service';
export function registerReleaseRoutes(app:FastifyInstance,context:ApplicationContext){
 app.post('/api/release/preview',async request=>previewRelease(context,await context.roles.requireCurator(request.cookies.uor_session??'')));
 app.post('/api/release/resolve',async request=>resolveReleaseConflict(context,await context.roles.requireCurator(request.cookies.uor_session??''),z.object({previewId:z.string().uuid(),draftId:z.string().min(1).max(500),choices:z.record(z.string(),z.enum(['local','remote']))}).strict().parse(request.body)));
}
