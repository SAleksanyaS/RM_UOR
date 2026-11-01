import type { BusinessTime, Decimal, ExactNumber, Header, ScopeRef, Sha256, UtcInstant, UUIDv4, VersionRef } from '../primitives';

export type RawCell = { kind: 'text' | 'number' | 'boolean' | 'blank'; original: string | null };
export type RawSourceRow = { rowKey: string; cells: Record<string, RawCell> };
export type CanonicalSourceRow = { rowKey: string; dimensions: Record<string, string | null>; numbers: Record<string, Decimal | null>; businessTime: BusinessTime; unitCode: string | null };
export type SourceParsingProfile = { sheetName: string | null; csvDelimiter: ',' | ';' | '\t'; csvEncoding: 'utf8' | 'windows1251'; dateFormat: 'iso' | 'dd.mm.yyyy' | 'excel-serial'; decimalSeparator: '.' | ','; groupSeparator: 'none' | 'space' | 'nbsp' | 'comma' | 'dot' };
export type SourceFieldMapping = Header & {
  sourceId: UUIDv4; rowKeyFields: string[]; dimensionFields: Record<string, string>; productKeyField: string | null; fixedScope: ScopeRef | null;
  metricFields: { metricId: UUIDv4; fields: Record<string, string> }[]; dateField: string | null; periodStartField: string | null; periodEndField: string | null; unitField: string | null; fixedUnitCode: string | null;
  parsingProfile?: SourceParsingProfile;
};
export type SourceDefinition = Header & { goalId: UUIDv4; kind: 'qlik' | 'file' | 'manual_status'; mappingRef: VersionRef | null; publicLocator: string | null; browserScenarioRef?: VersionRef | null };
export type Capture = Header & {
  sourceId: UUIDv4; operationId: UUIDv4; obtainedVia: 'direct' | 'file_import'; capturedAt: UtcInstant; sourceUpdatedAt: UtcInstant | null;
  payloadHash: Sha256; rawArtifactId: UUIDv4 | null; mappingRef: VersionRef; result: 'accepted' | 'partial'; acceptedRows: number; rejectedRows: number;
  rawRows: RawSourceRow[]; canonicalRows: CanonicalSourceRow[];
};
export type Lineage = { captureId: UUIDv4; sourceRowKeys: string[]; mappingRef: VersionRef; directoryLinkRefs: VersionRef[]; inputFactRefs: VersionRef[]; reducerMethodRef: VersionRef | null };
export type ObservedFact = Header & {
  sourceId: UUIDv4; captureId: UUIDv4; metricId: UUIDv4; scope: ScopeRef; businessTime: BusinessTime; sourceUpdatedAt: UtcInstant | null;
  origin: 'source_value' | 'reducer'; state: 'known' | 'missing'; value: ExactNumber | null; missingReason: string | null; unitCode: string; factKey: string; lineage: Lineage;
};
