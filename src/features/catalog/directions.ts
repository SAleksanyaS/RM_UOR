import type { CatalogSnapshot, Goal, WorkDirection } from '../../domain/contracts';

/** Names follow the six subject slides of the supplied technology agenda. */
export const DEFAULT_DIRECTIONS: readonly WorkDirection[] = [
  { id: 'architecture', name: 'Архитектура', description: 'Архитектурные цели технологической повестки.', color: '#6864c5', order: 1 },
  { id: 'production', name: 'Производственный процесс', description: 'Практики и качество производственного процесса.', color: '#267b72', order: 2 },
  { id: 'technical-debt', name: 'Управление технологическим долгом', description: 'Технологический долг и устранение дефектов.', color: '#b57732', order: 3 },
  { id: 'data', name: 'Данные', description: 'Цели в области данных.', color: '#3c78aa', order: 4 },
  { id: 'metla', name: 'МЕТЛА', description: 'Цели программы МЕТЛА.', color: '#ae5a82', order: 5 },
  { id: 'resources', name: 'Тарифные модели ИТ и SberInfra', description: 'Тарифные модели ИТ и SberInfra. Цели назначаются куратором.', color: '#667486', order: 6 },
];

export function getDirections(catalog: Pick<CatalogSnapshot, 'directions'>): WorkDirection[] {
  return (catalog.directions ?? DEFAULT_DIRECTIONS).map(item => ({ ...item })).sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
/** Explicit null is a curator decision; ambiguous security goals stay unassigned. */
export function getGoalDirectionId(goal: Goal): string | null {
  if (goal.workDirectionId !== undefined) return goal.workDirectionId;
  if (/^MT26(?:[.-]|$)/i.test(goal.id) || /МЕТЛА/i.test(goal.title)) return 'metla';
  if (goal.id === 'SW26.2') return 'technical-debt';
  return ({ architecture: 'architecture', data: 'data', process: 'production', security: null } as const)[goal.category];
}
/** Deterministic compatibility migration; never replaces an explicitly saved taxonomy. */
export function normalizeDirections(catalog: CatalogSnapshot): CatalogSnapshot {
  const legacy = catalog.directions === undefined;
  return { ...catalog, directions: getDirections(catalog), goals: catalog.goals.map(goal => ({ ...goal,
    workDirectionId: goal.workDirectionId !== undefined ? goal.workDirectionId : legacy ? getGoalDirectionId(goal) : null })) };
}
