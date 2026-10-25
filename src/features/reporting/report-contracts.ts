import type {MaturityReportData} from './maturity-contracts';
import type { Attestation, Evaluation, ExecutionPlan, GoalComment, LocalSnapshot } from '../../domain/contracts';

export interface ReportSelection { goalIds: string[]; leaderIds: string[]; period: string; baselinePeriod?: string; templateId?: string }
export interface ReportRow {
  goalId: string; goalTitle: string; leaderId: string | null; leaderName: string; unit: string;
  officialTargetLabel?: string;
  officialDueDate: string | null; evaluation: Evaluation; comments: GoalComment[]; plan: ExecutionPlan | null;
  sources: (Pick<LocalSnapshot, 'id' | 'sourceId' | 'period' | 'dataHash' | 'origin' | 'status' | 'collectedAt' | 'sourceUpdatedAt' | 'curatorName' | 'validatedAt' | 'limitations'> & { sourceName: string; sourceUrl: string | null })[];
  confirmation: Attestation | null; availablePeriods: string[];
  historicalBasis?: 'captured' | 'legacy' | 'conflict'; organizationCaptured?: boolean; cohortKey?: string | null;
  decisions?: { id: string; name: string; owner: string; dueDate: string | null; state: string }[];
  workPackages?: { id: string; title: string; owner: string; dueDate: string; baselineDueDate: string | null; completed: boolean; lastEventAt: string | null }[];
}
export interface ReportComparison {
  baselinePeriod: string; rows: { goalId: string; leaderId: string | null; baseline: ReportRow | null; current: ReportRow;
    comparable: boolean; actualDelta: number | null; reason: string;
    changes: { field: string; before: string | null; after: string | null }[] }[];
  dueActions: { goalId: string; leaderId: string | null; action: string; dueDate: string; owner: string }[];
}
export interface ReportSnapshot {
  id: string; createdAt: string; createdBy: string; selection: ReportSelection;
  template: { id: string; version: string; name: string };
  versions: { application: string; catalog: string; facts: string; confirmations: string };
  catalogName: string; classification: string; rows: ReportRow[];
  summary: { goals: number; confirmed: number; pending: number; notMet: number; unknown: number };
  limitations: string[];
  comparison?: ReportComparison;
  maturity?:MaturityReportData;
}
export function reportStatus(row: ReportRow): string {
  if (row.evaluation.official === 'unknown') return 'Нет данных для вывода';
  if (row.evaluation.official === 'not_met') return 'Не выполнено';
  return row.evaluation.validation === 'confirmed' ? 'Подтверждено УОР' : 'Ожидает подтверждения УОР';
}
export const reportNumber = (value: number | null) => value === null ? 'Нет данных' : new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(value);
export const reportOfficialTarget = (row: ReportRow) => row.officialTargetLabel ?? reportNumber(row.evaluation.officialTarget);
