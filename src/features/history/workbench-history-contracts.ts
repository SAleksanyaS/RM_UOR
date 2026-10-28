import type { Capture, ObservedFact, WeeklyPoint } from '../../domain/workbench/entities';
import type { BusinessTime, ExactNumber, MoscowDate, ScopeRef, UtcInstant, UUIDv4, VersionRef } from '../../domain/workbench/primitives';
export type HistorySeriesInput = {
    assignmentRef: VersionRef;
    metricRef: VersionRef;
    mode: 'current' | 'agreed';
    snapshotRef: VersionRef | null;
    granularity: 'day' | 'friday';
    fromInclusive: MoscowDate;
    toExclusive: MoscowDate;
    evaluatedAt: UtcInstant;
    effectiveAt: UtcInstant | null;
    cursor: string | null;
    limit: number;
};
export type DailyPoint = {
    assignmentId: UUIDv4;
    metricId: UUIDv4;
    date: MoscowDate;
    value: ExactNumber | null;
    sourceFactRef: VersionRef | null;
    sourceBusinessTime: BusinessTime | null;
    sourceCapturedAt: UtcInstant | null;
};
export type PeriodHistoryPoint = {
    assignmentId: UUIDv4;
    metricId: UUIDv4;
    businessTime: BusinessTime;
    value: ExactNumber | null;
    sourceFactRef: VersionRef;
    sourceCapturedAt: UtcInstant;
};
export type HistorySeries = {
    mode: 'current' | 'agreed';
    basisRef: VersionRef | null;
    points: Array<DailyPoint | WeeklyPoint | PeriodHistoryPoint>;
    nextCursor: string | null;
    qualityFlags: string[];
};
export type HistoryIndexQuery = {
    assignmentRef: VersionRef;
    metricRef: VersionRef;
    scope: ScopeRef;
    fromInclusive: MoscowDate;
    toExclusive: MoscowDate;
    capturedBefore: UtcInstant;
    cursor: string | null;
    limit: number;
    sourceId?: UUIDv4;
    predecessorBefore?: UtcInstant;
};
export type HistoryIndexPage = {
    facts: ObservedFact[];
    captures: Capture[];
    nextCursor: string | null;
    predecessor?: ObservedFact | null;
    predecessors?: ObservedFact[];
};
