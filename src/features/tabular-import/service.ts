import { captureEvaluationBasis } from '../reporting/evaluation-basis';
import { createHash, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { z } from 'zod';
import type { Assignment, CatalogSnapshot, CuratorSession, Draft, Goal, LocalSnapshot, Observation, SourceDefinition } from '../../domain/contracts';
import type { ApplicationContext } from '../../server/workspace/context';
import { safeArtifactPath } from '../../server/workspace/paths';
import { ActionError } from '../identity/role-service';
import { evaluateGoal } from '../evaluation/evaluate';
import { canonicalJson } from '../publishing/merge-object';
import { validateCatalog, validateSnapshot } from '../publishing/validate-version';
import { parseTable } from './parser';
import type { ColumnRole, ImportOption, TabularFileInput, TabularImportProfile, TabularIssue, TabularPreview, TabularPreviewInput, TabularProbe, TabularResult } from './contracts';

const id = z.string().trim().min(1).max(500), mapping = z.record(id, id);
const fileSchema = z.object({ name: z.string().min(1).max(250).refine(v => !/[\x00-\x1f]/.test(v)), base64: z.string().min(1).max(14_000_000), goalId: id, sourceId: id.nullable().optional() });
const profileSchema = z.object({ parser: z.literal('tabular-v1'), columns: z.object({ period: id.optional(), leader: id.optional(), participant: id.optional(), metric: id.optional(), value: id, target: id.optional(), state: id.optional(), reason: id.optional(), sourceUpdatedAt: id.optional() }).strict(), leaderMapping: mapping, participantMapping: mapping, metricMapping: mapping,
  defaults: z.object({ period: z.iso.date(), leaderId: id.nullable().optional(), participantId: id.optional(), metricId: id.optional() }).strict() }).strict();
const previewSchema = fileSchema.extend({ profile: profileSchema, sourceUpdatedAt: z.iso.datetime({ offset: true }).nullable().optional() });
const digest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const normalize = (value: string) => value.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase('ru');
const requireCurator = (session: CuratorSession) => { if (session.role !== 'curator' || !session.curatorId) throw new ActionError('Загрузка доступна куратору УОР', 403); };
function catalogSignature(context: ApplicationContext, session: CuratorSession) {
  return digest({ catalog: context.db.get('catalog', 'active'), drafts: context.db.list<Draft>('drafts').filter(d => d.status === 'published' || d.curatorId === session.curatorId).sort((a, b) => a.id.localeCompare(b.id)) });
}
function sourceSnapshots(context: ApplicationContext, sourceId: string, classification: CatalogSnapshot['classification']) {
  return context.db.list<LocalSnapshot>('snapshots').filter(s => s.sourceId === sourceId && s.classification === classification);
}
export function tabularFactsHash(rows: Observation[]) {
  return digest(rows.map(({ goalId, leaderId, participantId, metricId, value, target, unit, state, reason, period, sourceId, sourceUpdatedAt }) => canonicalJson({ goalId, leaderId, participantId, metricId, value, target, unit, state, reason, period, sourceId, sourceUpdatedAt })).sort());
}
function baselineSignature(context: ApplicationContext, source: SourceDefinition, classification: CatalogSnapshot['classification']) {
  return digest(sourceSnapshots(context, source.id, classification).map(s => ({ id: s.id, at: s.collectedAt, facts: tabularFactsHash(s.observations) })).sort((a, b) => a.id.localeCompare(b.id)));
}
function latest(context: ApplicationContext, source: SourceDefinition, catalog: CatalogSnapshot, goalId: string, period: string) {
  return sourceSnapshots(context, source.id, catalog.classification).filter(s => s.period === period && s.observations.some(r => r.goalId === goalId)).sort((a, b) => b.collectedAt.localeCompare(a.collectedAt) || b.id.localeCompare(a.id))[0];
}
function selectSource(catalog: CatalogSnapshot, goal: Goal, requested?: string | null): SourceDefinition {
  const existing = catalog.sources.filter(s => s.goalIds.includes(goal.id) && ['file', 'manual', 'attachment', 'dashboard'].includes(s.kind));
  if (requested) { const source = existing.find(s => s.id === requested); if (!source) throw new ActionError('Выберите файловый источник этой цели'); return structuredClone(source); }
  if (existing.length > 1) throw new ActionError('У цели несколько источников. Выберите источник явно');
  if (existing.length) return structuredClone(existing[0]);
  return { id: `tabular-${digest(goal.id).slice(0, 20)}`, name: `Табличные данные · ${goal.title}`, kind: 'file', goalIds: [goal.id], url: null, accessUrl: null, mode: 'local', freshnessHours: 168 };
}
function metricOptions(context: ApplicationContext, catalog: CatalogSnapshot, goal: Goal) {
  if (goal.measurement) return goal.measurement.metrics.map(m => ({ ...m }));
  const prior = context.db.list<LocalSnapshot>('snapshots').filter(s => s.classification === catalog.classification).flatMap(s => s.observations).filter(r => r.goalId === goal.id);
  return (goal.requiredMetricIds?.length ? goal.requiredMetricIds : [goal.id]).map(id => ({ id, name: prior.find(r => r.metricId === id)?.metricName ?? (id === goal.id ? goal.metric || goal.title : id), unit: goal.unit, target: id === goal.id ? goal.officialTarget : prior.find(r => r.metricId === id)?.target ?? null, direction: goal.direction }));
}
function participants(catalog: CatalogSnapshot, assignments: Assignment[]) {
  const ids = new Set(assignments.flatMap(a => a.participantIds ?? []));
  const entities = catalog.entities.filter(e => ids.has(e.id) && assignments.some(a => a.participantIds?.includes(e.id) && (!e.leaderId || e.leaderId === a.leaderId)));
  // Goal setup can explicitly select the responsible leader as the measured participant.
  // This identity is declared in the assignment; it is never inferred from imported rows.
  const leaders = catalog.leaders.filter(leader => assignments.some(a => a.leaderId === leader.id && a.participantIds?.includes(leader.id)));
  return [...entities.map(e => ({ id: e.id, name: e.name })), ...leaders.filter(leader => !entities.some(e => e.id === leader.id)).map(leader => ({ id: leader.id, name: leader.name }))];
}
async function prepare(context: ApplicationContext, session: CuratorSession, raw: TabularFileInput) {
  requireCurator(session); const input = fileSchema.parse(raw);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(input.base64) || input.base64.length % 4) throw new ActionError('Не удалось прочитать содержимое файла');
  const bytes = Buffer.from(input.base64, 'base64'), signature = catalogSignature(context, session), catalog = await context.catalogs.readForSession(session);
  if (signature !== catalogSignature(context, session)) throw new ActionError('Настройки изменились. Повторите проверку', 409);
  const goal = catalog.goals.find(g => g.id === input.goalId); if (!goal) throw new ActionError('Цель не найдена', 404);
  if (!goal.measurement && (goal.requiredMetricIds?.length || catalog.sources.some(s => s.goalIds.includes(goal.id) && s.importProfile?.parser === 'maturity-xlsx-v1'))) throw new ActionError('Для модели зрелости используйте специализированную загрузку XLSX');
  const source = selectSource(catalog, goal, input.sourceId);
  let table; try { table = await parseTable(input.name, bytes); } catch (error) { throw new ActionError((error as Error).message); }
  const assignments = catalog.assignments.filter(a => a.goalId === goal.id && a.active !== false), metrics = metricOptions(context, catalog, goal);
  const global = goal.scopeType === 'global' && !assignments.length;
  const options = { leaders: catalog.leaders.filter(l => assignments.some(a => a.leaderId === l.id)).map(l => ({ id: l.id, name: l.name })), participants: global ? [{ id: 'global-dit', name: 'ДИТ в целом' }] : participants(catalog, assignments).map(e => ({ id: e.id, name: e.name })), metrics: metrics.map(m => ({ id: m.id, name: m.name })) };
  return { input, bytes, signature, catalog, goal, source, table, assignments, metrics, options, global };
}
export async function probeTabularImport(context: ApplicationContext, session: CuratorSession, raw: TabularFileInput): Promise<TabularProbe> {
  const p = await prepare(context, session, raw);
  const profile: TabularImportProfile = structuredClone(p.source.importProfile?.parser === 'tabular-v1' ? p.source.importProfile : { parser: 'tabular-v1', columns: { value: '' }, defaults: { period: '', ...(p.metrics.length === 1 ? { metricId: p.metrics[0].id } : {}) }, leaderMapping: {}, participantMapping: {}, metricMapping: {} });
  if (p.global) profile.defaults = { ...profile.defaults, participantId: 'global-dit', leaderId: null };
  const columnValues = Object.fromEntries(p.table.columns.map((column, index) => [column, [...new Set(p.table.rows.map(row => row.cells[index].trim()).filter(Boolean))].sort()]));
  return { columns: p.table.columns, rows: p.table.rows.slice(0, 15), columnValues, sourceId: p.source.id, profile, options: p.options };
}
function resolve(raw: string, explicit: Record<string, string>, options: ImportOption[]): string | null {
  const mapped = Object.hasOwn(explicit, raw) ? explicit[raw] : undefined;
  const matches = mapped !== undefined ? options.filter(o => o.id === mapped) : options.filter(o => [o.id, o.name].some(v => normalize(v) === normalize(raw)));
  return matches.length === 1 ? matches[0].id : null;
}
function number(raw: string): number | null {
  if (!raw.trim()) return null;
  if (!/^[+-]?\d+(?:[.,]\d+)?\s*%?$/.test(raw.trim())) throw new Error('Ожидается число без разделителей тысяч');
  const value = Number(raw.trim().replace('%', '').replace(',', '.').trim()); if (!Number.isFinite(value)) throw new Error('Число вне допустимого диапазона'); return value;
}
interface StoredPreview { preview: TabularPreview; curatorId: string; catalogSignature: string; baselineSignature: string; catalog: CatalogSnapshot; source: SourceDefinition; observations: Observation[]; basis: NonNullable<LocalSnapshot['evaluationBasis']>; artifact: { relativePath: string; fileHash: string; size: number; name: string }; result?: TabularResult }
export async function previewTabularImport(context: ApplicationContext, session: CuratorSession, raw: TabularPreviewInput): Promise<TabularPreview> {
  requireCurator(session); const input = previewSchema.parse(raw), p = await prepare(context, session, input), profile = input.profile;
  const issues: TabularIssue[] = [], observations: Observation[] = [], periods = new Set<string>(), keyed = new Map<string, Observation>();
  const issue = (code: string, message: string, rowNumber?: number, severity: 'error' | 'warning' = 'error') => issues.push({ code, message, rowNumber, severity });
  if (p.source.kind === 'dashboard') issue('manual_dashboard_export', 'Ручная выгрузка дашборда. Автоматический сбор не выполнялся', undefined, 'warning');
  if (!p.assignments.length && !p.global) issue('no_assignments', 'Сначала назначьте ответственных по цели');
  if (p.global && (profile.columns.leader || typeof profile.defaults.leaderId === 'string')) issue('global_scope', 'Общий результат ДИТ не смешивается с результатами ИТ-лидеров');
  const dimensional = !!p.goal.measurement;
  if (dimensional && p.assignments.some(a => !a.participantIds?.length)) issue('unknown_scope', 'Явно задайте расчётных участников во всех активных назначениях. Состав из файла не используется как ожидаемый.');
  for (const [role, column] of Object.entries(profile.columns)) if (!p.table.columns.includes(column)) issue('unknown_column', `Колонка «${column}» для поля «${role}» отсутствует в файле`);
  if (new Set(Object.values(profile.columns)).size !== Object.values(profile.columns).length) issue('reused_column', 'Выберите отдельную колонку для каждого поля');
  const baselineAtPreview = baselineSignature(context, p.source, p.catalog.classification), downloadedAt = new Date().toISOString();
  for (const row of p.table.rows) {
    const read = (role: ColumnRole) => { const column = profile.columns[role]; return column ? (row.cells[p.table.columns.indexOf(column)] ?? '').trim() : ''; };
    const period = read('period') || profile.defaults.period;
    if (!z.iso.date().safeParse(period).success) { issue('invalid_period', 'Период должен быть датой YYYY-MM-DD', row.rowNumber); continue; } periods.add(period);
    let leaderId: string | null = null;
    if (profile.columns.leader) { leaderId = resolve(read('leader'), profile.leaderMapping, p.options.leaders); if (!leaderId) { issue('leader_mapping', `Неизвестный или неоднозначный ИТ-лидер «${read('leader')}». Задайте соответствие`, row.rowNumber); continue; } }
    else if (typeof profile.defaults.leaderId === 'string') { leaderId = profile.defaults.leaderId; if (!p.options.leaders.some(o => o.id === leaderId)) { issue('leader_mapping', 'Ответственный не назначен этой цели', row.rowNumber); continue; } }
    let participantId: string;
    if (p.global) {
      participantId = profile.columns.participant ? resolve(read('participant'), profile.participantMapping, p.options.participants) ?? '' : profile.defaults.participantId ?? 'global-dit';
      if (participantId !== 'global-dit') { issue('participant_scope', 'Для общей цели используйте область «ДИТ в целом»', row.rowNumber); continue; }
      leaderId = null;
    } else if (dimensional || profile.columns.participant) {
      participantId = profile.columns.participant ? resolve(read('participant'), profile.participantMapping, p.options.participants) ?? '' : profile.defaults.participantId ?? '';
      if (!participantId || !p.options.participants.some(o => o.id === participantId)) { issue('participant_mapping', `Участник «${read('participant') || participantId}» не сопоставлен с выбранным составом`, row.rowNumber); continue; }
      const owners = [...new Set(p.assignments.filter(a => a.participantIds?.includes(participantId) && (!leaderId || a.leaderId === leaderId)).map(a => a.leaderId))];
      if (owners.length !== 1) { issue('participant_scope', 'У участника нет единственного ответственного в назначениях цели', row.rowNumber); continue; } leaderId = owners[0];
    } else {
      if (!profile.columns.leader && !Object.hasOwn(profile.defaults, 'leaderId')) { issue('scalar_scope', 'Явно выберите общий показатель или ответственного ИТ-лидера', row.rowNumber); continue; }
      participantId = leaderId ? `scalar-${leaderId}` : 'scalar-global';
    }
    const metricId = profile.columns.metric ? resolve(read('metric'), profile.metricMapping, p.options.metrics) : profile.defaults.metricId;
    const metric = p.metrics.find(m => m.id === metricId); if (!metric) { issue('metric_mapping', `Неизвестный или неоднозначный показатель «${read('metric') || metricId || ''}»`, row.rowNumber); continue; }
    let sourceUpdatedAt: string | null = read('sourceUpdatedAt') || input.sourceUpdatedAt || null;
    if (sourceUpdatedAt && !z.iso.datetime({ offset: true }).safeParse(sourceUpdatedAt).success) { issue('invalid_source_date', 'Дата обновления должна содержать часовой пояс: YYYY-MM-DDTHH:mm:ssZ', row.rowNumber); continue; }
    const states: Record<string, Observation['state']> = { numeric: 'numeric', число: 'numeric', missing: 'missing', 'нет данных': 'missing', exception: 'exception', исключение: 'exception', no_events: 'no_events', 'нет событий': 'no_events' };
    const stateText = normalize(read('state')), state = stateText ? states[stateText] : read('value') ? 'numeric' : 'missing';
    if (!state) { issue('unknown_state', `Неизвестное состояние «${read('state')}». Используйте numeric, missing, exception, no_events`, row.rowNumber); continue; }
    const reason = read('reason') || null;
    if (state !== 'numeric' && !reason) issue('missing_reason', 'Добавьте причину отсутствия данных, исключения или отсутствия событий', row.rowNumber);
    let value: number | null = null, target: number | null = null;
    try { value = state === 'numeric' ? number(read('value')) : null; target = profile.columns.target ? number(read('target')) : metric.target; }
    catch (error) { issue('invalid_number', (error as Error).message, row.rowNumber); continue; }
    if (state === 'numeric' && value === null) issue('missing_numeric', 'У числового факта отсутствует значение', row.rowNumber);
    if (p.goal.measurement && target !== metric.target) issue('threshold_mismatch', 'Порог в файле отличается от методики цели. Измените методику отдельно', row.rowNumber);
    if (['binary', 'milestones'].includes(p.goal.measurement?.kind ?? '') && state === 'numeric' && value !== 0 && value !== 1) issue('invalid_binary', 'Для этой методики допустимы только 0 и 1', row.rowNumber);
    const observation: Observation = { id: randomUUID(), goalId: p.goal.id, leaderId, participantId, participantName: p.options.participants.find(o => o.id === participantId)?.name ?? (leaderId ? p.options.leaders.find(o => o.id === leaderId)?.name ?? leaderId : 'Общий показатель'), metricId: metric.id, metricName: metric.name, value, target, unit: metric.unit, state, reason, period, sourceId: p.source.id, sourceUpdatedAt, downloadedAt };
    const key = canonicalJson([leaderId, participantId, metricId, period]), previous = keyed.get(key);
    if (previous) { const same = tabularFactsHash([previous]) === tabularFactsHash([observation]); issue(same ? 'identical_duplicate' : 'conflicting_duplicate', same ? 'Идентичный повтор учтён один раз' : 'Противоречивые значения одного участника и показателя', row.rowNumber, same ? 'warning' : 'error'); }
    else { keyed.set(key, observation); observations.push(observation); }
  }
  if (periods.size > 1) issue('multiple_periods', 'Один импорт должен содержать один период. Разделите файл');
  if (!observations.length) issue('no_facts', 'Нет полностью сопоставленных фактов');
  const period = [...periods][0] ?? profile.defaults.period;
  // Scope is always declared by assignments. File presence can never declare completeness.
  const evaluate = (leaderId: string | null) => {
    const assignments = p.assignments.filter(a => leaderId === null || a.leaderId === leaderId);
    const rows = observations.filter(o => leaderId === null || o.leaderId === leaderId);
    const expectedParticipants = p.global && dimensional ? ['global-dit'] : dimensional ? [...new Set(assignments.flatMap(a => a.participantIds ?? []))] : undefined;
    const evaluation = evaluateGoal({ goal: p.goal, observations: rows, period, leaderId, expectedParticipants, expectedMetricIds: dimensional ? p.metrics.map(m => m.id) : undefined, scopeRevision: canonicalJson(assignments) });
    if (!dimensional && new Set(observations.map(o => o.leaderId)).size > 1) { evaluation.official = 'unknown'; evaluation.internal = 'unknown'; evaluation.validation = 'not_required'; evaluation.qualityFlags.push('multiple_scalar_scopes'); }
    return evaluation;
  };
  const evaluations = [evaluate(null), ...p.options.leaders.map(l => evaluate(l.id))];
  if (!dimensional && observations.some(o => o.leaderId === null) && observations.some(o => o.leaderId !== null)) issue('mixed_scalar_scope', 'Общий показатель нельзя смешивать с показателями ИТ-лидеров');
  if (evaluations[0].missing) issue('missing_expected_facts', `Не хватает ожидаемых фактов: ${evaluations[0].missing}. Неполнота не означает выполнение`, undefined, 'warning');
  if (observations.some(o => !o.sourceUpdatedAt)) issue('source_date_unknown', 'Дата обновления источника неизвестна; время загрузки не заменяет её', undefined, 'warning');
  const baseline = latest(context, p.source, p.catalog, p.goal.id, period), previewId = randomUUID();
  const preview: TabularPreview = { id: previewId, sourceId: p.source.id, period, expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(), canCommit: !issues.some(i => i.severity === 'error'), duplicateSnapshotId: baseline && tabularFactsHash(baseline.observations.filter(o => o.goalId === p.goal.id)) === tabularFactsHash(observations) ? baseline.id : null, issues, sample: observations.slice(0, 30), evaluations, rows: p.table.rows.length, facts: observations.length };
  p.source.importProfile = structuredClone(profile);
  const artifact = { relativePath: `source-artifacts/tabular-${previewId}${/\.csv$/i.test(input.name) ? '.csv' : '.xlsx'}`, fileHash: createHash('sha256').update(p.bytes).digest('hex'), size: p.bytes.length, name: input.name.split(/[\\/]/).pop()! };
  await writeFile(await safeArtifactPath(context.paths.runtimeRoot, artifact.relativePath), p.bytes, { flag: 'wx' });
  const record: StoredPreview = { preview, curatorId: session.curatorId, catalogSignature: p.signature, baselineSignature: baselineAtPreview, catalog: p.catalog, source: p.source, observations, basis: captureEvaluationBasis(p.catalog,p.goal.id), artifact };
  context.db.set('tabular-previews', preview.id, record); return preview;
}

export async function commitTabularImport(context: ApplicationContext, session: CuratorSession, previewId: string): Promise<TabularResult> {
  requireCurator(session); const record = context.db.get<StoredPreview>('tabular-previews', previewId);
  if (!record) throw new ActionError('Предпросмотр не найден. Повторите проверку', 404);
  if (record.curatorId !== session.curatorId) throw new ActionError('Предпросмотр принадлежит другому куратору', 403);
  if (record.result) return record.result;
  if (Date.parse(record.preview.expiresAt) <= Date.now()) throw new ActionError('Предпросмотр устарел. Повторите проверку', 410);
  if (!record.preview.canCommit) throw new ActionError('Сначала устраните ошибки предпросмотра');
  const operation = await context.operations.start('import', 'Сохранение табличных фактов');
  try {
    const result = context.db.transaction(() => {
      // Reload inside the transaction to preserve idempotency even across two in-flight commits.
      const stored = context.db.get<StoredPreview>('tabular-previews', previewId)!; if (stored.result) return stored.result;
      if (record.catalogSignature !== catalogSignature(context, session)) throw new ActionError('Цель, состав или профиль изменились. Повторите предпросмотр', 409);
      const active = context.db.get<CatalogSnapshot>('catalog', 'active')!;
      if (record.baselineSignature !== baselineSignature(context, record.source, active.classification)) throw new ActionError('Факты источника изменились. Повторите предпросмотр', 409);
      const baseline = latest(context, record.source, active, record.basis.goal.id, record.preview.period), duplicate = !!baseline && tabularFactsHash(baseline.observations.filter(o => o.goalId === record.basis.goal.id)) === tabularFactsHash(record.observations);
      const candidate = structuredClone(record.catalog), source = candidate.sources.find(s => s.id === record.source.id);
      if (source) source.importProfile = record.source.importProfile; else candidate.sources.push(record.source);
      validateCatalog(candidate);
      const existing = context.db.list<Draft>('drafts').find(d => d.curatorId === session.curatorId && d.status === 'local' && d.change.kind === 'source' && d.change.id === record.source.id);
      const original = active.sources.find(s => s.id === record.source.id), patch = original ? { importProfile: record.source.importProfile } : { ...record.source };
      const draft: Draft = { id: existing?.id ?? randomUUID(), curatorId: session.curatorId, change: { kind: 'source', id: record.source.id, baseRevision: null, patch: { ...existing?.change.patch, ...patch } }, base: existing ? existing.base : original ? { ...original } : null, createdAt: new Date().toISOString(), status: 'local', error: null };
      const newest = Math.max(0, ...sourceSnapshots(context, record.source.id, active.classification).map(s => Date.parse(s.collectedAt)).filter(Number.isFinite));
      const collectedAt = new Date(Math.max(Date.now(), newest + 1)).toISOString();
      const dates = record.observations.map(o => o.sourceUpdatedAt), sourceUpdatedAt = dates.every(Boolean) ? (dates as string[]).sort()[0] : null;
      const snapshot: LocalSnapshot = { id: randomUUID(), classification: active.classification, sourceId: record.source.id, period: record.preview.period, observations: record.observations.map(o => ({ ...o, downloadedAt: collectedAt })), collectedAt, sourceUpdatedAt, origin: 'file', dataHash: tabularFactsHash(record.observations), status: 'personal', curatorId: session.curatorId, curatorName: session.name, validatedAt: null, limitations: record.preview.issues.filter(i => i.severity === 'warning').map(i => i.message), evidenceIds: [], evaluationBasis: record.basis };
      if (!duplicate) validateSnapshot(snapshot, candidate);
      // Keep unpublished source/profile changes in this curator's drafts, including for a new draft goal.
      context.db.set('drafts', draft.id, draft); if (!duplicate) context.db.set('snapshots', snapshot.id, snapshot);
      const result: TabularResult = { snapshotId: duplicate ? baseline!.id : snapshot.id, duplicate, operationId: operation.id };
      context.db.set('tabular-previews', previewId, { ...record, result }); context.db.set('import-artifacts', previewId, { previewId, snapshotId: result.snapshotId, ...record.artifact });
      context.catalogs.recordChange(session, duplicate ? 'snapshot_import_duplicate' : 'snapshot_imported', result.snapshotId, record.basis.goal.title, {}, { sourceId: record.source.id, period: record.preview.period, facts: record.observations.length, duplicate }, operation.id);
      return result;
    });
    try { await context.state(session); await context.operations.finish(operation.id, { status: 'completed', message: result.duplicate ? 'Идентичный срез уже сохранён' : 'Личный срез сохранён' }); }
    catch (error) { await context.operations.finish(operation.id, { status: 'partial', message: 'Срез сохранён; обновите данные для пересчёта', details: [(error as Error).message] }); }
    return result;
  } catch (error) { await context.operations.finish(operation.id, { status: 'failed', message: (error as Error).message }); throw error; }
}
