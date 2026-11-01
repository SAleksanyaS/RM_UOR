import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { createWorkbenchApplication, recoverWorkbenchCommands, type WorkbenchApplicationDeps } from './application';
import { registerWorkbenchRoutes } from './routes';

/** Production v1 composition; startup admission is controlled by the runtime coordinator. */
export async function createWorkbenchApp(deps: WorkbenchApplicationDeps, options: { deferActivation?: boolean; configure?: (app: FastifyInstance) => Promise<void> } = {}): Promise<FastifyInstance> {
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
    if (!options.deferActivation) { await recoverWorkbenchCommands(deps); deps.notifications?.start(); }
    return app;
  } catch (error) { await app.close(); throw error; }
}
