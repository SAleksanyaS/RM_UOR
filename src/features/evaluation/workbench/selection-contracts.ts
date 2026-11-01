import type { ExactNumber, ScopeRef, UUIDv4, VersionRef } from '../../../domain/workbench/primitives';

export type Freshness = 'fresh' | 'stale' | 'unknown';
export type SelectedMetric = { metricRef: VersionRef; applicable: boolean; value: ExactNumber | null; factRefs: VersionRef[]; correctionRefs: VersionRef[]; applicabilityRefs: VersionRef[]; missingPopulation: Array<{ metricId: UUIDv4; scope: ScopeRef }>; freshness: Freshness; qualityFlags: string[] };
export type FactSelection = { metrics: SelectedMetric[]; factRefs: VersionRef[]; correctionRefs: VersionRef[]; applicabilityRefs: VersionRef[]; missingMetricIds: UUIDv4[]; missingPopulation: Array<{ metricId: UUIDv4; scope: ScopeRef }>; complete: boolean; freshness: Freshness; qualityFlags: string[] };
