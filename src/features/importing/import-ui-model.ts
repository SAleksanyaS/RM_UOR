import type { Goal, LocalSnapshot, SourceDefinition } from '../../domain/contracts';

export const MAX_IMPORT_FILE_BYTES = 10 * 1024 * 1024;
export function canImportMaturityGoal(goal: Goal, sources: SourceDefinition[], snapshots: LocalSnapshot[]) {
  return sources.some(source => source.goalIds.includes(goal.id) && (source as SourceDefinition & { importProfile?: { parser?: string } }).importProfile?.parser === 'maturity-xlsx-v1')
    || !!goal.requiredMetricIds?.length
    || snapshots.some(snapshot => snapshot.observations.some(observation => observation.goalId === goal.id && observation.metricId !== goal.id));
}
export function validateImportFile(file: Pick<File, 'name' | 'size'>) {
  if (!/\.xlsx$/i.test(file.name)) return 'Выберите файл Excel в формате XLSX.';
  if (file.size <= 0) return 'Выбран пустой файл.';
  if (file.size > MAX_IMPORT_FILE_BYTES) return 'Файл больше 10 МБ. Сохраните выгрузку меньшего размера.';
  return null;
}
export function validReportingDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
