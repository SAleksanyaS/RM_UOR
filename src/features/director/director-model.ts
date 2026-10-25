import type { CatalogSnapshot, DomainChangeEvent, ExecutionPlan } from '../../domain/contracts';
import { decisionEntitySchema, type DecisionEntity } from './decision-schema';
export interface DeadlineItem { id: string; goalId: string; goalTitle: string; leaderId: string | null; scopeName: string; date: string; kind: 'official' | 'commitment' | 'forecast' | 'check'; label: string; officialDate: string | null; nextAction: string; overdue: boolean }
export function buildDirectorModel(catalog: CatalogSnapshot, changes: DomainChangeEvent[], now = new Date().toISOString()) {
  const today = now.slice(0, 10), end = new Date(`${today}T00:00:00Z`); end.setUTCDate(end.getUTCDate() + 30);
  const until = end.toISOString().slice(0, 10), weekFrom = new Date(Date.parse(now) - 7 * 86400_000).toISOString();
  const timeline: DeadlineItem[] = [];
  const requests: { goalId: string; goalTitle: string; leaderId: string | null; scopeName: string; text: string }[] = [];
  for (const goal of catalog.goals) {
    const scopes: { leaderId: string | null; scopeName: string; plan?: ExecutionPlan }[] = [{ leaderId: null, scopeName: 'Общий план ДИТ', plan: goal.plan },
      ...catalog.assignments.filter(item => item.goalId === goal.id && item.active !== false).map(item => ({ leaderId: item.leaderId, scopeName: catalog.leaders.find(leader => leader.id === item.leaderId)?.name ?? 'ИТ-лидер не найден', plan: item.plan }))];
    if (goal.dueDate && goal.dueDate <= until) timeline.push({ id: `${goal.id}:official`, goalId: goal.id, goalTitle: goal.title, leaderId: null, scopeName: 'ДИТ', date: goal.dueDate, kind: 'official', label: 'Официальный срок', officialDate: goal.dueDate, nextAction: '', overdue: goal.dueDate < today });
    for (const scope of scopes) {
      const { plan } = scope;
      if (plan?.decisionNeeded) requests.push({ goalId: goal.id, goalTitle: goal.title, leaderId: scope.leaderId, scopeName: scope.scopeName, text: plan.decisionNeeded });
      for (const [date, kind, label] of [[plan?.targetDate, 'commitment', 'Обязательство'], [plan?.forecastDate, 'forecast', 'Прогноз куратора'], [plan?.nextCheckDate, 'check', 'Следующая проверка']] as const) {
        if (date && date <= until) timeline.push({ id: `${goal.id}:${scope.leaderId ?? 'dit'}:${kind}`, goalId: goal.id, goalTitle: goal.title, leaderId: scope.leaderId, scopeName: scope.scopeName, date, kind, label, officialDate: goal.dueDate, nextAction: plan?.nextAction ?? '', overdue: date < today });
      }
    }
  }
  timeline.sort((a, b) => a.date.localeCompare(b.date) || a.goalTitle.localeCompare(b.goalTitle, 'ru') || a.id.localeCompare(b.id));
  const parsed = catalog.entities.filter(entity => entity.type === 'decision').map(entity => decisionEntitySchema.safeParse(entity));
  const decisions = parsed.flatMap(result => result.success ? [result.data] : []).sort((a, b) => a.state.localeCompare(b.state) || (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999')) as DecisionEntity[];
  return { today, until, timeline, upcoming: timeline.filter(item => !item.overdue), overdue: timeline.filter(item => item.overdue), requests, decisions, invalidDecisions: parsed.filter(result => !result.success).length,
    digest: { from: weekFrom, to: now, events: changes.filter(event => Date.parse(event.at) >= Date.parse(weekFrom) && Date.parse(event.at) < Date.parse(now)).sort((a, b) => Date.parse(b.at) - Date.parse(a.at)) } };
}
