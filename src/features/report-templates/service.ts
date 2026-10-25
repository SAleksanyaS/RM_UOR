import {suggestedMaturityProfile} from './maturity-preset';
import { createHash, randomUUID } from 'node:crypto';
import type { ApplicationContext } from '../../server/workspace/context';
import type { Session } from '../../domain/contracts';
import { ActionError } from '../identity/role-service';
import { templateSaveSchema, templateBundleSchema, type StoredReportTemplate, type ReportTemplateBundle, type ReportTemplateMetadata } from './contracts';
import { checkTemplate, inspectTemplate, renderTemplate } from './ooxml';
import type { ReportSnapshot } from '../reporting/report-contracts';

const metadata = ({ base64: _bytes, ownerId: _owner, ...rest }: StoredReportTemplate): ReportTemplateMetadata => rest;
export function decodeTemplateBase64(input: string) {
  if (!input || !/^[A-Za-z0-9+/]*={0,2}$/.test(input) || input.length % 4) throw new ActionError('Некорректное содержимое PPTX (base64)',400);
  return Buffer.from(input,'base64');
}
export function listReportTemplates(context: ApplicationContext, session: Session) {
  const own = context.db.list<StoredReportTemplate>('report-templates').filter(t => t.ownerId === session.curatorId);
  return [...own,...context.db.list<StoredReportTemplate>('shared-report-templates').filter(shared => !own.some(t=>t.id===shared.id))].map(metadata);
}
export function getReportTemplate(context: ApplicationContext, session: Session, id: string) {
  const own = context.db.get<StoredReportTemplate>('report-templates',id);
  const template = own?.ownerId === session.curatorId ? own : context.db.get<StoredReportTemplate>('shared-report-templates',id);
  if (!template) throw new ActionError('Шаблон недоступен в этой сессии',404);
  return template;
}
export async function saveReportTemplate(context: ApplicationContext, session: Session, raw: unknown) {
  if (session.role !== 'curator' || !session.curatorId) throw new ActionError('Шаблоны изменяет куратор УОР',403);
  const input = templateSaveSchema.parse(raw), previous = input.id ? getReportTemplate(context,session,input.id) : null;
  if (previous?.shared && previous.ownerId !== session.curatorId) throw new ActionError('Создайте личную копию общего шаблона',403);
  if ((previous?.revision ?? null) !== input.baseRevision) throw new ActionError('Шаблон изменился; откройте актуальную версию',409);
  const base64 = input.base64 ?? previous?.base64;
  if (!base64) throw new ActionError('Загрузите исходный PPTX',400);
  const inspection = await inspectTemplate(decodeTemplateBase64(base64)); checkTemplate(inspection,input.profile);
  const catalog = await context.catalogs.readForSession(session);
  const template: StoredReportTemplate = { id: previous?.id ?? randomUUID(), revision: randomUUID(), classification: catalog.classification, createdBy: session.name, updatedAt: new Date().toISOString(), ownerId: session.curatorId, profile: input.profile, inspection, base64, shared: false };
  // Parsing and validation are asynchronous. Compare again inside the atomic write.
  context.db.transaction(() => {
    if ((context.db.get<StoredReportTemplate>('report-templates',template.id)?.revision ?? null) !== input.baseRevision) throw new ActionError('Шаблон изменился во время проверки',409);
    context.db.set('report-templates',template.id,template);
  });
  return metadata(template);
}
export async function inspectUploadedTemplate(session: Session, base64: string) {
  if (session.role !== 'curator') throw new ActionError('Загрузку проверяет куратор УОР',403);
  const inspection=await inspectTemplate(decodeTemplateBase64(base64));const suggestedProfile=suggestedMaturityProfile(inspection);return{...inspection,...(suggestedProfile?{suggestedProfile}:{})};
}
export async function renderSavedTemplate(context: ApplicationContext, session: Session, id: string, report: ReportSnapshot) {
  const template = getReportTemplate(context,session,id);
  if (template.classification !== report.classification) throw new ActionError('Классификация шаблона и отчёта различается',400);
  return renderTemplate(decodeTemplateBase64(template.base64),template.profile,report);
}
/** Call only for the templates explicitly selected in publication preview. */
export function exportTemplateBundle(context: ApplicationContext, id: string, session?: Session): ReportTemplateBundle {
  const stored = session ? getReportTemplate(context,session,id) : context.db.get<StoredReportTemplate>('report-templates',id) ?? context.db.get<StoredReportTemplate>('shared-report-templates',id); if (!stored) throw new ActionError('Шаблон для публикации не найден',404);
  return templateBundleSchema.parse({ schemaVersion: 1, classification: stored.classification, id: stored.id, profile: stored.profile, sha256: stored.inspection.sha256, base64: stored.base64 });
}
export async function validateTemplateBundle(raw: unknown) {
  const bundle = templateBundleSchema.parse(raw), bytes = decodeTemplateBase64(bundle.base64);
  if (createHash('sha256').update(bytes).digest('hex') !== bundle.sha256) throw new ActionError('Хеш шаблона не совпадает',400);
  const inspection = await inspectTemplate(bytes); checkTemplate(inspection,bundle.profile); return { bundle, inspection };
}
export async function importTemplateBundle(context: ApplicationContext, raw: unknown) {
  const { bundle,inspection } = await validateTemplateBundle(raw);
  return storeValidatedTemplateBundle(context,{bundle,inspection});
}
/** Synchronous store for an already-validated complete release inside its DB transaction. */
export function storeValidatedTemplateBundle(context: ApplicationContext, {bundle,inspection}: Awaited<ReturnType<typeof validateTemplateBundle>>) {
  const template: StoredReportTemplate = { id: bundle.id, classification: bundle.classification, profile: bundle.profile, base64: bundle.base64, inspection, revision: bundle.sha256, ownerId: '', shared: true, createdBy: 'Общий выпуск', updatedAt: new Date().toISOString() };
  // Shared releases and personal working copies have separate slots.
  const previous = context.db.get<StoredReportTemplate>('report-templates',bundle.id);
  context.db.set('shared-report-templates',bundle.id,template); return { id: bundle.id, retainedPrivate: !!previous };
}
