import type { Evaluation, Observation, SourceDefinition } from '../../domain/contracts';
export type TabularImportProfile = Extract<NonNullable<SourceDefinition['importProfile']>, { parser: 'tabular-v1' }>;
export type ColumnRole = keyof TabularImportProfile['columns'];
export interface TableRow { rowNumber: number; cells: string[] }
export interface ParsedTable { columns: string[]; rows: TableRow[] }
export interface TabularFileInput { name: string; base64: string; goalId: string; sourceId?: string | null }
export interface TabularPreviewInput extends TabularFileInput { profile: TabularImportProfile; sourceUpdatedAt?: string | null }
export interface ImportOption { id: string; name: string }
export interface TabularProbe extends ParsedTable {
  sourceId: string; profile: TabularImportProfile;
  columnValues: Record<string, string[]>;
  options: { leaders: ImportOption[]; participants: ImportOption[]; metrics: ImportOption[] };
}
export interface TabularIssue { severity: 'error' | 'warning'; code: string; message: string; rowNumber?: number }
export interface TabularPreview {
  id: string; sourceId: string; period: string; expiresAt: string; canCommit: boolean; duplicateSnapshotId: string | null;
  issues: TabularIssue[]; sample: Observation[]; evaluations: Evaluation[]; rows: number; facts: number;
}
export interface TabularResult { snapshotId: string; duplicate: boolean; operationId: string }
