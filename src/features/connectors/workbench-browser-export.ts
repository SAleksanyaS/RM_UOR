import { createHash } from 'node:crypto';
import { browserScenarioDefinitionSchema, type BrowserScenarioDefinition } from '../../domain/workbench/browser-scenario';
import type { SourceParsingProfile } from '../../domain/workbench/entities/sources';
import { assertFileName, defaultFileLimits } from '../../server/workbench/files';
import { WorkbenchHttpError } from '../../server/workbench/protocol';
import { parseWorkbenchTable, WorkbenchParserError, type ParsedSourceTable } from '../tabular-import/workbench-parser';
import type { BrowserReplayInput, BrowserRuntimePort } from './workbench-browser-runtime';
import type { Downloaded } from './transport';

const changed = () => new WorkbenchHttpError(422, 'SOURCE_SCHEMA_CHANGED', 'The downloaded export does not match the saved table contract');

/** Inert export validation only. A readable table does not establish population coverage. */
export async function validateBrowserExport(input: { download: Downloaded; scenario: BrowserScenarioDefinition; parsingProfile: SourceParsingProfile }): Promise<{ table: ParsedSourceTable; payloadHash: string }> {
  const scenario = browserScenarioDefinitionSchema.safeParse(input.scenario);
  if (!scenario.success) throw changed();
  const { name, bytes: downloadedBytes } = input.download;
  try { assertFileName(name); } catch { throw changed(); }
  if (!(downloadedBytes instanceof Uint8Array) || !downloadedBytes.length || downloadedBytes.length > defaultFileLimits.goalImportBytes) throw changed();
  const format = /\.csv$/i.test(name) ? 'csv' : /\.xlsx$/i.test(name) ? 'xlsx' : null;
  if (format !== scenario.data.expectedExport.format) throw changed();
  // Bind both parsed cells and the hash to one private snapshot of the original download.
  const bytes = Buffer.from(downloadedBytes);
  let table: ParsedSourceTable;
  try { table = await parseWorkbenchTable({ bytes, name, parsingProfile: input.parsingProfile }); }
  catch (error) { if (error instanceof WorkbenchParserError) throw changed(); throw error; }
  if (scenario.data.expectedExport.requiredColumns.some(column => !table.columns.includes(column))) throw changed();
  return { table, payloadHash: createHash('sha256').update(bytes).digest('hex') };
}

export function createBrowserExportPreview({ runtime }: { runtime: BrowserRuntimePort }) {
  return {
    async run(input: BrowserReplayInput & { parsingProfile: SourceParsingProfile }, signal: AbortSignal): Promise<{ table: ParsedSourceTable; payloadHash: string; name: string }> {
      signal.throwIfAborted();
      const { parsingProfile, ...replayInput } = input;
      const download = await runtime.replay(replayInput, signal);
      signal.throwIfAborted();
      const name = download.name, result = await validateBrowserExport({ download, scenario: replayInput.scenario, parsingProfile });
      signal.throwIfAborted();
      return { ...result, name };
    },
  };
}
