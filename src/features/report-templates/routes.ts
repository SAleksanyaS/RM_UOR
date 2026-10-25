import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ApplicationContext } from '../../server/workspace/context';
import { listReportTemplates, saveReportTemplate, inspectUploadedTemplate, getReportTemplate, decodeTemplateBase64, renderSavedTemplate } from './service';
import { checkTemplate } from './ooxml';
import { templateProfileSchema } from './contracts';
import { readReport } from '../reporting/report-service';
export function registerReportTemplateRoutes(app: FastifyInstance, context: ApplicationContext) {
  async function sessionFor(request: FastifyRequest, reply: FastifyReply) {
    const existing = context.roles.get(request.cookies.uor_session); if (existing) return existing;
    const session = await context.roles.enterReader(); reply.setCookie('uor_session',session.id,{ httpOnly:true, sameSite:'strict', path:'/', maxAge:86400 }); return session;
  }
  app.get('/api/report-templates', async (request,reply) => { reply.header('cache-control','no-store'); return listReportTemplates(context,await sessionFor(request,reply)); });
  app.post('/api/report-templates/inspect', { bodyLimit: 29_000_000 }, async request => { const input = z.object({ base64:z.string().max(28_000_000) }).strict().parse(request.body); return inspectUploadedTemplate(await context.roles.requireCurator(request.cookies.uor_session ?? ''),input.base64); });
  app.post('/api/report-templates', { bodyLimit: 29_000_000 }, async request => saveReportTemplate(context,await context.roles.requireCurator(request.cookies.uor_session ?? ''),request.body));
  app.post<{ Params:{ id:string } }>('/api/report-templates/:id/check', async request => { const template = getReportTemplate(context,await context.roles.requireCurator(request.cookies.uor_session ?? ''),request.params.id); const profile = templateProfileSchema.parse(request.body); return checkTemplate(template.inspection,profile); });
  app.get<{ Params:{ id:string } }>('/api/report-templates/:id/original', async (request,reply) => { const template = getReportTemplate(context,await context.roles.requireCurator(request.cookies.uor_session ?? ''),request.params.id); reply.header('content-type','application/vnd.openxmlformats-officedocument.presentationml.presentation').header('cache-control','no-store').header('content-disposition','attachment; filename="template.pptx"'); return decodeTemplateBase64(template.base64); });
  app.get<{ Params:{ id:string }; Querystring:{ reportId:string } }>('/api/report-templates/:id/export',async (request,reply) => { const session = await sessionFor(request,reply), report = readReport(context,session,z.string().uuid().parse(request.query.reportId)); reply.header('content-type','application/vnd.openxmlformats-officedocument.presentationml.presentation').header('cache-control','no-store').header('content-disposition','attachment; filename="template-test.pptx"'); return renderSavedTemplate(context,session,request.params.id,report); });
}
