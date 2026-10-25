import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { z, ZodError } from 'zod';
import { randomUUID, createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import type { CuratorSession, Goal, GoalComment, LocalSnapshot, Observation, Session } from '../domain/contracts';
import { createContext, type AppOptions } from './workspace/context';
import { safeArtifactPath } from './workspace/paths';
import { ActionError } from '../features/identity/role-service';
import { directionPatchSchema, goalPatchSchema } from '../features/catalog/catalog-store';
import { getDirections, normalizeDirections } from '../features/catalog/directions';
import { validateAchievement } from '../features/evaluation/evaluate';
import { importGoalMap } from '../features/catalog/import-map';
import { checkRemoteUpdates, publishChanges, syncPublished } from '../features/publishing/application-publishing';
import { registerMaturityImportRoutes } from '../features/importing/import-routes';
import { registerHistoryRoutes } from '../features/history/history-routes';
import { registerScopeRoutes } from '../features/catalog/scope-routes';
import { registerLeaderRoutes } from '../features/leaders/leader-routes';
import { registerPlanRoutes } from '../features/planning/plan-routes';
import { registerGoalSetupRoutes } from '../features/goal-setup/goal-setup-routes';
import { registerTabularImportRoutes } from '../features/tabular-import/routes';
import { registerReportRoutes } from '../features/reporting/report-routes';
import { registerDirectorRoutes } from '../features/director/director-routes';
import { registerKnowledgeRoutes } from '../features/knowledge/knowledge-routes';
import { isKnowledgeType } from '../features/knowledge/knowledge-contracts';
import { registerConnectorRoutes } from '../features/connectors/routes';
import { collectConfiguredSource } from '../features/connectors/service';
import { registerExecutionRoutes } from '../features/execution/execution-routes';
import { registerReportTemplateRoutes } from '../features/report-templates/routes';
import { registerSystemRoutes } from '../features/system/system-routes';
import { APP_VERSION } from '../domain/app-version';
import { captureEvaluationBasis } from '../features/reporting/evaluation-basis';
import {registerWorkspaceMaintenanceRoutes} from '../features/workspace-maintenance/routes';
import { registerReleaseRoutes } from '../features/release/release-routes';
import { registerEvidenceLibraryRoutes } from '../features/evidence/evidence-routes';
import { registerCodeUpdateRoutes } from '../features/system/code-update';
import { requiresCuratorForApi } from '../features/identity/permissions';
import {registerWeeklyReportRoutes} from '../features/weekly-report/routes';

export async function createApp(options: AppOptions) {
  const context = await createContext(options);
  const app = Fastify({ logger: false, bodyLimit: 22_000_000 });
  await app.register(cookie);
  const countedRequests=new WeakSet<object>();
  const releaseRequest=(request:object)=>{if(countedRequests.delete(request))context.activeRequests=Math.max(0,context.activeRequests-1);};
  app.addHook('onResponse',async request=>releaseRequest(request));
  app.addHook('onRequestAbort',async request=>releaseRequest(request));
  app.addHook('preClose',async()=>{context.maintenance=true;for(const controller of context.cancelled.values())controller.abort();await context.waitBackground();});
  app.addHook('onClose', async () => { context.db.close(); });
  app.setErrorHandler((error, _request, reply) => {
    const e = error as Error & { statusCode?: number };
    const status = error instanceof ZodError ? 400 : e.statusCode && e.statusCode >= 400 && e.statusCode < 600 ? e.statusCode : 500;
    const message = error instanceof ZodError ? 'Проверьте поля формы: ' + error.issues.map(i => i.path.join('.') + ' — ' + i.message).join('; ') : e.message || 'Не удалось выполнить действие';
    reply.code(status).send({ message });
  });
  app.addHook('onRequest', async (request, reply) => {
    const hostname = (request.headers.host ?? '').split(':')[0].toLowerCase();
    if (hostname && !['localhost', '127.0.0.1', '['].includes(hostname)) throw new ActionError('Разрешён только локальный доступ', 403);
    const origin = request.headers.origin;
    const allowed = new Set([`http://127.0.0.1:${context.config.clientPort}`, `http://localhost:${context.config.clientPort}`, `http://127.0.0.1:${context.config.port}`, `http://localhost:${context.config.port}`]);
    if (origin && !allowed.has(origin)) throw new ActionError('Запрос с посторонней страницы отклонён', 403);
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.headers['x-uor-token'] !== context.csrfToken) throw new ActionError('Обновите страницу перед выполнением действия', 403);
    if(context.maintenance)throw new ActionError('Выполняется обслуживание локальной базы. Повторите действие через несколько секунд.',503);
    if(requiresCuratorForApi(request.method,request.routeOptions.url??request.url))await context.roles.requireCurator(request.cookies.uor_session??'');
    countedRequests.add(request);context.activeRequests++;
  });
  const sessionFor = async (request: { cookies: Record<string, string | undefined> }, reply?: { setCookie: (name: string, value: string, options: object) => unknown }): Promise<Session> => {
    let session = context.roles.get(request.cookies.uor_session);
    if (!session) {
      session = await context.roles.enterReader();
      reply?.setCookie('uor_session', session.id, { httpOnly: true, sameSite: 'strict', path: '/', maxAge: 86400 });
    }
    return session;
  };
  const curator = async (request: { cookies: Record<string, string | undefined> }) => context.roles.requireCurator(request.cookies.uor_session ?? '');
  registerMaturityImportRoutes(app, context);
  registerHistoryRoutes(app, context);
  registerScopeRoutes(app, context);
  registerLeaderRoutes(app, context);
  registerPlanRoutes(app, context);
  registerGoalSetupRoutes(app, context);
  registerTabularImportRoutes(app, context);
  registerReportRoutes(app, context);
  registerDirectorRoutes(app, context);
  registerWeeklyReportRoutes(app, context);
  registerKnowledgeRoutes(app, context);
  registerConnectorRoutes(app, context);
  registerExecutionRoutes(app, context);
  registerReportTemplateRoutes(app, context);
  registerSystemRoutes(app, context);
  registerWorkspaceMaintenanceRoutes(app,context);
  registerReleaseRoutes(app, context);
  registerEvidenceLibraryRoutes(app, context);
  registerCodeUpdateRoutes(app, context);
  app.get('/api/health', async () => ({ status: 'ready', name: 'УОР ДИТ Operations', version: APP_VERSION }));
  app.get('/api/state', async (request, reply) => context.state(await sessionFor(request, reply)));
  app.get('/api/identity/accounts',async(_request,reply)=>{reply.header('cache-control','no-store');return{accounts:context.roles.listAccounts()};});
  app.post('/api/login', async (request, reply) => {
    const input = z.object({ role: z.enum(['reader', 'curator']), code: z.string().max(256).optional(),accountId:z.string().min(1).max(300).optional() }).strict().parse(request.body);
    const session = input.role === 'curator' ? await context.roles.enterCurator(input.code ?? '',input.accountId) : await context.roles.enterReader();
    const previous = request.cookies.uor_session; if (previous) context.db.remove('sessions', previous);
    reply.setCookie('uor_session', session.id, { httpOnly: true, sameSite: 'strict', path: '/', maxAge: 86400 }); return { session };
  });
  app.post<{ Params: { id: string } }>('/api/goals/:id', async request => {
    const session = await curator(request); const catalog = await context.catalogs.readForSession(session);
    const goal = catalog.goals.find(g => g.id === request.params.id); if (!goal) throw new ActionError('Цель не найдена', 404);
    const raw = z.record(z.string(), z.unknown()).parse(request.body);
    if (Object.hasOwn(raw, 'plan')) throw new ActionError('Ход работ и сроки сохраняются отдельно в панели плана цели.', 400);
    const patch = goalPatchSchema.parse(raw);
    if (patch.workDirectionId && !getDirections(catalog).some(direction => direction.id === patch.workDirectionId)) throw new ActionError('Направление не найдено', 400);
    if (raw.baseRevision && raw.baseRevision !== goal.revision) throw new ActionError('Цель уже изменилась. Обновите данные перед сохранением.', 409);
    const op = await context.operations.start('import', 'Сохранение цели');
    await context.operations.stage(op.id, { key: 'draft', label: 'Сохранение локального черновика' });
    const draft = await context.catalogs.saveDraft(session, { kind: 'goal', id: goal.id, baseRevision: goal.revision, patch });
    context.catalogs.recordChange(session, 'goal_updated', goal.id, goal.title, goal as unknown as Record<string, unknown>, patch, op.id);
    await context.operations.finish(op.id, { status: 'completed', message: 'Черновик сохранён на этом компьютере' });
    return { draft, operationId: op.id };
  });
  const directionHandler = async (request: { params?: unknown; body: unknown; cookies: Record<string, string | undefined> }) => {
    const session = await curator(request); const catalog = await context.catalogs.readForSession(session);
    const existingId = (request.params as { id?: string } | undefined)?.id;
    const input = directionPatchSchema.parse(request.body);
    const original = existingId ? getDirections(catalog).find(direction => direction.id === existingId) : undefined;
    if (existingId && !original) throw new ActionError('Направление не найдено', 404);
    if (!existingId && !input.name) throw new ActionError('Укажите название направления', 400);
    const id = existingId ?? randomUUID();
    const direction = { id, name: input.name ?? original!.name, description: input.description ?? original?.description ?? '',
      color: input.color ?? original?.color ?? '#667486', order: input.order ?? original?.order ?? Math.max(0, ...getDirections(catalog).map(item => item.order)) + 1 };
    const draft = await context.catalogs.saveDraft(session, { kind: 'direction', id, baseRevision: null, patch: { ...direction } });
    context.catalogs.recordChange(session, original ? 'direction_updated' : 'direction_added', id, direction.name, { ...original }, direction);
    return { draft };
  };
  app.post('/api/directions', directionHandler); app.post('/api/directions/:id', directionHandler); app.patch('/api/directions/:id', directionHandler);
  app.post('/api/comments', async request => {
    const session = await curator(request);
    const input = z.object({ goalId: z.string().min(1), leaderId: z.string().nullable().optional(), text: z.string().trim().min(1).max(10000), validUntil: z.string().nullable().optional() }).parse(request.body);
    const catalog = await context.catalogs.readForSession(session);
    if (!catalog.goals.some(g => g.id === input.goalId)) throw new ActionError('Цель не найдена', 404);
    const comment: GoalComment = { id: randomUUID(), goalId: input.goalId, leaderId: input.leaderId ?? null, text: input.text, author: session.name, createdAt: new Date().toISOString(), validUntil: input.validUntil ?? null, revision: randomUUID() };
    const draft = await context.catalogs.saveDraft(session, { kind: 'comment', id: comment.id, baseRevision: null, patch: { ...comment } });
    context.catalogs.recordChange(session, 'comment_added', comment.id, 'Комментарий УОР', {}, { text: comment.text, goalId: comment.goalId }); return { draft };
  });
  app.post<{ Params: { id: string } }>('/api/assignments/:id', async request => {
    const session = await curator(request); const catalog = await context.catalogs.readForSession(session);
    const assignment = catalog.assignments.find(a => a.id === request.params.id);
    if (!assignment) throw new ActionError('Назначение не найдено', 404);
    const patch = z.object({ active: z.boolean().optional(), teams: z.array(z.string().trim().min(1).max(500)).max(500).optional(), participantIds: z.array(z.string().trim().min(1).max(200)).max(5000).optional(), target: z.string().max(10000).optional(), summary: z.string().max(10000).optional() }).parse(request.body);
    const draft = await context.catalogs.saveDraft(session, { kind: 'assignment', id: assignment.id, baseRevision: null, patch });
    context.catalogs.recordChange(session, 'assignment_updated', assignment.id, `${catalog.goals.find(g => g.id === assignment.goalId)?.title ?? 'Назначение цели'} · ${catalog.leaders.find(l => l.id === assignment.leaderId)?.name ?? 'ИТ-лидер'}`, { ...assignment }, patch);
    return { draft };
  });
  app.post('/api/confirm', async request => {
    const session = await curator(request);
    const input = z.object({ goalId: z.string(), leaderId: z.string().nullable().optional(), baseFingerprint: z.string().max(500).optional(), comment: z.string().nullable().optional(), evidenceIds: z.array(z.string()).max(30).default([]) }).parse(request.body);
    const state = await context.state(session);
    const evaluation = state.evaluations.find(e => e.goalId === input.goalId && e.leaderId === (input.leaderId ?? null));
    if (!evaluation) throw new ActionError('Оценка цели не найдена', 404);
    if (input.baseFingerprint && input.baseFingerprint !== evaluation.fingerprint) throw new ActionError('Расчёт изменился после открытия формы. Проверьте новые значения перед подтверждением.', 409);
    if (evaluation.qualityFlags.includes('stale')) throw new ActionError('Срез устарел. Для текущего подтверждения обновите данные или внесите актуальный факт.', 409);
    const goal = state.catalog.goals.find(g => g.id === input.goalId)!;
    if (goal.curatorId && goal.curatorId !== session.curatorId && goal.curatorId !== session.name) throw new ActionError('Подтверждение доступно назначенному куратору этой цели', 403);
    for (const evidenceId of input.evidenceIds) {
      const evidence = context.db.get<{ curatorId?: string }>('evidence', evidenceId);
      if (!evidence) throw new ActionError('Приложенный артефакт не найден', 400);
      if (evidence.curatorId && evidence.curatorId !== session.curatorId) throw new ActionError('Добавьте файл из своей кураторской сессии.', 403);
    }
    try { validateAchievement(evaluation, input.comment ?? null, input.evidenceIds); } catch (error) { throw new ActionError((error as Error).message); }
    const attestation = { id: randomUUID(), goalId: goal.id, leaderId: input.leaderId ?? null, fingerprint: evaluation.fingerprint, period: evaluation.period, curatorId: session.curatorId, curatorName: session.name, confirmedAt: new Date().toISOString(), comment: input.comment?.trim() ?? null, evidenceIds: input.evidenceIds, invalidatedAt: null };
    context.db.set('attestations', attestation.id, attestation);
    context.catalogs.recordChange(session, 'achievement_confirmed', goal.id, goal.title, {}, { comment: attestation.comment, period: evaluation.period });
    return { attestation };
  });
  app.post<{ Params: { id: string } }>('/api/snapshots/:id/validate', async request => {
    const session = await curator(request); const snapshot = context.db.get<LocalSnapshot>('snapshots', request.params.id);
    if (!snapshot) throw new ActionError('Снимок не найден', 404);
    const validated: LocalSnapshot = { ...snapshot, status: 'validated', curatorId: session.curatorId, curatorName: session.name, validatedAt: new Date().toISOString() };
    context.db.set('snapshots', snapshot.id, validated);
    context.catalogs.recordChange(session, 'snapshot_validated', snapshot.id, 'Снимок проверен УОР', {}, { sourceId: snapshot.sourceId, period: snapshot.period }); return { snapshot: validated };
  });
  app.post('/api/manual', async request => {
    const session = await curator(request);
    const input = z.object({ goalId: z.string(), leaderId: z.string().nullable().optional(), participantName: z.string().optional(), value: z.number().finite(), target: z.number().finite().nullable().optional(), period: z.iso.date(), comment: z.string().max(10000).optional() }).parse(request.body);
    const catalog = await context.catalogs.readForSession(session); const goal = catalog.goals.find(g => g.id === input.goalId);
    if (!goal) throw new ActionError('Цель не найдена', 404);
    if (input.leaderId && (!catalog.leaders.some(l => l.id === input.leaderId) || !catalog.assignments.some(a => a.goalId === goal.id && a.leaderId === input.leaderId && a.active !== false))) throw new ActionError('ИТ-лидер не назначен на эту цель');
    const sourceId = `manual-${goal.id}`; const now = new Date().toISOString();
    if (!catalog.sources.some(s => s.id === sourceId)) {
      const source = { id: sourceId, name: `Данные куратора: ${goal.title}`, kind: 'manual' as const, url: null, accessUrl: null, goalIds: [goal.id], freshnessHours: 168, mode: 'local' as const };
      const base = await context.catalogs.read(); base.sources.push(source); context.db.set('catalog', 'active', base);
      await context.catalogs.saveDraft(session, { kind: 'source', id: sourceId, baseRevision: null, patch: { ...source } });
    }
    const observation: Observation = { id: randomUUID(), goalId: goal.id, leaderId: input.leaderId ?? null, participantId: input.leaderId ?? 'manual-global', participantName: input.participantName ?? (input.leaderId ? catalog.leaders.find(l => l.id === input.leaderId)?.name ?? session.name : 'ДИТ'), metricId: goal.id, metricName: goal.title, value: input.value, target: input.target ?? goal.officialTarget, unit: goal.unit, state: 'numeric', reason: null, period: input.period, sourceId, sourceUpdatedAt: now, downloadedAt: now };
    const snapshot: LocalSnapshot = { id: randomUUID(), classification: catalog.classification, sourceId, period: input.period, observations: [observation], collectedAt: now, sourceUpdatedAt: now, origin: 'manual', dataHash: createHash('sha256').update(JSON.stringify(observation)).digest('hex'), status: 'personal', curatorId: session.curatorId, curatorName: session.name, validatedAt: null, limitations: ['Факт внесён куратором вручную' + (input.comment ? `: ${input.comment}` : '')], evidenceIds: [], evaluationBasis:captureEvaluationBasis(catalog,goal.id) };
    const accepted = await context.writeSnapshot(snapshot, { mergeManual: true });
    context.catalogs.recordChange(session, 'manual_fact_added', goal.id, goal.title, {}, { value: input.value, period: input.period, author: session.name });
    await context.state(session); return { snapshot: accepted };
  });
  app.post<{ Params: { id: string } }>('/api/sources/:id', async request => {
    const session = await curator(request); const catalog = await context.catalogs.readForSession(session);
    const source = catalog.sources.find(s => s.id === request.params.id); if (!source) throw new ActionError('Источник не найден', 404);
    const patch = z.object({ name: z.string().trim().min(1).max(500).optional(), kind: z.enum(['dashboard', 'attachment', 'manual', 'file', 'demo']).optional(), url: z.string().url().refine(s => /^https?:\/\//.test(s)).nullable().optional(), accessUrl: z.string().url().refine(s => /^https?:\/\//.test(s)).nullable().optional(), freshnessHours: z.number().min(1).max(87600).optional() }).parse(request.body);
    const draft = await context.catalogs.saveDraft(session, { kind: 'source', id: source.id, baseRevision: null, patch });
    context.catalogs.recordChange(session, 'source_updated', source.id, source.name, { ...source }, patch); return { draft };
  });
  const entityHandler = async (request: { params?: unknown; body: unknown; cookies: Record<string, string | undefined> }) => {
    const session = await curator(request); const catalog = await context.catalogs.readForSession(session);
    const input = z.object({ name: z.string().trim().min(1).max(500), type: z.string().min(1).max(100), leaderId: z.string().nullable().optional(), productId: z.string().nullable().optional(), aliases: z.array(z.string()).optional() }).parse(request.body);
    if (input.leaderId && !catalog.leaders.some(l => l.id === input.leaderId)) throw new ActionError('ИТ-лидер не найден');
    if (input.productId && !catalog.entities.some(e => e.id === input.productId && e.type === 'product')) throw new ActionError('Продукт не найден в базе знаний');
    const id = (request.params as { id?: string } | undefined)?.id ?? randomUUID(); const original = catalog.entities.find(e => e.id === id);
    if (original && isKnowledgeType(original.type)) throw new ActionError('Изменяйте запись в разделе «База знаний»: он проверяет версию, связи и сохраняет прежние имена.', 400);
    if (['decision', 'report_profile', 'article', 'work_package', 'execution_config', 'execution_journal', 'weekly_brief', 'report_template'].includes(input.type) || (original && (['decision', 'report_profile', 'article'].includes(original.type) || original.revision || original.body || original.archivedAt)) || ['description', 'body', 'links', 'goalIds', 'revision', 'archivedAt'].some(field => Object.hasOwn(request.body as object, field))) throw new ActionError('Используйте соответствующий раздел базы знаний, решений или профилей отчёта. Черновик с проверкой версии защищает изменения коллег.', 400);
    const draft = await context.catalogs.saveDraft(session, { kind: 'entity', id, baseRevision: null, patch: { id, ...input } });
    context.catalogs.recordChange(session, original ? 'entity_updated' : 'entity_added', id, input.name, { ...original }, input); return { draft };
  };
  app.post('/api/entities', entityHandler); app.post('/api/entities/:id', entityHandler); app.patch('/api/entities/:id', entityHandler);
  app.post('/api/import/map', async request => {
    const session = await curator(request); const input = z.object({ html: z.string().max(20_000_000) }).parse(request.body);
    const catalog = normalizeDirections(importGoalMap(input.html, { classification: 'corporate' }));
    const backup = await context.catalogs.read(); context.db.set('catalog-backups', randomUUID(), backup); context.db.set('catalog', 'active', catalog);
    context.catalogs.recordChange(session, 'catalog_imported', catalog.id, catalog.name, {}, { goals: catalog.goals.length, leaders: catalog.leaders.length }); return { goals: catalog.goals.length, leaders: catalog.leaders.length };
  });
  app.post('/api/evidence', async request => {
    const session = await curator(request);
    const input = z.object({ name: z.string().trim().min(1).max(200).refine(value=>!/[\x00-\x1f\x7f/\\]/.test(value),'Недопустимое имя файла'), base64: z.string().min(1).max(7_000_000).regex(/^[A-Za-z0-9+/]+={0,2}$/) }).parse(request.body);
    const bytes = Buffer.from(input.base64, 'base64'); if (!bytes.length || input.base64.length % 4) throw new ActionError('Не удалось прочитать файл доказательства');
    if (bytes.length > 5_000_000) throw new ActionError('Артефакт превышает 5 МБ');
    const id = randomUUID(); const destination = await safeArtifactPath(context.paths.runtimeRoot, `evidence/${id}`); await writeFile(destination, bytes);
    const evidence = { id, name: input.name, relativePath: `evidence/${id}`, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, curatorId: session.curatorId, ownerInstallationId:context.installationId,classification:(await context.catalogs.readForSession(session)).classification,uploadedBy:session.name,uploadedAt:new Date().toISOString() };
    context.db.set('evidence', id, evidence); return { evidence };
  });
  app.post('/api/updates/check', async (request,reply) => { const session=await sessionFor(request,reply);const operation = await context.operations.start('check', 'Проверка обновлений');context.db.set('operation-owners',operation.id,session.id);void context.trackBackground(checkRemoteUpdates(context, operation.id)); return { operationId: operation.id }; });
  app.post('/api/publish', async request => {
    const session = await curator(request); const ids=z.array(z.string().min(1).max(300)).max(20000).optional();const input = z.object({ draftIds:ids.default([]),snapshotIds:ids.default([]),attestationIds:ids.default([]),evidenceIds:ids.default([]),templateIds:ids.default([]),previewId:z.string().uuid() }).strict().parse(request.body ?? {});
    const operation = await context.operations.start('publish', 'Отправка в готовящийся выпуск');const {draftIds,...selection}=input;void context.trackBackground(publishChanges(context, session, operation.id, draftIds,Object.keys(selection).length?selection:undefined)); return { operationId: operation.id };
  });
  app.post('/api/update', async (request, reply) => {
    const selection = z.object({ syncPublished: z.boolean(), sourceIds: z.array(z.string()).default([]), recalculate: z.boolean().default(true) }).parse(request.body);
    const session = await sessionFor(request, reply);
    const { planUpdate } = await import('../features/sources/update-planner'); const { runUpdate } = await import('../features/sources/update-runner');
    const plan = planUpdate(selection, await context.catalogs.readForSession(session));
    const operation = await context.operations.start('update', 'Обновление выбранных данных'); context.db.set('operation-owners',operation.id,session.id); const controller = new AbortController(); context.cancelled.set(operation.id, controller);
    void context.trackBackground(runUpdate(plan, { operations: context.operations, startOperation: operation, signal: controller.signal,
      syncPublished: () => syncPublished(context), collectSource: async (id: string, signal: AbortSignal) => {
        await collectConfiguredSource(context,session,id,signal,stage=>{void context.operations.stage(operation.id,stage);});
      }, recalculate: async () => { await context.state(session); }
    }).catch(async error => { await context.operations.finish(operation.id, { status: 'failed', message: (error as Error).message }); }).finally(() => context.cancelled.delete(operation.id)));
    return { operationId: operation.id };
  });
  app.post<{ Params: { id: string } }>('/api/operations/:id/cancel', async request => {
    const actor=context.roles.get(request.cookies.uor_session),owner=context.db.get<string>('operation-owners',request.params.id);
    if(!actor||(owner?owner!==actor.id:actor.role!=='curator'))throw new ActionError('Можно отменить только свою операцию',403);
    context.cancelled.get(request.params.id)?.abort(); return { cancelled: true };
  });
  app.get<{ Params: { id: string } }>('/api/operations/:id/events', async (request, reply) => {
    const session=await sessionFor(request,reply),owner=context.db.get<string>('operation-owners',request.params.id);
    if(session.role!=='curator'&&owner!==session.id)throw new ActionError('Можно просматривать только свои операции',403);
    const operation = await context.operations.get(request.params.id);
    const last = Number(request.headers['last-event-id'] ?? 0);
    reply.header('content-type', 'text/event-stream').header('cache-control', 'no-cache');
    return operation.events.filter(e => e.id > last).map(e => `id: ${e.id}\nevent: stage\ndata: ${JSON.stringify(e)}\n\n`).join('');
  });
  if (options.startupCheck !== false && context.config.repositoryUrl){const timer=setTimeout(()=>{if(!context.maintenance)void context.trackBackground(checkRemoteUpdates(context));},1000);timer.unref();app.addHook('preClose',async()=>clearTimeout(timer));}
  return app;
}
