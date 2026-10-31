import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { createWorkbenchApplication, recoverWorkbenchCommands, type WorkbenchApplicationDeps } from './application';
import { registerWorkbenchRoutes } from './routes';

/** Isolated v1 composition; legacy launcher is deliberately unchanged until T39. */
export async function createWorkbenchApp(deps: WorkbenchApplicationDeps, options: { configure?: (app: FastifyInstance) => Promise<void> } = {}): Promise<FastifyInstance> {
  await deps.maintenance?.recover?.();
  const application = createWorkbenchApplication(deps);
  const app = Fastify({ logger: false, trustProxy: false });
  app.addHook('onClose', async () => { await deps.notifications?.stop(); });
  try {
    await app.register(cookie);
    app.decorate('workbenchTransport', { sessions: deps.sessions, allowedOrigins: deps.allowedOrigins });
    await registerWorkbenchRoutes(app, application);
    await options.configure?.(app);
    await app.ready();
    await recoverWorkbenchCommands(deps);
    deps.notifications?.start();
    return app;
  } catch (error) { await app.close(); throw error; }
}
