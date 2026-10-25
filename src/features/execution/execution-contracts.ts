import type { KnowledgeEntity, Goal, Evaluation } from '../../domain/contracts';
export interface CompletionEvent { id: string; at: string; completed: boolean; comment: string; evidence: string; actor: string }
export interface Baseline { at: string; dueDate: string; weight: number; effortHours: number | null }
export interface WorkPackage { id: string; goalId: string; leaderId: string | null; title: string; owner: string; dueDate: string; weight: number; effortHours: number | null; dependencies: string[]; revision: string; baseline: Baseline | null; events: CompletionEvent[] }
export interface RetentionCheck { id: string; at: string; actor: string; comment: string; evidence: string; result: 'stable' | 'regression' | 'unknown' }
export interface ExecutionConfig { id: string; goalId: string; leaderId: string | null; revision: string; capacityHours: number | null; capacityPeriod: string; criticalService: string; product: string; mandatoryRequirement: string; cadenceDays: number | null; nextCheckDate: string | null; checks: RetentionCheck[] }
export type WorkPackageRecord = KnowledgeEntity & { type: 'work_package'; body: string; revision: string };
export type ExecutionConfigRecord = KnowledgeEntity & { type: 'execution_config'; body: string; revision: string };
export interface PackageInput { id?: string; goalId: string; leaderId: string | null; baseRevision: string | null; title: string; owner: string; dueDate: string; weight: number; effortHours: number | null; dependencies: string[] }
export interface ConfigInput { id?: string; goalId: string; leaderId: string | null; baseRevision: string | null; capacityHours: number | null; capacityPeriod: string; criticalService: string; product: string; mandatoryRequirement: string; cadenceDays: number | null; nextCheckDate: string | null }
export interface Forecast { date: string | null; sampleCount: number; ratePerDay: number | null; reason: string; formula: string }
export interface InboxItem { id: string; goalId: string | null; leaderId: string | null; category: 'achievement' | 'facts' | 'configuration' | 'plan' | 'forecast' | 'retention' | 'draft' | 'source'; title: string; detail: string; overdue?: boolean }
export interface ExecutionView { packages: WorkPackage[]; configs: ExecutionConfig[]; forecasts: { goalId: string; leaderId: string | null; forecast: Forecast }[]; inbox: InboxItem[]; weighted: ReturnType<typeof import('./execution-model').weightedAchievement> }
export type WeightedInput = { goals: Goal[]; evaluations: Evaluation[] };
