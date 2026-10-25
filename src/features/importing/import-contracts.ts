import type { Evaluation, Observation } from '../../domain/contracts';

export interface ParsedMaturityRow {
  rowNumber: number; teamName: string; teamCode: string | null; metricName: string;
  value: number | null; target: number | null; state: Observation['state']; reason: string | null;
}
export interface ImportIssue {
  severity: 'error' | 'warning'; code: string; message: string; rowNumber?: number;
}
export interface ParsedMaturityWorkbook {
  sheetName: string; rows: ParsedMaturityRow[]; ignoredRows: number; issues: ImportIssue[];
}
export interface ImportMatch {
  key: string; name: string; code?: string | null; matchedId: string | null;
  status: 'matched' | 'unmapped' | 'ambiguous'; options: { id: string; name: string }[];
}
export interface MaturityImportInput {
  name: string; base64: string; goalId: string; sourceId?: string | null; period: string;
  sourceUpdatedAt?: string | null; teamMapping?: Record<string, string>; metricMapping?: Record<string, string>;
}
export interface MaturityImportPreview {
  id: string; goalId: string; sourceId: string; period: string; fileName: string; fileHash: string;
  createdAt: string; expiresAt: string; canCommit: boolean; duplicateSnapshotId: string | null;
  summary: { rows: number; teams: number; eligibleMetrics: number; excluded: number; missing: number; unmappedTeams: number; unmappedMetrics: number };
  issues: ImportIssue[]; teamMatches: ImportMatch[]; metricMatches: ImportMatch[];
  changes: { added: number; changed: number; removed: number; unchanged: number; baselineSnapshotId: string | null };
  sample: Observation[]; evaluation: Evaluation | null;
  operationId: string;
}
export interface MaturityImportResult { snapshotId: string; duplicate: boolean; operationId: string }
