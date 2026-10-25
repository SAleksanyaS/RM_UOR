import type { CatalogSnapshot, UpdateSelection } from '../../domain/contracts';
export interface UpdatePlan { syncPublished: boolean; sourceIds: string[]; recalculate: boolean }
export function planUpdate(selection: UpdateSelection, catalog: CatalogSnapshot): UpdatePlan {
  const sourceIds = [...new Set(selection.sourceIds)];
  const known = new Set(catalog.sources.map(source => source.id));
  const unknown = sourceIds.filter(id => !known.has(id));
  if (unknown.length) throw new Error(`Неизвестный источник: ${unknown.join(', ')}`);
  if (!selection.syncPublished && !sourceIds.length && !selection.recalculate) throw new Error('Выберите данные УОР, источник или пересчет');
  return { syncPublished: selection.syncPublished, sourceIds, recalculate: selection.recalculate };
}
