import type { CatalogSnapshot, Category, Goal, GoalMeasurement, GoalMetric, SourceDefinition } from '../../domain/contracts';
import type { GoalSetupInput } from './goal-setup-contracts';

export const measurementLabels: Record<GoalMeasurement['kind'], { name: string; description: string }> = {
  scalar: { name: 'Числовой показатель', description: 'Значение, сумма или среднее по выбранному составу.' },
  participant_share: { name: 'Доля успешных команд', description: 'Команда выполняет все применимые показатели.' },
  binary: { name: 'Да / нет', description: 'Измеримый результат: 1 — да, 0 — нет.' },
  milestones: { name: 'Завершение вех', description: 'Доля завершённых контрольных результатов.' },
  range: { name: 'Допустимый диапазон', description: 'Значение должно находиться между двумя границами.' },
  change: { name: 'Изменение от базы', description: 'Абсолютное или процентное изменение исходного значения.' },
};
export interface SetupForm {
  requestId: string; goalId?: string; baseRevision?: string; title: string; summary: string; category: Category;
  ownerId: string; curatorId: string; dueDate: string; workDirectionId: string; weight: string; priority: '' | 'high' | 'normal' | 'low';
  officialTarget: string; internalTarget: string; unit: string; direction: 'increase' | 'decrease'; baseline: string;
  kind: GoalMeasurement['kind']; aggregation: GoalMeasurement['aggregation']; metrics: GoalMetric[];
  rangeMin: string; rangeMax: string; changeMode: 'absolute' | 'percent'; changeBaseline: string;
  selectedLeaders: string[]; participants: Record<string, string[]>; globalGoal: boolean;
  existingSourceId: string; sourceKind: SourceDefinition['kind']; sourceName: string; sourceUrl: string; accessUrl: string; freshnessHours: string;
  period: string; samples: { leaderId: string | null; participantId: string; metricId: string; value: string; state: 'numeric' | 'missing' | 'exception' | 'no_events'; reason: string }[];
}
const number = (value: string) => Number(value.trim().replace(',', '.'));
const optionalNumber = (value: string) => value.trim() ? number(value) : null;
export function createSetupForm(catalog: CatalogSnapshot, curator: string, goal?: Goal): SetupForm {
  const assignments = goal ? catalog.assignments.filter(item => item.goalId === goal.id && item.active !== false) : [];
  const source = goal ? catalog.sources.find(item => item.goalIds.includes(goal.id)) : undefined;
  return { requestId: crypto.randomUUID(), ...(goal ? { goalId: goal.id, baseRevision: goal.revision } : {}), title: goal?.title || '', summary: goal?.summary || '',
    category: goal?.category || 'process', ownerId: goal?.ownerId || '', curatorId: goal?.curatorId || curator, dueDate: goal?.dueDate || '',
    workDirectionId: goal?.workDirectionId || '', weight: goal?.weight == null ? '' : String(goal.weight), priority: goal?.priority || '',
    officialTarget: goal?.officialTarget == null ? '' : String(goal.officialTarget), internalTarget: goal?.internalTarget == null ? '' : String(goal.internalTarget),
    unit: goal?.unit || '%', direction: goal?.direction || 'increase', baseline: goal?.baseline == null ? '' : String(goal.baseline),
    kind: goal?.measurement?.kind || 'scalar', aggregation: goal?.measurement?.aggregation || 'single',
    metrics: structuredClone(goal?.measurement?.metrics || [{ id: 'main', name: 'Основной показатель', unit: goal?.unit || '%', target: goal?.officialTarget ?? 100, direction: goal?.direction || 'increase' }]),
    rangeMin: goal?.measurement?.range ? String(goal.measurement.range.min) : '', rangeMax: goal?.measurement?.range ? String(goal.measurement.range.max) : '',
    changeMode: goal?.measurement?.change?.mode || 'absolute', changeBaseline: goal?.measurement?.change ? String(goal.measurement.change.baseline) : '',
    selectedLeaders: assignments.map(item => item.leaderId), participants: Object.fromEntries(assignments.map(item => [item.leaderId, item.participantIds || []])), globalGoal: goal?.scopeType === 'global',
    existingSourceId: source?.id || '', sourceKind: source?.kind || 'manual', sourceName: source?.name || '', sourceUrl: source?.url || '', accessUrl: source?.accessUrl || '', freshnessHours: String(source?.freshnessHours || 168),
    period: new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()), samples: [] };
}
export function setupStepError(step: number, form: SetupForm, catalog: CatalogSnapshot): string | null {
  if (step === 0) {
    if (!form.title.trim()) return 'Укажите полное русское название цели.';
    if (!form.ownerId.trim()) return 'Укажите владельца цели.';
    if (!form.curatorId.trim()) return 'Укажите куратора УОР.';
  }
  if (step === 1) {
    if (form.kind !== 'range' && (form.officialTarget.trim() === '' || !Number.isFinite(number(form.officialTarget)))) return 'Укажите числовое официальное целевое значение.';
    if (form.internalTarget.trim() && !Number.isFinite(number(form.internalTarget))) return 'Внутреннее целевое значение должно быть числом.';
    if (!form.metrics.length || form.metrics.some(metric => !metric.name.trim() || !Number.isFinite(metric.target))) return 'У каждого показателя должны быть название и числовой порог.';
    if (form.kind === 'range' && (!form.rangeMin.trim() || !form.rangeMax.trim() || !Number.isFinite(number(form.rangeMin)) || !Number.isFinite(number(form.rangeMax)) || number(form.rangeMin) > number(form.rangeMax))) return 'Проверьте нижнюю и верхнюю границы диапазона.';
    if (form.kind === 'change' && (!form.changeBaseline.trim() || !Number.isFinite(number(form.changeBaseline)) || (form.changeMode === 'percent' && number(form.changeBaseline) === 0))) return 'Укажите базу; для процентного изменения она не может быть нулевой.';
  }
  if (step === 2) {
    if (form.globalGoal && form.kind === 'participant_share') return 'Для доли команд задайте ответственных и точный состав команд.';
    if (form.globalGoal) return null;
    if (!form.selectedLeaders.length) return 'Выберите хотя бы одного ответственного ИТ-лидера.';
    if (form.selectedLeaders.some(id => !catalog.leaders.some(item => item.id === id))) return 'Состав ИТ-лидеров изменился. Проверьте назначения.';
    if (form.kind === 'participant_share' && form.selectedLeaders.some(id => !form.participants[id]?.length)) return 'Выберите команды для каждого назначенного ИТ-лидера.';
  }
  if (step === 3 && !form.existingSourceId) {
    if (!Number.isFinite(number(form.freshnessHours)) || number(form.freshnessHours) <= 0) return 'Укажите положительный срок актуальности в часах.';
    for (const [label, value] of [['Источник', form.sourceUrl], ['Оформление доступа', form.accessUrl]]) if (value.trim()) {
      try { if (!['http:', 'https:'].includes(new URL(value).protocol)) return `${label}: используйте адрес https://…`; }
      catch { return `${label}: укажите полный корректный адрес.`; }
    }
  }
  if (step === 4 && form.samples.some(row => row.state === 'numeric' && (!row.value.trim() || !Number.isFinite(number(row.value))))) return 'Заполните числовые проверочные значения или выберите «Нет данных».';
  return null;
}
export function makeSetupInput(form: SetupForm, _catalog: CatalogSnapshot): GoalSetupInput {
  const measurement: GoalMeasurement = { kind: form.kind,
    aggregation: ['participant_share', 'milestones'].includes(form.kind) ? 'average' : form.kind === 'binary' ? 'single' : form.aggregation,
    metrics: form.metrics.map(metric => ['participant_share', 'milestones'].includes(form.kind) ? { ...metric } : { ...metric,
      unit: form.kind === 'binary' ? '' : form.unit, target: form.kind === 'range' ? number(form.rangeMax) : optionalNumber(form.officialTarget) ?? metric.target,
      direction: form.direction }) };
  if (form.kind === 'range') measurement.range = { min: number(form.rangeMin), max: number(form.rangeMax) };
  if (form.kind === 'change') measurement.change = { mode: form.changeMode, baseline: number(form.changeBaseline) };
  return { requestId: form.requestId, ...(form.goalId ? { goalId: form.goalId, baseRevision: form.baseRevision } : {}),
    goal: { title: form.title.trim(), summary: form.summary.trim(), category: form.category, ownerId: form.ownerId.trim(), curatorId: form.curatorId.trim(),
      dueDate: form.dueDate || null, workDirectionId: form.workDirectionId || null, weight: optionalNumber(form.weight), priority: form.priority || null,
      officialTarget: form.kind === 'range' ? null : optionalNumber(form.officialTarget), internalTarget: form.kind === 'range' ? null : optionalNumber(form.internalTarget),
      unit: ['participant_share', 'milestones'].includes(form.kind) || (form.kind === 'change' && form.changeMode === 'percent') ? '%' : form.kind === 'binary' ? '' : form.unit,
      direction: form.direction, baseline: optionalNumber(form.baseline), metric: form.metrics.map(item => item.name).join('; '), scopeType: form.globalGoal ? 'global' : 'assigned' }, measurement,
    assignments: form.globalGoal ? [] : form.selectedLeaders.map(leaderId => ({ leaderId, participantIds: form.kind === 'participant_share' ? [...(form.participants[leaderId] || [])] : [leaderId] })),
    source: form.existingSourceId ? { existingSourceId: form.existingSourceId } : { kind: form.sourceKind, name: form.sourceName.trim() || `Данные по цели «${form.title.trim()}»`, url: form.sourceUrl.trim() || null, accessUrl: form.accessUrl.trim() || null, freshnessHours: number(form.freshnessHours) },
    sample: { period: form.period, rows: form.samples.map(row => ({ leaderId: row.leaderId, participantId: row.participantId, metricId: row.metricId,
      value: row.state === 'numeric' ? optionalNumber(row.value) : null, state: row.state, reason: row.reason.trim() || null })) } };
}
