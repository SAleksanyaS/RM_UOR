export type Category = 'process' | 'data' | 'architecture' | 'security';
export type Classification = 'demo' | 'corporate';
export type Role = 'reader' | 'curator';
export interface GoalLink { label: string; url: string; kind: string }
export interface GoalMetric { id: string; name: string; unit: string; target: number; direction: 'increase' | 'decrease' }
/** Explicit, executable methodology. Legacy goals omit this configuration. */
export interface GoalMeasurement {
  kind: 'scalar' | 'participant_share' | 'binary' | 'milestones' | 'range' | 'change';
  aggregation: 'single' | 'sum' | 'average'; metrics: GoalMetric[];
  range?: { min: number; max: number };
  change?: { mode: 'absolute' | 'percent'; baseline: number };
}
export interface WorkDirection { id: string; name: string; description: string; color: string; order: number }
export type WorkStage = 'planned' | 'in_progress' | 'blocked' | 'paused' | 'ready_for_review' | 'monitoring';
/** Declared work plan, independent of measured facts and curator confirmation. */
export interface ExecutionPlan {
  stage: WorkStage; plannedStartDate: string | null; targetDate: string | null; forecastDate: string | null;
  nextCheckDate: string | null; nextAction: string; blocker: string; decisionNeeded: string;
  updatedAt: string; updatedBy: string; revision: string;
}
export interface Goal {
  id: string; category: Category; title: string; target: string; metric: string;
  status: string; summary: string; actions: string[]; scopeType: string; links: GoalLink[];
  ownerId: string | null; curatorId: string | null; officialTarget: number | null;
  internalTarget: number | null; unit: string; direction: 'increase' | 'decrease';
  baseline: number | null; weight: number | null; priority: 'high' | 'normal' | 'low' | null;
  dueDate: string | null; revision: string;
  requiredMetricIds?: string[];
  workDirectionId?: string | null;
  plan?: ExecutionPlan;
  measurement?: GoalMeasurement;
}
export interface Leader { id: string; name: string; teams: string[]; clusterName?: string | null }
export interface Assignment {
  id: string; goalId: string; leaderId: string; teams: string[]; agents?: string[];
  participantType?: string; active?: boolean; allProducts?: boolean; target?: string;
  summary?: string; actions?: string[]; metric?: string;
  participantIds?: string[];
  plan?: ExecutionPlan;
}
export interface SourceDefinition {
  /** Read-only UI projection; configuration itself is curator-only. */
  collectionConfigured?:boolean;
  interactiveLogin?:boolean;
  id: string; name: string; kind: 'dashboard' | 'attachment' | 'manual' | 'file' | 'demo';
  url: string | null; accessUrl: string | null; goalIds: string[]; freshnessHours: number;
  mode: 'stub' | 'local'; lastAttemptAt?: string | null;
  collection?: SourceCollection;
  importProfile?: { parser: 'maturity-xlsx-v1'; teamMapping: Record<string, string>; metricMapping: Record<string, string> } | {
    parser: 'tabular-v1'; columns: { period?: string; leader?: string; participant?: string; metric?: string; value: string; target?: string; state?: string; reason?: string; sourceUpdatedAt?: string };
    leaderMapping: Record<string, string>; participantMapping: Record<string, string>; metricMapping: Record<string, string>;
    defaults: { period: string; leaderId?: string | null; participantId?: string; metricId?: string };
  };
}
/** Shared configuration contains references, never credentials or browser profile paths. */
export interface SourceCollection {
  adapter: 'http' | 'confluence' | 'qlik' | 'browser';
  format: 'observations-json' | 'csv' | 'xlsx'; authProfileId: string;
  endpoint?: string; goalId?: string; scenarioId?: string; parameters?: Record<string, string>;
  authenticatedSelector?: string;
  scenario?: { id: string; startUrl: string; steps: SourceBrowserStep[] };
  confluence?: { deployment: 'cloud' | 'datacenter'; downloadUrl: string };
  qlik?: { appId: string; objectId: string; exportFormat: 'CSV_C' | 'CSV_T' | 'OOXML' };
}
export type SourceBrowserStep = { action: 'goto'; url: string } | { action: 'click' | 'wait' | 'download'; selector: string } | { action: 'fill' | 'select'; selector: string; parameter: string } | { action: 'check'; selector: string; checked: boolean };
export interface KnowledgeEntity { id: string; type: string; name: string; leaderId?: string | null; productId?: string | null; aliases?: string[];
  description?: string; body?: string; links?: { label: string; url: string }[]; goalIds?: string[]; revision?: string; archivedAt?: string | null }
export interface GoalComment {
  id: string; goalId: string; leaderId: string | null; text: string; author: string;
  createdAt: string; validUntil: string | null; revision: string;
}
export interface CatalogSnapshot {
  schemaVersion: 1; id: string; name: string; classification: Classification;
  importedAt: string; goals: Goal[]; leaders: Leader[]; assignments: Assignment[];
  sources: SourceDefinition[]; comments: GoalComment[]; entities: KnowledgeEntity[];
  directions?: WorkDirection[];
}
export interface Observation {
  id: string; goalId: string; leaderId: string | null; participantId: string; participantName: string;
  metricId: string; metricName: string; value: number | null; target: number | null; unit: string;
  state: 'numeric' | 'exception' | 'no_events' | 'missing'; reason: string | null;
  period: string; sourceId: string; sourceUpdatedAt: string | null; downloadedAt: string;
}
export interface Evidence { id: string; name: string; relativePath: string; sha256: string; size: number }
/** Rules and cohort captured when facts were accepted, never inferred for older imports. */
export interface SnapshotEvaluationBasis {
  methodVersion: 'participant-all-applicable-metrics-v1' | 'explicit-measurement-v1'; goal: Goal; assignments: Assignment[];
  organization?: { leaders: Leader[]; entities: KnowledgeEntity[]; directions?: WorkDirection[]; comments?: GoalComment[]; sources?: SourceDefinition[] };
}
export interface LocalSnapshot {
  /** Private ownership metadata. Publication packages deliberately omit these fields. */
  ownerSessionId?:string;ownerInstallationId?:string;
  id: string; classification: Classification; sourceId: string; period: string; observations: Observation[];
  collectedAt: string; sourceUpdatedAt: string | null; origin: 'file' | 'manual' | 'demo' | 'dashboard';
  dataHash: string; status: 'personal' | 'validated'; curatorId: string | null; curatorName: string | null;
  validatedAt: string | null; limitations: string[]; evidenceIds: string[];
  evaluationBasis?: SnapshotEvaluationBasis;
}
export type ValidatedSnapshot = LocalSnapshot & { status: 'validated' };
export interface EvaluationInput {
  goal: Goal; observations: Observation[]; period: string; leaderId?: string | null;
  expectedParticipants?: string[]; attestation?: Attestation | null;
  expectedMetricIds?: string[]; scopeRevision?: string;
}
export interface Evaluation {
  id: string; goalId: string; leaderId: string | null; period: string; actual: number | null;
  progress: number | null; officialTarget: number | null; internalTarget: number | null;
  official: 'met' | 'not_met' | 'unknown'; internal: 'met' | 'not_met' | 'unknown';
  validation: 'not_required' | 'pending' | 'confirmed'; fingerprint: string;
  eligibleMetrics: number; metMetrics: number; eligibleParticipants: number; metParticipants: number;
  excluded: number; missing: number; coverage: number | null; qualityFlags: string[];
  snapshotIds?: string[];
}
export interface Attestation {
  id: string; goalId: string; leaderId: string | null; fingerprint: string; period: string;
  curatorId: string; curatorName: string; confirmedAt: string; comment: string | null; evidenceIds: string[];
  invalidatedAt?: string | null; invalidationReason?: string | null;
}
export interface Session { id: string; role: Role; curatorId: string | null; name: string; createdAt: string }
export type CuratorSession = Session & { role: 'curator'; curatorId: string };
export interface CatalogChange { kind: 'goal' | 'assignment' | 'comment' | 'source' | 'entity' | 'direction' | 'leader'; id: string; baseRevision: string | null; patch: Record<string, unknown> }
export interface Draft { id: string; curatorId: string; change: CatalogChange; base: Record<string, unknown> | null; createdAt: string; status: 'local' | 'published'; error: string | null }
export interface DomainChangeEvent {
  id: string; kind: string; objectId: string; objectLabel: string; actor: string; at: string;
  fields: { field: string; before: unknown; after: unknown }[]; operationId?: string;
}
export type OperationKind = 'update' | 'sync' | 'publish' | 'import' | 'confirm' | 'validate' | 'check';
export type OperationStatus = 'running' | 'completed' | 'partial' | 'failed' | 'cancelled' | 'interrupted';
export interface OperationStage { key: string; label: string; completed?: number; total?: number }
export interface OperationResult { status: Exclude<OperationStatus, 'running'>; message: string; details?: string[] }
export interface Operation {
  id: string; kind: OperationKind; label: string; status: OperationStatus; stage: OperationStage;
  startedAt: string; stageStartedAt: string; finishedAt: string | null; result: OperationResult | null;
  events: { id: number; at: string; stage: OperationStage; message: string }[];
}
export interface UpdateSelection { syncPublished: boolean; sourceIds: string[]; recalculate: boolean }
export interface UpdateInfo { status: 'checking' | 'current' | 'available' | 'unavailable'; checkedAt: string | null; currentCommit: string | null; remoteCommit: string | null; message: string; changes: DomainChangeEvent[] }
export interface WorkspaceState {
  catalog: CatalogSnapshot; snapshots: LocalSnapshot[]; attestations: Attestation[]; session: Session;
  evaluations: Evaluation[]; csrfToken: string;
  operations: Operation[]; changes: DomainChangeEvent[]; drafts: Draft[]; updates: UpdateInfo;
  version: string; repository: { url: string; publishedBranch: string; releaseBranch: string; publicationMode: string };
}
