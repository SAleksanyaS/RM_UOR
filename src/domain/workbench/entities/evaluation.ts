import type { ActorRef, BusinessTime, EvaluationContext, Header, Rational, ScopeRef, Sha256, UtcInstant, UUIDv4, VersionRef, ExactNumber } from '../primitives';
import type { PublicationAnchor } from '../publication';
import type { GoalAssignment, CoreGoalDefinition } from './goals';
import type { MethodVersion, MetricDefinition } from './methods';
import type { Capture, ObservedFact } from './sources';
import type { Applicability, ManualCorrection } from './states';

export type EvaluationBasis = Header & { evaluatedAt: UtcInstant | null; businessTime: EvaluationContext['businessTime']; assignmentRef: VersionRef; goalRef: VersionRef; methodRef: VersionRef; templateRef: VersionRef | null; expectedPopulation: ScopeRef[] | null; factRefs: VersionRef[]; correctionRefs: VersionRef[]; applicabilityRefs: VersionRef[]; directoryLinkRefs: VersionRef[]; digest: Sha256 };
export type NumericEvaluation = { basisRef: VersionRef; calculation: 'ready' | 'preliminary' | 'no_data' | 'not_applicable' | 'blocked'; achievement: 'met' | 'not_met' | 'unknown' | 'not_applicable'; scorePercent: Rational | null; preliminaryPercent: Rational | null; coveragePercent: Rational | null; missingMetricIds: UUIDv4[]; missingPopulation: { metricId: UUIDv4; scope: ScopeRef }[]; complete: boolean; freshness: 'fresh' | 'stale' | 'unknown'; qualityFlags: string[]; canConfirm: boolean };
export type CalculationResult = Header & NumericEvaluation;
export type Attestation = Header & { basisDigest: Sha256; comment: string; evidenceIds: UUIDv4[] };
export type AgreedSnapshot = Header & { basisRef: VersionRef; numericResult: NumericEvaluation | null; manualStatusRef: VersionRef | null; attestationRef: VersionRef | null };
export type WeeklyPoint = { assignmentId: UUIDv4; metricId: UUIDv4; friday: string; value: ExactNumber | null; sourceFactRef: VersionRef | null; sourceBusinessTime: BusinessTime | null; sourceCapturedAt: UtcInstant | null; carried: boolean; warning: 'Данные не обновлялись' | null };
export type EvaluationInput = { assignment: GoalAssignment; goal: CoreGoalDefinition; method: MethodVersion; facts: ObservedFact[]; captures: Capture[]; metrics: MetricDefinition[]; applicability: Applicability[]; corrections: ManualCorrection[]; context: EvaluationContext; resolution: { basisRef: VersionRef; templateRef: VersionRef | null; directoryLinkRefs: VersionRef[]; publicationAnchors: PublicationAnchor[]; actor: ActorRef } };
export type PrepareEvaluationRequest = { assignmentRef: VersionRef; businessTime: EvaluationContext['businessTime'] };
