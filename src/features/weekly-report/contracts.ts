import { z } from 'zod';
import type { CatalogSnapshot, KnowledgeEntity } from '../../domain/contracts';

const id = z.string().trim().min(1).max(500);
export const weeklyBriefWeekSchema = z.iso.date().refine(value => new Date(`${value}T00:00:00Z`).getUTCDay() === 1, 'Выберите понедельник — начало отчётной недели');
const lines = z.array(z.string().trim().min(1, 'Удалите пустые строки').max(1000, 'В строке допускается до 1000 знаков')).max(20, 'В разделе допускается до 20 строк');
export const weeklyBriefContentSchema = z.object({
  summary: z.string().trim().min(1, 'Заполните главную сводку').max(4000, 'В сводке допускается до 4000 знаков'),
  completed: lines, attention: lines, nextWeek: lines,
}).strict();
export const weeklyBriefBodySchema = weeklyBriefContentSchema.extend({
  schemaVersion: z.literal(1), weekStart: weeklyBriefWeekSchema,
  ownerId: id, ownerName: id, updatedAt: z.iso.datetime({ offset: true }),
}).strict();
export const weeklyBriefSaveSchema = weeklyBriefContentSchema.extend({ weekStart: weeklyBriefWeekSchema, baseRevision: id.nullable() }).strict();
const weeklyBriefEntitySchema = z.object({ id, type: z.literal('weekly_brief'), name: id, body: z.string().max(75000), revision: id }).strict();

export type WeeklyBriefContent = z.infer<typeof weeklyBriefContentSchema>;
export type WeeklyBriefBody = z.infer<typeof weeklyBriefBodySchema>;
export type WeeklyBriefInput = z.infer<typeof weeklyBriefSaveSchema>;
export interface WeeklyBriefEntity extends KnowledgeEntity { type: 'weekly_brief'; body: string; revision: string }
export type WeeklyBriefRecord = WeeklyBriefBody & { id: string; revision: string };
export type WeeklyBriefVisibility = 'local' | 'release' | 'published';
export interface WeeklyReportView {
  weekStart: string; weeks: string[]; published: WeeklyBriefRecord[];
  own: { record: WeeklyBriefRecord; visibility: WeeklyBriefVisibility } | null;
}
export interface WeeklyBriefSaveResult { record: WeeklyBriefRecord; draftId: string }

/** Plain declared text only; callers must never interpret summary fields as facts. */
export function readWeeklyBrief(entity: KnowledgeEntity): WeeklyBriefRecord {
  try {
    const stored = weeklyBriefEntitySchema.parse(entity);
    return { ...weeklyBriefBodySchema.parse(JSON.parse(stored.body)), id: stored.id, revision: stored.revision };
  } catch (failure) { throw new Error(`Некорректная недельная сводка «${entity.name || entity.id}»: ${(failure as Error).message}`); }
}
export function getWeeklyBriefs(catalog: Pick<CatalogSnapshot, 'entities'>, weekStart?: string): WeeklyBriefRecord[] {
  if (weekStart) weeklyBriefWeekSchema.parse(weekStart);
  return catalog.entities.filter(entity => entity.type === 'weekly_brief').map(readWeeklyBrief)
    .filter(record => !weekStart || record.weekStart === weekStart)
    .sort((a, b) => b.weekStart.localeCompare(a.weekStart) || a.ownerName.localeCompare(b.ownerName, 'ru') || a.ownerId.localeCompare(b.ownerId));
}
export function validateWeeklyBriefEntities(catalog: Pick<CatalogSnapshot, 'entities'>): void {
  const identities = new Set<string>();
  for (const record of getWeeklyBriefs(catalog)) {
    const identity = JSON.stringify([record.ownerId, record.weekStart]);
    if (identities.has(identity)) throw new Error('Некорректная недельная сводка: у одного куратора повторяется отчёт за неделю');
    identities.add(identity);
  }
}
export function currentWeekStart(today = new Date().toISOString().slice(0, 10)): string {
  const date = new Date(`${z.iso.date().parse(today)}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
  return date.toISOString().slice(0, 10);
}
export function weekEnd(weekStart: string): string {
  const date = new Date(`${weeklyBriefWeekSchema.parse(weekStart)}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 6); return date.toISOString().slice(0, 10);
}
