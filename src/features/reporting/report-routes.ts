import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ApplicationContext } from '../../server/workspace/context';
import { generateReport, readReport, readFrozenTemplatePptx } from './report-service';
import { reportHtml, reportPptx } from './report-export';
import type { ReportSelection } from './report-contracts';
import { saveReportProfile } from './report-profile-service';

export function registerReportRoutes(app: FastifyInstance, context: ApplicationContext) {
  async function sessionFor(request: FastifyRequest, reply: FastifyReply) {
    const existing = context.roles.get(request.cookies.uor_session); if (existing) return existing;
    const session = await context.roles.enterReader(); reply.setCookie('uor_session', session.id, { httpOnly: true, sameSite: 'strict', path: '/', maxAge: 86400 }); return session;
  }
  app.post<{ Body: ReportSelection }>('/api/reports', async (request, reply) => generateReport(context, await sessionFor(request, reply), request.body));
  app.post('/api/reports/profiles', async request => saveReportProfile(context, await context.roles.requireCurator(request.cookies.uor_session ?? ''), request.body));
  app.get<{ Params: { id: string } }>('/api/reports/:id/html', async (request, reply) => {
    const report = readReport(context, await sessionFor(request, reply), request.params.id);
    reply.header('content-type', 'text/html; charset=utf-8').header('cache-control', 'no-store').header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'");
    return reportHtml(report);
  });
  app.get<{ Params: { id: string } }>('/api/reports/:id/pptx', async (request, reply) => {
    const session = await sessionFor(request, reply), report = readReport(context, session, request.params.id);
    reply.header('content-type', 'application/vnd.openxmlformats-officedocument.presentationml.presentation').header('cache-control', 'no-store').header('content-disposition', `attachment; filename="uor-report-${report.selection.period}.pptx"`);
    return await readFrozenTemplatePptx(context, session, report.id) ?? reportPptx(report);
  });
}
