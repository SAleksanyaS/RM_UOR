import { z } from 'zod';
import type { CatalogSnapshot, Classification, Goal, SourceDefinition } from '../../domain/contracts';

const text = z.string().max(30_000);
const identifier = z.string().min(1).max(200);
const texts = z.array(text).max(5_000);
const linkSchema = z.object({ label: text, url: text, kind: text });
const goalSchema = z.object({
  id: identifier, category: z.enum(['process', 'data', 'architecture', 'security']),
  title: text.min(1), target: text, metric: text, status: text, summary: text,
  actions: texts, scopeType: text, links: z.array(linkSchema),
});
const assignmentSchema = z.object({
  goalId: identifier, teams: texts, agents: texts.optional(), participantType: text.optional(),
  active: z.boolean().optional(), allProducts: z.boolean().optional(), target: text.optional(),
  summary: text.optional(), actions: texts.optional(), metric: text.optional(),
});
const portalSchema = z.object({
  goals: z.array(goalSchema).min(1).max(10_000),
  leaders: z.record(identifier, z.object({ name: text.min(1), teams: texts, assignments: z.array(assignmentSchema) })),
});

function safeUrl(value: string): string {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error('Некорректная ссылка в карте целей'); }
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('Недопустимая схема или учетные данные ссылки в карте целей');
  }
  return value;
}

function numericThreshold(metric: string, target: string): Pick<Goal, 'officialTarget' | 'unit' | 'direction'> {
  const unknown = { officialTarget: null, unit: '', direction: 'increase' as const };
  // A sentence with several numbers, a baseline, or growth cannot safely become one threshold.
  if ((metric.match(/\d+(?:[.,]\d+)?/g) ?? []).length !== 1 || /^[+−–-]/.test(metric.trim())) return unknown;
  const percent = metric.match(/^\s*(\d+(?:[.,]\d+)?)\s*%\s*[^\d]*$/);
  if (percent) return { officialTarget: Number(percent[1].replace(',', '.')), unit: '%', direction: 'increase' };
  const days = metric.match(/^\s*(\d+(?:[.,]\d+)?)\s*(?:рабочих\s+)?(?:дней|дня|день)\s*$/i);
  if (days && /не более|не превыш|сокращ|сниже|до \d|≤/i.test(target)) {
    return { officialTarget: Number(days[1].replace(',', '.')), unit: 'дней', direction: 'decrease' };
  }
  return unknown;
}

function decodeTitle(value: string): string {
  return value.replace(/<[^>]*>/g, '').replace(/&(?:amp|lt|gt|quot|apos|nbsp);/g, entity => ({
    '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ',
  })[entity] ?? entity).trim();
}

/** Reads only the inert portal-data JSON. The surrounding HTML is never evaluated or rendered. */
export function importGoalMap(html: string, options: { classification?: Classification; importedAt?: string } = {}): CatalogSnapshot {
  if (html.length > 20_000_000) throw new Error('Файл карты целей превышает 20 МБ');
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)]
    .filter(match => /(?:^|\s)id\s*=\s*(["'])portal-data\1/i.test(match[1]));
  if (scripts.length !== 1) throw new Error('В файле должен быть один блок script с id="portal-data"');
  let raw: unknown;
  try { raw = JSON.parse(scripts[0][2]); } catch { throw new Error('Блок portal-data содержит некорректный JSON'); }
  const parsed = portalSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Некорректная структура карты целей: ${parsed.error.issues.map(issue => issue.path.join('.') + ': ' + issue.message).join('; ')}`);
  const portal = parsed.data;
  const importedAt = options.importedAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(importedAt))) throw new Error('Некорректная дата импорта');
  const ids = new Set<string>();
  for (const goal of portal.goals) {
    if (ids.has(goal.id)) throw new Error(`Повтор идентификатора цели: ${goal.id}`);
    ids.add(goal.id);
  }
  const goals: Goal[] = portal.goals.map(goal => ({
    ...goal, links: goal.links.map(link => ({ ...link, url: safeUrl(link.url) })),
    ownerId: null, curatorId: null, internalTarget: null, baseline: null, weight: null,
    priority: null, dueDate: null, revision: `import:${importedAt}`, ...numericThreshold(goal.metric, goal.target),
  }));
  const leaders = Object.entries(portal.leaders).map(([id, leader]) => ({ id, name: leader.name, teams: leader.teams }));
  const assignments = Object.entries(portal.leaders).flatMap(([leaderId, leader]) => leader.assignments.map((assignment, index) => {
    if (!ids.has(assignment.goalId)) throw new Error(`Назначение ссылается на неизвестную цель ${assignment.goalId}`);
    return { ...assignment, id: `${leaderId}:${assignment.goalId}:${index + 1}`, leaderId };
  }));
  const sources: SourceDefinition[] = [];
  for (const goal of goals) {
    const dashboards = goal.links.filter(link => link.kind === 'dashboard');
    for (const dashboard of dashboards) {
      const existing = sources.find(source => source.url === dashboard.url);
      if (existing) existing.goalIds.push(goal.id);
      else sources.push({ id: `dashboard-${sources.length + 1}`, name: dashboard.label, kind: 'dashboard', url: dashboard.url, accessUrl: null, goalIds: [goal.id], freshnessHours: 168, mode: 'stub' });
    }
    if (!dashboards.length) sources.push({ id: `manual-${goal.id}`, name: `Данные куратора: ${goal.title}`, kind: 'manual', url: null, accessUrl: null, goalIds: [goal.id], freshnessHours: 168, mode: 'local' });
  }
  const entities = leaders.flatMap(leader => leader.teams.map((name, index) => ({ id: `${leader.id}:product:${index + 1}`, type: 'product', name, leaderId: leader.id })));
  return {
    schemaVersion: 1, id: 'goal-map-2026', name: decodeTitle(html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1] ?? 'Импортированная карта целей'),
    classification: options.classification ?? 'corporate', importedAt, goals, leaders, assignments, sources, comments: [], entities,
  };
}
