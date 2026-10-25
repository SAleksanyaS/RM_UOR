import { createHash, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { z } from 'zod';
import type { Assignment, CatalogSnapshot, CuratorSession, Draft, KnowledgeEntity, LocalSnapshot, Observation, SourceDefinition } from '../../domain/contracts';
import type { ApplicationContext } from '../../server/workspace/context';
import { safeArtifactPath } from '../../server/workspace/paths';
import { ActionError } from '../identity/role-service';
import { evaluateGoal } from '../evaluation/evaluate';
import { canonicalJson } from '../publishing/merge-object';
import { validateCatalog, validateSnapshot } from '../publishing/validate-version';
import { parseMaturityWorkbook } from './maturity-parser';
import type { ImportIssue, ImportMatch, MaturityImportInput, MaturityImportPreview, MaturityImportResult, ParsedMaturityRow } from './import-contracts';

const MAX_BYTES = 10 * 1024 * 1024, TTL_MS = 30 * 60_000;
const normalize = (value: string) => value.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase('ru');
const digest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const inputSchema = z.object({ name: z.string().min(1).max(250), base64: z.string().min(1).max(Math.ceil(MAX_BYTES / 3) * 4 + 4),
  goalId: z.string().min(1).max(500), sourceId: z.string().min(1).max(500).nullable().optional(), period: z.iso.date(),
  sourceUpdatedAt: z.iso.datetime({ offset: true }).nullable().optional(),
  teamMapping: z.record(z.string().min(1).max(500), z.string().min(1).max(500)).optional(),
  metricMapping: z.record(z.string().min(1).max(500), z.string().min(1).max(500)).optional() });
interface StoredPreview {
  preview: MaturityImportPreview; curatorId: string; catalogSignature: string; baselineSignature: string;
  source: SourceDefinition; observations: Observation[]; artifact: { relativePath: string; size: number };
  basis: NonNullable<LocalSnapshot['evaluationBasis']>; result?: MaturityImportResult;
}
function requireCurator(session: CuratorSession) {
  if (session.role !== 'curator' || !session.curatorId) throw new ActionError('Загрузка доступна только куратору УОР', 403);
}
function catalogSignature(context: ApplicationContext, session: CuratorSession) {
  return digest({ active: context.db.get('catalog', 'active'), drafts: context.db.list<Draft>('drafts').filter(draft => draft.status === 'published' || draft.curatorId === session.curatorId).sort((a, b) => a.id.localeCompare(b.id)) });
}
function sourceSnapshots(context: ApplicationContext, catalog: CatalogSnapshot, sourceId: string) {
  return context.db.list<LocalSnapshot>('snapshots').filter(snapshot => snapshot.sourceId === sourceId && snapshot.classification === catalog.classification);
}
const rowKey = (row: Observation) => canonicalJson([row.goalId, row.participantId, row.metricId]);
const businessRow = (row: Observation) => ({ goalId: row.goalId, leaderId: row.leaderId, participantId: row.participantId,
  metricId: row.metricId, value: row.value, target: row.target, unit: row.unit, state: row.state, period: row.period, sourceId: row.sourceId });
/** Hash real business content, never trust a legacy snapshot's recorded dataHash. */
export function maturityFactsHash(rows: Observation[]) {
  return digest([...new Set(rows.map(row => canonicalJson(businessRow(row))))].sort());
}
function baselineSignature(context: ApplicationContext, catalog: CatalogSnapshot, sourceId: string) {
  return digest(sourceSnapshots(context, catalog, sourceId).map(snapshot => ({ id: snapshot.id, period: snapshot.period,
    collectedAt: snapshot.collectedAt, facts: maturityFactsHash(snapshot.observations) })).sort((a, b) => a.id.localeCompare(b.id)));
}
function latestSnapshot(context: ApplicationContext, catalog: CatalogSnapshot, sourceId: string, goalId: string, period: string) {
  return sourceSnapshots(context, catalog, sourceId).filter(snapshot => snapshot.period === period && snapshot.observations.some(row => row.goalId === goalId))
    .sort((a, b) => b.collectedAt.localeCompare(a.collectedAt) || b.id.localeCompare(a.id))[0] ?? null;
}
function selectSource(catalog: CatalogSnapshot, goalId: string, requested?: string | null): SourceDefinition {
  const matches = catalog.sources.filter(source => source.goalIds.includes(goalId) && ['file', 'manual'].includes(source.kind))
    .sort((a, b) => (a.kind === 'file' ? 0 : 1) - (b.kind === 'file' ? 0 : 1) || a.id.localeCompare(b.id));
  const newId = `file-maturity-${digest(goalId).slice(0, 16)}`;
  if (requested) {
    const selected = matches.find(source => source.id === requested);
    if (selected) return structuredClone(selected);
    if (requested !== newId || catalog.sources.some(source => source.id === requested)) throw new ActionError('Выберите файловый или ручной источник, связанный с этой целью', 400);
  } else if (matches.length) return structuredClone(matches[0]);
  return { id: newId, name: `XLSX модели зрелости · ${catalog.goals.find(goal => goal.id === goalId)!.title}`, kind: 'file',
    url: null, accessUrl: null, goalIds: [goalId], freshnessHours: 168, mode: 'local' };
}
function eligibleTeams(catalog: CatalogSnapshot, assignments: Assignment[]) {
  return catalog.entities.filter(entity => entity.type === 'team' && assignments.some(assignment => assignment.participantIds !== undefined
    ? assignment.participantIds.includes(entity.id) && (!entity.leaderId || entity.leaderId === assignment.leaderId)
    : entity.leaderId === assignment.leaderId));
}
function explicitMapping(mapping: Record<string, string>, key: string): string | undefined {
  if (Object.hasOwn(mapping, key)) return mapping[key];
  const keys = Object.keys(mapping).filter(candidate => normalize(candidate) === normalize(key));
  return keys.length === 1 ? mapping[keys[0]] : undefined;
}
function buildTeamMatches(rows: ParsedMaturityRow[], teams: KnowledgeEntity[], catalog: CatalogSnapshot, mapping: Record<string, string>) {
  const matches = new Map<string, ImportMatch>();
  const options = teams.map(team => ({ id: team.id, name: `${team.name}${team.leaderId ? ` · ${catalog.leaders.find(leader => leader.id === team.leaderId)?.name ?? ''}` : ''}` }));
  for (const row of rows) {
    const key = row.teamCode?.trim() || row.teamName.trim(); if (matches.has(key)) continue;
    const explicit = explicitMapping(mapping, key);
    let candidates = explicit !== undefined ? teams.filter(team => team.id === explicit) : row.teamCode ? teams.filter(team => team.id === row.teamCode!.trim()) : [];
    if (explicit === undefined && !candidates.length) candidates = teams.filter(team => [team.name, ...(team.aliases ?? [])].some(name => normalize(name) === normalize(row.teamName)));
    matches.set(key, { key, name: row.teamName, code: row.teamCode, matchedId: candidates.length === 1 ? candidates[0].id : null,
      status: candidates.length === 1 ? 'matched' : candidates.length > 1 ? 'ambiguous' : 'unmapped', options });
  }
  return matches;
}
function buildMetricMatches(rows: ParsedMaturityRow[], metricIds: string[], previous: Observation[], mapping: Record<string, string>) {
  const names = new Map(metricIds.map(id => [id, [...new Set(previous.filter(row => row.metricId === id).map(row => row.metricName))]]));
  const matches = new Map<string, ImportMatch>();
  const options = metricIds.map(id => ({ id, name: `${names.get(id)?.[0] || id}${names.get(id)?.[0] ? ` · ${id}` : ''}` }));
  for (const row of rows) {
    const key = row.metricName.trim(); if (matches.has(key)) continue;
    const explicit = explicitMapping(mapping, key);
    const candidates = explicit !== undefined ? metricIds.filter(id => id === explicit)
      : metricIds.filter(id => [id, ...(names.get(id) ?? [])].some(name => normalize(name) === normalize(key)));
    matches.set(key, { key, name: row.metricName, matchedId: candidates.length === 1 ? candidates[0] : null,
      status: candidates.length === 1 ? 'matched' : candidates.length > 1 ? 'ambiguous' : 'unmapped', options });
  }
  return matches;
}
function factChanges(previous: Observation[], next: Observation[], baselineSnapshotId: string | null) {
  const old = new Map(previous.map(row => [rowKey(row), canonicalJson(businessRow(row))]));
  const current = new Map(next.map(row => [rowKey(row), canonicalJson(businessRow(row))]));
  let added = 0, changed = 0, unchanged = 0;
  for (const [key, value] of current) { if (!old.has(key)) added++; else if (old.get(key) === value) unchanged++; else changed++; }
  return { added, changed, unchanged, removed: [...old.keys()].filter(key => !current.has(key)).length, baselineSnapshotId };
}

export async function previewMaturityImport(context: ApplicationContext, session: CuratorSession, raw: MaturityImportInput): Promise<MaturityImportPreview> {
  requireCurator(session); const input = inputSchema.parse(raw);
  if (!/\.xlsx$/i.test(input.name) || /[\x00-\x1f]/.test(input.name)) throw new ActionError('Выберите файл XLSX');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(input.base64) || input.base64.length % 4) throw new ActionError('Не удалось прочитать содержимое файла');
  const bytes = Buffer.from(input.base64, 'base64');
  if (!bytes.length || bytes.length > MAX_BYTES) throw new ActionError('Размер файла должен быть от 1 байта до 10 МБ');
  const operation = await context.operations.start('import', 'Предпросмотр XLSX модели зрелости');
  try {
    await context.operations.stage(operation.id, { key: 'read_file', label: 'Читаем книгу и проверяем структуру' });
    const signature = catalogSignature(context, session);
    const catalog = await context.catalogs.readForSession(session);
    if (signature !== catalogSignature(context, session)) throw new ActionError('Настройки изменились во время подготовки. Повторите предпросмотр.', 409);
    const goal = catalog.goals.find(item => item.id === input.goalId); if (!goal) throw new ActionError('Цель не найдена', 404);
    const source = selectSource(catalog, goal.id, input.sourceId);
    const parsed = await parseMaturityWorkbook(bytes);
    const sourceBaselineAtPreview = baselineSignature(context, catalog, source.id);
    const issues: ImportIssue[] = [...parsed.issues];
    const assignments = catalog.assignments.filter(assignment => assignment.goalId === goal.id && assignment.active !== false);
    const teams = eligibleTeams(catalog, assignments);
    const priorRows = context.db.list<LocalSnapshot>('snapshots').filter(snapshot => snapshot.classification === catalog.classification)
      .flatMap(snapshot => snapshot.observations).filter(row => row.goalId === goal.id && row.metricId !== goal.id);
    const metricIds = [...new Set(goal.requiredMetricIds?.length ? goal.requiredMetricIds : priorRows.map(row => row.metricId))].sort();
    const teamMapping = { ...((source.importProfile?.parser === 'maturity-xlsx-v1' ? source.importProfile.teamMapping : {})), ...(input.teamMapping ?? {}) };
    const metricMapping = { ...(source.importProfile?.metricMapping ?? {}), ...(input.metricMapping ?? {}) };
    const teamMatches = buildTeamMatches(parsed.rows, teams, catalog, teamMapping);
    const metricMatches = buildMetricMatches(parsed.rows, metricIds, priorRows, metricMapping);
    for (const match of teamMatches.values()) if (match.status !== 'matched') issues.push({ severity: 'error', code: `${match.status}_team`, message: `${match.status === 'ambiguous' ? 'Неоднозначная команда' : 'Команда не сопоставлена'}: ${match.name}. Выберите команду из активных назначений цели.` });
    for (const match of metricMatches.values()) if (match.status !== 'matched') issues.push({ severity: 'error', code: `${match.status}_metric`, message: `${match.status === 'ambiguous' ? 'Неоднозначный показатель' : 'Показатель не сопоставлен'}: ${match.name}. Выберите объявленную метрику цели.` });
    if (!assignments.length) issues.push({ severity: 'error', code: 'no_active_assignments', message: 'У цели нет активных назначений ИТ-лидерам. Настройте состав перед импортом.' });
    if (!metricIds.length) issues.push({ severity: 'error', code: 'no_declared_metrics', message: 'Сначала задайте обязательные показатели и их соответствия.' });
    await context.operations.stage(operation.id, { key: 'match', label: 'Сопоставляем команды и показатели с базой знаний' });
    const observations: Observation[] = [], byKey = new Map<string, Observation>();
    for (const row of parsed.rows) {
      const teamMatch = teamMatches.get(row.teamCode?.trim() || row.teamName.trim())!, metricMatch = metricMatches.get(row.metricName.trim())!;
      if (!teamMatch.matchedId || !metricMatch.matchedId) continue;
      const team = teams.find(item => item.id === teamMatch.matchedId)!;
      const owners = [...new Set(assignments.filter(item => item.participantIds !== undefined
        ? item.participantIds.includes(team.id) && (!team.leaderId || team.leaderId === item.leaderId)
        : item.leaderId === team.leaderId).map(item => item.leaderId))];
      if (owners.length !== 1) {
        issues.push({ severity: 'error', code: owners.length ? 'ambiguous_team_assignment' : 'unmapped_team_assignment', rowNumber: row.rowNumber,
          message: `У команды «${team.name}» ${owners.length ? 'несколько активных ответственных' : 'нет активного ответственного'} по цели. Исправьте назначения перед загрузкой.` });
        continue;
      }
      const observation: Observation = { id: randomUUID(), goalId: goal.id, leaderId: owners[0],
        participantId: team.id, participantName: team.name, metricId: metricMatch.matchedId, metricName: priorRows.find(item => item.metricId === metricMatch.matchedId)?.metricName ?? row.metricName,
        value: row.value, target: row.target, unit: priorRows.find(item => item.metricId === metricMatch.matchedId)?.unit ?? goal.unit, state: row.state, reason: row.reason,
        period: input.period, sourceId: source.id, sourceUpdatedAt: input.sourceUpdatedAt ?? null, downloadedAt: new Date().toISOString() };
      const key = rowKey(observation), duplicate = byKey.get(key);
      if (duplicate) {
        const same = canonicalJson(businessRow(duplicate)) === canonicalJson(businessRow(observation));
        issues.push({ severity: same ? 'warning' : 'error', code: same ? 'duplicate_identical' : 'conflicting_duplicate', rowNumber: row.rowNumber,
          message: same ? `Повтор строки команды «${team.name}» учтён один раз.` : `Противоречивые строки команды «${team.name}» по одному показателю.` });
        if (!same) observations.push(observation);
      } else { observations.push(observation); byKey.set(key, observation); }
    }
    const expectedParticipants = assignments.length && assignments.every(assignment => assignment.participantIds !== undefined)
      ? [...new Set(assignments.flatMap(assignment => assignment.participantIds!))] : undefined;
    const expectedMetricIds = goal.requiredMetricIds?.length ? goal.requiredMetricIds : undefined;
    const scopeRevision = JSON.stringify(assignments.map(assignment => ({ id: assignment.id, teams: [...assignment.teams].sort(), participantIds: assignment.participantIds ? [...assignment.participantIds].sort() : null, target: assignment.target ?? null })).sort((a, b) => a.id.localeCompare(b.id)));
    const evaluation = evaluateGoal({ goal, observations, period: input.period, leaderId: null, expectedParticipants, expectedMetricIds, scopeRevision });
    if (expectedParticipants === undefined || expectedMetricIds === undefined) {
      issues.push({ severity: 'warning', code: 'unknown_coverage', message: 'Ожидаемый состав команд или обязательных показателей не объявлен полностью. Выполнение цели не подтверждается.' });
      evaluation.qualityFlags.push('unknown_coverage');
      if (evaluation.official === 'met') evaluation.official = 'unknown'; if (evaluation.internal === 'met') evaluation.internal = 'unknown'; evaluation.validation = 'not_required';
    }
    if (evaluation.missing) issues.push({ severity: 'warning', code: 'missing_expected_facts', message: `Отсутствуют или неполны ожидаемые факты: ${evaluation.missing}. Они сохранятся как отсутствие данных и не станут успехом.` });
    if (!input.sourceUpdatedAt) issues.push({ severity: 'warning', code: 'source_date_unknown', message: 'Дата обновления источника неизвестна. Время загрузки файла не подставляется вместо неё.' });
    if (parsed.ignoredRows) issues.push({ severity: 'warning', code: 'ignored_aggregate_rows', message: `Пропущены пустые/итоговые строки: ${parsed.ignoredRows}.` });
    const baseline = latestSnapshot(context, catalog, source.id, goal.id, input.period);
    const previous = baseline?.observations.filter(row => row.goalId === goal.id) ?? [];
    const targetsChanged = observations.filter(row => previous.some(old => rowKey(old) === rowKey(row) && old.target !== row.target)).length;
    if (targetsChanged) issues.push({ severity: 'warning', code: 'threshold_changed', message: `В исходном файле изменены целевые значения показателей: ${targetsChanged}. Изменение фактов потребует новой проверки выполнения.` });
    if (!observations.length) issues.push({ severity: 'error', code: 'no_matched_facts', message: 'Не найдено ни одного полностью сопоставленного наблюдения.' });
    const savedTeamMapping = Object.fromEntries([...teamMatches.values()].filter(match => match.matchedId).map(match => [match.key, match.matchedId!]));
    const savedMetricMapping = Object.fromEntries([...metricMatches.values()].filter(match => match.matchedId).map(match => [match.key, match.matchedId!]));
    source.importProfile = { parser: 'maturity-xlsx-v1', teamMapping: { ...teamMapping, ...savedTeamMapping }, metricMapping: { ...metricMapping, ...savedMetricMapping } };
    const id = randomUUID(), createdAt = new Date().toISOString();
    const preview: MaturityImportPreview = { id, goalId: goal.id, sourceId: source.id, period: input.period, fileName: input.name.split(/[\\/]/).pop()!,
      fileHash: createHash('sha256').update(bytes).digest('hex'), createdAt, expiresAt: new Date(Date.now() + TTL_MS).toISOString(), canCommit: !issues.some(issue => issue.severity === 'error'),
      duplicateSnapshotId: baseline && maturityFactsHash(previous) === maturityFactsHash(observations) ? baseline.id : null,
      summary: { rows: parsed.rows.length, teams: new Set(observations.map(row => row.participantId)).size, eligibleMetrics: evaluation.eligibleMetrics, excluded: evaluation.excluded, missing: evaluation.missing,
        unmappedTeams: [...teamMatches.values()].filter(match => match.status !== 'matched').length, unmappedMetrics: [...metricMatches.values()].filter(match => match.status !== 'matched').length },
      issues, teamMatches: [...teamMatches.values()], metricMatches: [...metricMatches.values()], changes: factChanges(previous, observations, baseline?.id ?? null), sample: observations.slice(0, 50), evaluation, operationId: operation.id };
    const relativePath = `source-artifacts/${id}.xlsx`;
    await writeFile(await safeArtifactPath(context.paths.runtimeRoot, relativePath), bytes);
    const record: StoredPreview = { preview, curatorId: session.curatorId, catalogSignature: signature,
      baselineSignature: sourceBaselineAtPreview, source, observations, artifact: { relativePath, size: bytes.length },
      basis: { methodVersion: 'participant-all-applicable-metrics-v1', goal: structuredClone(goal), assignments: structuredClone(assignments) } };
    context.db.set('import-previews', id, record);
    await context.operations.finish(operation.id, { status: preview.canCommit ? 'completed' : 'partial', message: preview.canCommit ? 'Предпросмотр готов. Проверьте состав и сохраните срез.' : 'Предпросмотр готов. Устраните ошибки сопоставления перед сохранением.' });
    return preview;
  } catch (error) {
    await context.operations.finish(operation.id, { status: 'failed', message: (error as Error).message });
    if (error instanceof ActionError || error instanceof z.ZodError) throw error;
    throw new ActionError((error as Error).message || 'Не удалось прочитать файл XLSX', 400);
  }
}

function sourceDraft(context: ApplicationContext, session: CuratorSession, source: SourceDefinition, current: CatalogSnapshot): Draft {
  const existing = context.db.list<Draft>('drafts').find(draft => draft.curatorId === session.curatorId && draft.change.kind === 'source' && draft.change.id === source.id && draft.status === 'local');
  const original = current.sources.find(item => item.id === source.id);
  const patch = original ? { importProfile: source.importProfile } : { ...source };
  return { id: existing?.id ?? randomUUID(), curatorId: session.curatorId, change: { kind: 'source', id: source.id, baseRevision: null, patch: { ...(existing?.change.patch ?? {}), ...patch } },
    base: existing ? existing.base : original ? structuredClone(original) as unknown as Record<string, unknown> : null,
    createdAt: new Date().toISOString(), status: 'local', error: null };
}

export async function commitMaturityImport(context: ApplicationContext, session: CuratorSession, previewId: string): Promise<MaturityImportResult> {
  requireCurator(session);
  const record = context.db.get<StoredPreview>('import-previews', previewId); if (!record) throw new ActionError('Предпросмотр не найден. Загрузите файл повторно.', 404);
  if (record.curatorId !== session.curatorId) throw new ActionError('Этот предпросмотр принадлежит другому куратору', 403);
  if (record.result) return record.result;
  if (Date.parse(record.preview.expiresAt) <= Date.now()) throw new ActionError('Предпросмотр устарел. Загрузите файл повторно.', 410);
  if (!record.preview.canCommit) throw new ActionError('Сначала устраните ошибки предпросмотра', 400);
  const operation = await context.operations.start('import', 'Сохранение среза модели зрелости');
  try {
    await context.operations.stage(operation.id, { key: 'validate_preview', label: 'Проверяем актуальность настроек и исходного среза' });
    const result = context.db.transaction(() => {
      if (record.catalogSignature !== catalogSignature(context, session)) throw new ActionError('Настройки цели, назначения или профиль изменились. Повторите предпросмотр.', 409);
      const active = context.db.get<CatalogSnapshot>('catalog', 'active')!;
      if (record.baselineSignature !== baselineSignature(context, active, record.source.id)) throw new ActionError('Состав фактов источника изменился после предпросмотра. Повторите загрузку.', 409);
      const baseline = latestSnapshot(context, active, record.source.id, record.preview.goalId, record.preview.period);
      const duplicate = !!baseline && maturityFactsHash(baseline.observations.filter(row => row.goalId === record.preview.goalId)) === maturityFactsHash(record.observations);
      const draft = sourceDraft(context, session, record.source, active);
      const updated = structuredClone(active); const previousSource = updated.sources.find(item => item.id === record.source.id);
      if (previousSource) previousSource.importProfile = record.source.importProfile; else updated.sources.push(record.source);
      validateCatalog(updated);
      const newest = Math.max(0, ...sourceSnapshots(context, active, record.source.id).map(snapshot => Date.parse(snapshot.collectedAt)).filter(Number.isFinite));
      const collectedAt = new Date(Math.max(Date.now(), newest + 1)).toISOString();
      const snapshot: LocalSnapshot = { id: randomUUID(), classification: active.classification, sourceId: record.source.id, period: record.preview.period,
        observations: record.observations.map(row => ({ ...row, downloadedAt: collectedAt })), collectedAt, sourceUpdatedAt: record.observations[0]?.sourceUpdatedAt ?? null,
        origin: 'file', dataHash: maturityFactsHash(record.observations), status: 'personal', curatorId: session.curatorId, curatorName: session.name, validatedAt: null,
        limitations: record.preview.issues.filter(issue => issue.severity === 'warning').map(issue => issue.message), evidenceIds: [], evaluationBasis: record.basis };
      if (!duplicate) validateSnapshot(snapshot, updated);
      context.db.set('catalog', 'active', updated); context.db.set('drafts', draft.id, draft);
      if (!duplicate) context.db.set('snapshots', snapshot.id, snapshot);
      const accepted: MaturityImportResult = { snapshotId: duplicate ? baseline!.id : snapshot.id, duplicate, operationId: operation.id };
      context.db.set('import-previews', previewId, { ...record, result: accepted });
      context.db.set('import-artifacts', previewId, { previewId, snapshotId: accepted.snapshotId, name: record.preview.fileName,
        relativePath: record.artifact.relativePath, size: record.artifact.size, sha256: record.preview.fileHash });
      context.catalogs.recordChange(session, duplicate ? 'snapshot_import_duplicate' : 'snapshot_imported', accepted.snapshotId, record.basis.goal.title, {},
        { sourceId: record.source.id, period: record.preview.period, fileName: record.preview.fileName, facts: record.observations.length, duplicate }, operation.id);
      return accepted;
    });
    await context.operations.stage(operation.id, { key: 'recalculate', label: 'Срез сохранён. Пересчитываем текущие статусы' });
    try {
      await context.state(session);
      await context.operations.finish(operation.id, { status: 'completed', message: result.duplicate ? 'Идентичные факты уже сохранены. Новая редакция не создана.' : 'Новая редакция среза сохранена; текущие статусы пересчитаны.' });
    } catch (error) {
      await context.operations.finish(operation.id, { status: 'partial', message: 'Срез сохранён, но пересчёт завершился ошибкой.', details: [(error as Error).message] });
    }
    return result;
  } catch (error) {
    await context.operations.finish(operation.id, { status: 'failed', message: (error as Error).message, details: ['Предыдущие факты сохранены без изменений'] });
    throw error;
  }
}
