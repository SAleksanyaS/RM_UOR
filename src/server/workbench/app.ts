import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { createWorkbenchApplication, recoverWorkbenchCommands, type WorkbenchApplicationDeps } from './application';
import { registerWorkbenchRoutes } from './routes';

/** Isolated v1 composition; legacy launcher is deliberately unchanged until T39. */
export async function createWorkbenchApp(deps: WorkbenchApplicationDeps): Promise<FastifyInstance> {
  const application = createWorkbenchApplication(deps);
  const app = Fastify({ logger: false, trustProxy: false });
  try {
    await app.register(cookie);
    app.decorate('workbenchTransport', { sessions: deps.sessions, allowedOrigins: deps.allowedOrigins });
    await registerWorkbenchRoutes(app, application);
    await app.ready();
    await recoverWorkbenchCommands(deps);
    return app;
  } catch (error) { await app.close(); throw error; }
}
