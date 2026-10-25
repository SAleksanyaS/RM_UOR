import { z } from 'zod';
import type { Attestation, CatalogSnapshot, DomainChangeEvent, LocalSnapshot, SnapshotEvaluationBasis } from '../../domain/contracts';
import { getDirections } from '../catalog/directions';
import { executionPlanSchema } from '../planning/plan-schema';
import { measurementSchema } from '../evaluation/measurement-schema';
import { knowledgeStoredFields } from '../knowledge/knowledge-schema';
import { decisionEntitySchema } from '../director/decision-schema';
import { reportProfileSchema } from '../reporting/report-profile-schema';
import { collectionSchema } from '../connectors/contracts';
import { validateExecutionEntities } from '../execution/execution-schema';
import {validateWeeklyBriefEntities} from '../weekly-report/contracts';

const id = z.string().min(1).max(500);
const text = z.string();
const date = z.string().refine(value => Number.isFinite(Date.parse(value)), 'Некорректная дата');
const number = z.number().finite();
const nullableNumber = number.nullable();
const nullableId = id.nullable();
const ids = z.array(id);
const url = z.string().url().refine(value => /^https?:\/\//i.test(value), 'Разрешены HTTP/HTTPS ссылки');
const link = z.object({ label: text, url: z.string().url().refine(value => /^https?:\/\//i.test(value), 'Разрешены HTTP/HTTPS ссылки'), kind: text }).passthrough();
const goal = z.object({ id, category: z.enum(['process', 'data', 'architecture', 'security']), title: id, target: text, metric: text,
  status: text, summary: text, actions: z.array(text), scopeType: text, links: z.array(link), ownerId: nullableId, curatorId: nullableId,
  officialTarget: nullableNumber, internalTarget: nullableNumber, unit: text, direction: z.enum(['increase', 'decrease']), baseline: nullableNumber,
  weight: number.nonnegative().nullable(), priority: z.enum(['high', 'normal', 'low']).nullable(), dueDate: z.iso.date().nullable(), revision: id,
  requiredMetricIds: ids.max(100).optional(), workDirectionId: nullableId.optional(), plan: executionPlanSchema.optional(), measurement: measurementSchema.optional() }).passthrough();
const assignment = z.object({ id, goalId: id, leaderId: id, teams: z.array(text), agents: z.array(text).optional(), participantIds: ids.optional(),
  participantType: text.optional(), active: z.boolean().optional(), allProducts: z.boolean().optional(), target: text.optional(),
  summary: text.optional(), actions: z.array(text).optional(), metric: text.optional(), plan: executionPlanSchema.optional() }).passthrough();
const source = z.object({ id, name: id, kind: z.enum(['dashboard', 'attachment', 'manual', 'file', 'demo']), url: url.nullable(), accessUrl: url.nullable(),
  goalIds: ids, freshnessHours: number.positive(), mode: z.enum(['stub', 'local']), collection:collectionSchema.optional(), lastAttemptAt: date.nullable().optional(),
  importProfile: z.union([z.object({ parser: z.literal('maturity-xlsx-v1'), teamMapping: z.record(id, id), metricMapping: z.record(id, id) }),
    z.object({ parser: z.literal('tabular-v1'), columns: z.object({ period: id.optional(), leader: id.optional(), participant: id.optional(), metric: id.optional(), value: id,
      target: id.optional(), state: id.optional(), reason: id.optional(), sourceUpdatedAt: id.optional() }).strict(), leaderMapping: z.record(id, id), participantMapping: z.record(id, id),
      metricMapping: z.record(id, id), defaults: z.object({ period: z.iso.date(), leaderId: nullableId.optional(), participantId: id.optional(), metricId: id.optional() }).strict() }).strict()]).optional() }).passthrough();
const catalogSchema = z.object({ schemaVersion: z.literal(1), id, name: id, classification: z.enum(['demo', 'corporate']), importedAt: date,
  goals: z.array(goal), leaders: z.array(z.object({ id, name: id, teams: z.array(text), clusterName: z.string().max(500).nullable().optional() }).passthrough()), assignments: z.array(assignment), sources: z.array(source),
  comments: z.array(z.object({ id, goalId: id, leaderId: nullableId, text, author: id, createdAt: date, validUntil: date.nullable(), revision: id }).passthrough()),
  entities: z.array(z.object({ id, type: id, name: id, leaderId: id.nullable().optional(), productId: id.nullable().optional(), aliases: z.array(text).optional(), ...knowledgeStoredFields }).passthrough()),
  directions: z.array(z.object({ id, name: id, description: text, color: z.string().regex(/^#[0-9a-fA-F]{6}$/), order: number.nonnegative() }).passthrough()).optional() }).passthrough();
const observation = z.object({ id, goalId: id, leaderId: nullableId, participantId: id, participantName: text, metricId: id, metricName: text,
  value: nullableNumber, target: nullableNumber, unit: text, state: z.enum(['numeric', 'exception', 'no_events', 'missing']), reason: text.nullable(),
  period: id, sourceId: id, sourceUpdatedAt: date.nullable(), downloadedAt: date }).passthrough();
const historicalEntity=catalogSchema.shape.entities.element.strip().extend({goalId:nullableId.optional(),owner:text.optional(),dueDate:z.iso.date().nullable().optional(),state:z.enum(['open','closed']).optional(),closureComment:text.optional(),updatedAt:date.optional(),updatedBy:text.optional(),leaderIds:ids.optional(),period:z.iso.date().optional(),baselinePeriod:z.iso.date().optional(),templateId:nullableId.optional()});
const basisSchema = z.object({ methodVersion: z.enum(['participant-all-applicable-metrics-v1', 'explicit-measurement-v1']),
  goal: goal.strip().extend({ links: z.array(link.strip()) }), assignments: z.array(assignment.strip()), organization:z.object({leaders:z.array(catalogSchema.shape.leaders.element.strip()),entities:z.array(historicalEntity),directions:z.array(catalogSchema.shape.directions.unwrap().element.strip()).optional(),comments:z.array(catalogSchema.shape.comments.element.strip()).optional(),sources:z.array(source.strip()).optional()}).strip().optional() }).strip().superRefine((basis, ctx) => {
    if ((basis.methodVersion === 'explicit-measurement-v1') !== !!basis.goal.measurement)
      ctx.addIssue({ code: 'custom', message: 'Версия исторической методики не соответствует настройке цели' });
  });
const snapshotSchema = z.object({ id, classification: z.enum(['demo', 'corporate']), sourceId: id, period: id, observations: z.array(observation),
  collectedAt: date, sourceUpdatedAt: date.nullable(), origin: z.enum(['file', 'manual', 'demo', 'dashboard']), dataHash: id,
  status: z.enum(['personal', 'validated']), curatorId: nullableId, curatorName: text.nullable(), validatedAt: date.nullable(), limitations: z.array(text), evidenceIds: ids,
  evaluationBasis: basisSchema.optional() }).passthrough();

function parse<T>(schema: z.ZodType, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error(`${label}: ${result.error.issues.slice(0, 5).map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
  return result.data as T;
}
function requireReference(condition: boolean, message: string): asserts condition { if (!condition) throw new Error(`Некорректная общая версия: ${message}`); }
function unique(items: { id: string }[], label: string) {
  requireReference(new Set(items.map(item => item.id)).size === items.length, `повторяются идентификаторы ${label}`);
}

export function validateCatalog(value: unknown): CatalogSnapshot {
  const catalog = parse<CatalogSnapshot>(catalogSchema, value, 'Некорректный каталог');
  for (const [label, items] of Object.entries({ goals: catalog.goals, leaders: catalog.leaders, assignments: catalog.assignments,
    sources: catalog.sources, comments: catalog.comments, entities: catalog.entities })) unique(items, label);
  const goals = new Set(catalog.goals.map(item => item.id)), leaders = new Set(catalog.leaders.map(item => item.id));
  const directions = getDirections(catalog); unique(directions, 'directions');
  for (const goal of catalog.goals) requireReference(!goal.workDirectionId || directions.some(direction => direction.id === goal.workDirectionId), `цель ${goal.id} ссылается на неизвестное направление`);
  for (const goal of catalog.goals) if (goal.measurement && goal.scopeType === 'global') {
    requireReference(goal.measurement.kind !== 'participant_share', `общая цель ${goal.id}: доля команд требует персональных назначений`);
    requireReference(!catalog.assignments.some(item => item.goalId === goal.id && item.active !== false), `общая цель ${goal.id} смешана с персональными назначениями`);
  }
  for (const item of catalog.assignments) {
    requireReference(goals.has(item.goalId), `назначение ${item.id} ссылается на неизвестную цель`);
    requireReference(leaders.has(item.leaderId), `назначение ${item.id} ссылается на неизвестного лидера`);
    if (catalog.goals.find(goal => goal.id === item.goalId)?.measurement && item.active !== false && item.participantIds) {
      requireReference(new Set(item.participantIds).size === item.participantIds.length, `назначение ${item.id}: повторяются расчётные участники`);
      requireReference(item.participantIds.every(participantId => participantId === item.leaderId || catalog.entities.some(entity => entity.id === participantId
        && (!entity.leaderId || entity.leaderId === item.leaderId))), `назначение ${item.id}: сначала включите в публикацию справочные объекты выбранного состава`);
    }
  }
  for (const item of catalog.sources) requireReference(item.goalIds.every(goalId => goals.has(goalId)), `источник ${item.id} ссылается на неизвестную цель`);
  for (const item of catalog.comments) {
    requireReference(goals.has(item.goalId), `комментарий ${item.id} ссылается на неизвестную цель`);
    requireReference(item.leaderId === null || leaders.has(item.leaderId), `комментарий ${item.id} ссылается на неизвестного лидера`);
  }
  for (const item of catalog.entities) {
    if (item.type === 'decision') { const decision = parse<import('../director/decision-schema').DecisionEntity>(decisionEntitySchema, item, 'Некорректное решение'); requireReference(!decision.goalId || goals.has(decision.goalId), 'Решение ссылается на неизвестную цель'); }
    if (item.type === 'report_profile') { const profile = parse<import('../reporting/report-profile-schema').ReportProfile>(reportProfileSchema, item, 'Некорректный профиль отчёта'); requireReference(profile.goalIds.every(id => goals.has(id)) && profile.leaderIds.every(id => leaders.has(id)), 'Профиль отчёта содержит неизвестную цель или ИТ-лидера'); }
    requireReference(!item.goalIds || item.goalIds.every(id => goals.has(id)), 'Статья или справочник ссылается на неизвестную цель');
  }
  for (const assignment of catalog.assignments.filter(item => item.active !== false)) requireReference(!assignment.participantIds?.some(id => catalog.entities.find(entity => entity.id === id)?.archivedAt), 'В действующем назначении выбран архивный участник');
  for (const item of catalog.entities) requireReference(!item.leaderId || leaders.has(item.leaderId), `справочник ${item.id} ссылается на неизвестного лидера`);
  for (const item of catalog.entities) if (item.type === 'product_leader' && item.productId)
    requireReference(catalog.entities.some(product => product.id === item.productId && product.type === 'product'), `связь ${item.id} ссылается на неизвестный продукт`);
  validateExecutionEntities(catalog);
  validateWeeklyBriefEntities(catalog);
  return catalog;
}

export function validateSnapshot(value: unknown, catalog?: CatalogSnapshot): LocalSnapshot {
  const snapshot = parse<LocalSnapshot>(snapshotSchema, value, 'Некорректный снимок');
  requireReference(snapshot.observations.every(row => row.period === snapshot.period && row.sourceId === snapshot.sourceId), `снимок ${snapshot.id}: периоды или источники наблюдений не совпадают`);
  if (snapshot.evaluationBasis) {
    const basis = snapshot.evaluationBasis;
    unique(basis.assignments, 'historical assignments');
    requireReference(basis.assignments.every(item => item.goalId === basis.goal.id), `снимок ${snapshot.id}: состав методики относится к другой цели`);
    requireReference(snapshot.observations.every(row => row.goalId === basis.goal.id), `снимок ${snapshot.id}: методика относится к другой цели`);
  }
  if (snapshot.status === 'validated') requireReference(!!snapshot.curatorId && !!snapshot.curatorName?.trim() && !!snapshot.validatedAt && snapshot.observations.length > 0,
    `снимок ${snapshot.id}: отсутствуют автор/дата проверки или факты`);
  if (catalog) {
    const source = catalog.sources.find(item => item.id === snapshot.sourceId);
    requireReference(!!source, `неизвестный источник снимка ${snapshot.id}`);
    requireReference(snapshot.classification === catalog.classification, `классификация снимка ${snapshot.id} отличается от каталога`);
    const goals = new Set(catalog.goals.map(item => item.id)), leaders = new Set(catalog.leaders.map(item => item.id));
    requireReference(snapshot.observations.every(row => goals.has(row.goalId) && source.goalIds.includes(row.goalId)), `снимок ${snapshot.id} ссылается на неизвестную цель источника`);
    requireReference(snapshot.observations.every(row => row.leaderId === null || leaders.has(row.leaderId)), `снимок ${snapshot.id} ссылается на неизвестного лидера`);
  }
  return snapshot;
}

/** Strip unrecognised fields before a historical basis enters the shared manifest. */
export function validateEvaluationBasis(value: unknown): SnapshotEvaluationBasis {
  return parse<SnapshotEvaluationBasis>(basisSchema, value, 'Некорректная историческая методика');
}

export function validateAttestation(value: unknown, catalog: CatalogSnapshot): Attestation {
  const item = parse<Attestation>(z.object({ id, goalId: id, leaderId: nullableId, fingerprint: id, period: id, curatorId: id, curatorName: id,
    confirmedAt: date, comment: text.nullable(), evidenceIds: ids, invalidatedAt: date.nullable().optional(), invalidationReason: text.nullable().optional() }).passthrough(), value, 'Некорректное подтверждение');
  requireReference(catalog.goals.some(goal => goal.id === item.goalId), 'подтверждение ссылается на неизвестную цель');
  requireReference(item.leaderId === null || catalog.leaders.some(leader => leader.id === item.leaderId), 'подтверждение ссылается на неизвестного лидера');
  return item;
}
export function validateChangeEvent(value: unknown): DomainChangeEvent {
  return parse<DomainChangeEvent>(z.object({ id, kind: id, objectId: id, objectLabel: text, actor: id, at: date,
    fields: z.array(z.object({ field: id, before: z.unknown(), after: z.unknown() })), operationId: id.optional() }).passthrough(), value, 'Некорректное событие изменений');
}
