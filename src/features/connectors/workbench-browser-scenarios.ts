import { createHash } from 'node:crypto';
import { z } from 'zod';
import { browserScenarioDefinitionSchema, type BrowserScenarioDefinition } from '../../domain/workbench/browser-scenario';
import type { CoreGoalDefinition, GoalAssignment, SourceDefinition, SourceFieldMapping, DirectoryEntity, DirectoryLink } from '../../domain/workbench/entities';
import type { Clock, EntityRef, Header, Sha256, UUIDv4, VersionRef } from '../../domain/workbench/primitives';
import { entityRefSchema, sha256Schema, utcInstantSchema, uuidSchema, versionRefSchema } from '../../domain/workbench/primitives';
import { goalAssignmentSchema, sourceDefinitionSchema, sourceFieldMappingSchema, templateSchema, methodVersionSchema, metricDefinitionSchema, directoryEntitySchema, directoryLinkSchema } from '../../domain/workbench/schemas';
import type { WorkbenchRepository } from '../../server/storage/workbench-repository';
import type { CommandContext } from '../../server/workbench/command-registry';
import { commitCommandEffect, stableJson } from '../../server/workbench/command-store';
import { assertFileName, defaultFileLimits } from '../../server/workbench/files';
import { fieldProblemSchema, fieldProblems, WorkbenchHttpError, type FieldProblem } from '../../server/workbench/protocol';
import { businessDefinition, type DraftService, type DraftSaveResult, type PartialDraftInput, type DraftDirectoryInventory } from '../catalog/workbench-drafts';
import type { StoredDraft } from '../catalog/workbench-draft-store';
import { parseWorkbenchTable, WorkbenchParserError } from '../tabular-import/workbench-parser';
import type { BrowserProfileService } from './workbench-browser-profile';
import { normalizeParsedWorkbenchTable } from './workbench-source-normalizer';
import { enrichmentResultSchema, validateSourceConfiguration, type BrowserScenarioRuntimePort, type BrowserExportEvidence, type EnricherPort } from './workbench-source-contracts';
import { enrichSourceRows } from '../catalog/workbench-directory';
import { canUseCapability } from '../identity/workbench-access-policy';
import { ConnectorError } from './contracts';

export const browserScenarioTestResultSchema = z.strictObject({ draftId: uuidSchema, scenarioRef: entityRefSchema, inputHash: sha256Schema, downloadedBytes: z.number().int().nonnegative(), acceptedPreviewRows: z.number().int().nonnegative(), rejectedPreviewRows: z.number().int().nonnegative(), complete: z.boolean(), problems: z.array(fieldProblemSchema) });
export type BrowserScenarioTestResult = z.infer<typeof browserScenarioTestResultSchema>;
export interface BrowserScenarioService {
  save(context: CommandContext, input: { draftId: UUIDv4; definition: PartialDraftInput<BrowserScenarioDefinition> }): Promise<DraftSaveResult>;
  test(context: CommandContext, input: { draftId: UUIDv4 }): Promise<BrowserScenarioTestResult>;
  resolvePublished(sourceRef: VersionRef): BrowserScenarioDefinition;
}
const ref = (entityType: string, value: Header): VersionRef => ({ entityType, id: value.id, revision: value.revision });
const hash = (value: unknown): Sha256 => 'sha256:' + createHash('sha256').update(stableJson(value)).digest('hex');
const problem = (code: string, path = '', ref: EntityRef | null = null): FieldProblem => ({ code, path, ref, message: code });
const fail = (code: string, status = 422): never => { throw new WorkbenchHttpError(status, code, code); };
const same = (a: unknown, b: unknown) => stableJson(a) === stableJson(b);
const evidenceSchema = z.strictObject({ owner: z.strictObject({ installationId: uuidSchema, profilePersonId: uuidSchema.nullable() }), sourceRef: versionRefSchema, mappingRef: versionRefSchema, scenarioHash: sha256Schema, payloadHash: sha256Schema, publishedAssignment: versionRefSchema.refine(v => v.entityType === 'goal_assignment'), observedAt: utcInstantSchema, expiresAt: utcInstantSchema, selectionVerified: z.boolean(), allPagesExported: z.boolean(), reportedRows: z.number().int().nonnegative() });
type Binding = { source: SourceDefinition; mapping: SourceFieldMapping & { parsingProfile: NonNullable<SourceFieldMapping['parsingProfile']> }; goal: CoreGoalDefinition; directory: DraftDirectoryInventory | null; configurationHash: Sha256 };
type TestReceipt = { inputHash: Sha256; configurationHash: Sha256 | null; payloadHash: Sha256 | null; assignmentHash: Sha256 | null; evidence: BrowserExportEvidence | null; result: BrowserScenarioTestResult; expiresAt: string };

/** Preview diagnostics are private append-only receipts, never source captures or portable entities. */
export function createBrowserScenarioService({ repository, drafts, runtime, profiles, parser, enricher, clock }: {
  repository: WorkbenchRepository; drafts: DraftService; runtime: BrowserScenarioRuntimePort; profiles: BrowserProfileService; parser: typeof parseWorkbenchTable; enricher: EnricherPort; clock: Clock;
}): BrowserScenarioService {
  const sql = repository.sqlForModule('browser_scenarios', { trackStateRevision: false });
  sql.execMigration('v1', `CREATE TABLE wb_browser_scenarios_tests(sequence INTEGER PRIMARY KEY AUTOINCREMENT, installation_id TEXT NOT NULL, person_id TEXT NOT NULL, command_id TEXT NOT NULL, draft_id TEXT NOT NULL, receipt_json TEXT NOT NULL, UNIQUE(installation_id,command_id)); CREATE INDEX wb_browser_scenarios_tests_draft ON wb_browser_scenarios_tests(installation_id,person_id,draft_id,sequence);`);
  const published = <T extends Header>(value: T | null): T => {
    if (!value?.publicationAnchorId || repository.readPublicationAnchor({ entityType: 'publication_anchor', id: value.publicationAnchorId })?.publicationState !== 'confirmed') return fail('REFERENCE_NOT_PUBLISHED', 409); return value;
  };
  const semantic = (type: string, value: Header) => ({ ref: ref(type, value), definition: businessDefinition(value) });
  const inputHash = (entry: StoredDraft) => hash({ scenarioRef: entry.versionRef, definition: entry.definition });
  const directoryDefinition = (inventory: DraftDirectoryInventory | null) => inventory === null ? null : [...inventory.entities.map(value => semantic('directory_entity', directoryEntitySchema.parse(value))), ...inventory.links.map(value => semantic('directory_link', directoryLinkSchema.parse(value)))].sort((a, b) => stableJson(a.ref).localeCompare(stableJson(b.ref)));
  const ownDirectory = (context: CommandContext, entry: StoredDraft): DraftDirectoryInventory => {
    const values = new Map(repository.readPublishedCatalog().filter(v => ['directory_entity','directory_link'].includes(v.entityType)).map(v => [`${v.entityType}/${v.value.id}`, v]));
    for (const draft of drafts.readOwnPackage(context, entry.packageId).entries) if (['directory_entity','directory_link'].includes(draft.entityRef.entityType)) values.set(`${draft.entityRef.entityType}/${draft.entityRef.id}`, { entityType: draft.entityRef.entityType, value: drafts.resolveOwnReference(context, entry.packageId, draft.entityRef) });
    return { entities: [...values.values()].filter(v => v.entityType === 'directory_entity').map(v => v.value as DirectoryEntity), links: [...values.values()].filter(v => v.entityType === 'directory_link').map(v => v.value as DirectoryLink) };
  };
  const binding = (scenario: BrowserScenarioDefinition, read: (ref: EntityRef | VersionRef) => Header | null, directory: DraftDirectoryInventory | null = null): Binding => {
    const sourceValue = read({ entityType: 'source_definition', id: scenario.sourceId });
    if (!sourceValue) return fail('SOURCE_REQUIRED'); const source = sourceDefinitionSchema.parse(sourceValue);
    if (!source.browserScenarioRef) return fail('SOURCE_SCENARIO_REQUIRED');
    if (source.kind !== 'qlik' || source.browserScenarioRef && (source.browserScenarioRef.id !== scenario.id || source.browserScenarioRef.revision !== scenario.revision)) return fail('SOURCE_SCENARIO_MISMATCH');
    if (!source.mappingRef) return fail('SOURCE_MAPPING_REQUIRED');
    const mappingValue = read(source.mappingRef); if (!mappingValue) return fail('SOURCE_MAPPING_REQUIRED');
    const mapping = sourceFieldMappingSchema.parse(mappingValue);
    if (mapping.sourceId !== source.id || mapping.id !== source.mappingRef.id || mapping.revision !== source.mappingRef.revision) return fail('SOURCE_MAPPING_MISMATCH');
    const goal = read({ entityType: 'core_goal_definition', id: source.goalId }) as CoreGoalDefinition | null;
    if (!goal || goal.sourceId !== source.id || goal.mode !== 'numeric') return fail('GOAL_SOURCE_MISMATCH');
    return { source, mapping, goal, directory, configurationHash: hash({ source: semantic('source_definition', source), mapping: semantic('source_field_mapping', mapping), goal: semantic('core_goal_definition', goal), directory: directoryDefinition(directory) }) };
  };
  const ownRead = (context: CommandContext, entry: StoredDraft) => (target: EntityRef | VersionRef): Header | null => {
    const pkg = drafts.readOwnPackage(context, entry.packageId);
    const local = pkg.entries.find(e => e.entityRef.entityType === target.entityType && e.entityRef.id === target.id);
    const value = drafts.resolveOwnReference(context, entry.packageId, target);
    if (!local) published(value); return value;
  };
  const structuralProblems = (definition: Record<string, unknown>): FieldProblem[] => {
    const problems: FieldProblem[] = [];
    const steps = definition.steps as BrowserScenarioDefinition['steps'] | undefined;
    if (!steps?.length || steps.at(-1)?.action !== 'download' || steps.filter(s => s.action === 'download').length !== 1) problems.push(problem('DOWNLOAD_REQUIRED', '/steps'));
    const parameters = definition.parameters as Record<string, string> | undefined;
    for (const step of steps ?? []) if ((step.action === 'fill' || step.action === 'select') && (!parameters || !Object.hasOwn(parameters, step.parameter))) problems.push(problem('PARAMETER_REQUIRED', '/parameters'));
    return problems;
  };
  const assignmentFor = (evidence: BrowserExportEvidence, cfg: Binding): GoalAssignment => {
    const assignment = goalAssignmentSchema.parse(published(repository.readVersion<GoalAssignment>(evidence.publishedAssignment)));
    const current = repository.readPublishedHead<GoalAssignment>({ entityType: 'goal_assignment', id: evidence.publishedAssignment.id });
    if (!current || !same(semantic('goal_assignment', current), semantic('goal_assignment', assignment)) || assignment.goalId !== cfg.goal.id || !assignment.expectedPopulation?.length) return fail('EXPORT_COVERAGE_UNVERIFIED');
    return assignment;
  };
  const methodConfiguration = (assignment: GoalAssignment, cfg: Binding, read: (ref: EntityRef | VersionRef) => Header | null) => {
    const exact = (target: EntityRef | VersionRef): Header => { const value = read(target); if (!value || value.id !== target.id || 'revision' in target && value.revision !== target.revision) return fail('SOURCE_INVALID_CONFIGURATION'); return value; };
    const template = assignment.methodBinding.kind === 'template' ? templateSchema.parse(exact({ entityType: 'template', id: assignment.methodBinding.templateId })) : null;
    const methodRef = template?.methodRef ?? (assignment.methodBinding.kind === 'standalone' ? assignment.methodBinding.methodRef : null);
    if (!methodRef) return fail('SOURCE_INVALID_CONFIGURATION');
    const method = methodVersionSchema.parse(exact(methodRef));
    const metrics = method.mode === 'numeric' ? method.rules.map(rule => metricDefinitionSchema.parse(exact(rule.metricRef))) : [];
    const digest = hash({ assignment: semantic('goal_assignment', assignment), template: template ? semantic('template', template) : null, method: semantic('method_version', method), metrics: metrics.map(value => semantic('metric_definition', value)) });
    return { digest, validate: () => validateSourceConfiguration({ ...cfg, assignment, method, metrics }) };
  };
  const latest = (context: CommandContext, draftId: string): TestReceipt | null => {
    const row = sql.get<{ receipt_json: string }>('SELECT receipt_json FROM wb_browser_scenarios_tests WHERE installation_id=? AND person_id=? AND draft_id=? ORDER BY sequence DESC LIMIT 1', [context.installationId, context.ownAccess.personId, draftId]); return row ? JSON.parse(row.receipt_json) as TestReceipt : null;
  };
  const assertReceipt = (context: CommandContext, entry: StoredDraft, cfg: Binding, read: (ref: EntityRef | VersionRef) => Header | null) => {
    const receipt = latest(context, entry.draftId);
    if (!cfg.directory || !receipt || receipt.inputHash !== inputHash(entry) || receipt.configurationHash !== cfg.configurationHash) return fail('SCENARIO_TEST_REQUIRED');
    if (Date.parse(receipt.expiresAt) <= Date.parse(clock.now())) return fail('SCENARIO_TEST_EXPIRED');
    if (!receipt.result.complete || !receipt.evidence || !receipt.payloadHash) return fail(receipt.result.problems[0]?.code ?? 'EXPORT_COVERAGE_UNVERIFIED');
    const assignment = assignmentFor(receipt.evidence, cfg);
    const projected = read({ entityType: 'goal_assignment', id: assignment.id }); if (!projected || !same(semantic('goal_assignment', projected), semantic('goal_assignment', assignment))) return fail('SCENARIO_TEST_REQUIRED');
    const configuration = methodConfiguration(assignment, cfg, read);
    if (receipt.assignmentHash !== configuration.digest) return fail('SCENARIO_TEST_REQUIRED');
    configuration.validate();
  };
  drafts.registerOwnerPolicy(['browser_scenario'], {
    validateSave({ context, entry, definition }) {
      const problems = structuralProblems(definition);
      const parsed = browserScenarioDefinitionSchema.safeParse({ ...entry.header, ...definition });
      if (parsed.success && !problems.length) {
        try { const candidate = { ...entry, definition }; const read = ownRead(context, entry); assertReceipt(context, candidate, binding(parsed.data, read, ownDirectory(context, entry)), read); }
        catch (error) { if (error instanceof WorkbenchHttpError) problems.push(problem(error.code)); else if (error instanceof z.ZodError) problems.push(...fieldProblems(error)); else throw error; }
      }
      return problems;
    },
    validateMaterialization({ value, resolve }) {
      const scenario = browserScenarioDefinitionSchema.parse(value); const problems = structuralProblems(businessDefinition(scenario)); if (problems.length) throw new WorkbenchHttpError(422, problems[0].code, problems[0].message, problems);
      binding(scenario, resolve);
    },
    validatePackage({ context, entry, value, resolve, directoryInventory }) { assertReceipt(context, { ...entry, versionRef: ref('browser_scenario', value) }, binding(browserScenarioDefinitionSchema.parse(value), resolve, directoryInventory ?? null), resolve); },
  });
  return {
    async save(context, input) { return drafts.saveDefinition(context, input, ['browser_scenario']); },
    resolvePublished(sourceRef) {
      if (sourceRef.entityType !== 'source_definition') return fail('REFERENCE_TYPE_MISMATCH');
      const source = sourceDefinitionSchema.parse(published(repository.readVersion<SourceDefinition>(sourceRef)));
      if (source.kind !== 'qlik' || !source.browserScenarioRef) return fail('BROWSER_SCENARIO_REQUIRED', 409);
      const scenario = browserScenarioDefinitionSchema.parse(published(repository.readVersion<BrowserScenarioDefinition>(source.browserScenarioRef)));
      if (scenario.sourceId !== source.id) return fail('SOURCE_SCENARIO_MISMATCH');
      const problems = structuralProblems(businessDefinition(scenario)); if (problems.length) return fail(problems[0].code);
      return scenario;
    },
    async test(context, input) {
      const entry = structuredClone(drafts.readOwnEntry(context, uuidSchema.parse(input.draftId), ['browser_scenario']));
      const initialHash = inputHash(entry); const started = clock.now();
      let cfg: Binding | null = null, payloadHash: Sha256 | null = null, evidence: BrowserExportEvidence | null = null, assignmentHash: Sha256 | null = null;
      const result: BrowserScenarioTestResult = { draftId: input.draftId, scenarioRef: entry.entityRef, inputHash: initialHash, downloadedBytes: 0, acceptedPreviewRows: 0, rejectedPreviewRows: 0, complete: false, problems: structuralProblems(entry.definition) };
      try {
        const parsed = browserScenarioDefinitionSchema.safeParse({ ...entry.header, ...entry.definition });
        if (!parsed.success) result.problems.push(...fieldProblems(parsed.error));
        if (!parsed.success || result.problems.length) throw new WorkbenchHttpError(422, 'SCENARIO_INCOMPLETE', 'Scenario incomplete');
        const scenario = parsed.data; cfg = binding(scenario, ownRead(context, entry), ownDirectory(context, entry));
        const profile = await profiles.getOwn(context, scenario.sourceId);
        if (!profile.configured || !profile.profile) return fail('BROWSER_CONFIGURATION_REQUIRED', 409);
        const owner = { installationId: context.installationId, profilePersonId: context.ownAccess.personId };
        const signal = AbortSignal.timeout(120000);
        const download = await runtime.replay({ owner, profile: profile.profile, scenario }, signal); signal.throwIfAborted();
        if (!(download.bytes instanceof Uint8Array) || !download.bytes.length) return fail('DOWNLOAD_REQUIRED');
        if (download.bytes.length > defaultFileLimits.goalImportBytes) return fail('SOURCE_SCHEMA_CHANGED');
        const bytes = Buffer.from(download.bytes); result.downloadedBytes = bytes.length;
        try { assertFileName(download.name); } catch { return fail('SOURCE_SCHEMA_CHANGED'); }
        if (!download.name.toLowerCase().endsWith('.' + scenario.expectedExport.format)) return fail('SOURCE_SCHEMA_CHANGED');
        payloadHash = 'sha256:' + createHash('sha256').update(bytes).digest('hex');
        const table = await parser({ bytes, name: download.name, parsingProfile: cfg.mapping.parsingProfile });
        if (scenario.expectedExport.requiredColumns.some(column => !table.columns.includes(column))) return fail('SOURCE_SCHEMA_CHANGED');
        const normalized = normalizeParsedWorkbenchTable({ table, mapping: cfg.mapping });
        const enriched = enrichmentResultSchema.parse(enricher.enrich({ rows: normalized.canonicalRows, directoryRevision: hash(directoryDefinition(cfg.directory)) }));
        // The injected adapter must agree with T16 on the exact frozen projected directory.
        // A stale adapter cannot bless a new key, removed alias or changed relationship.
        const checkedEnrichment = enrichSourceRows({ capture: { sourceId: cfg.source.id, mappingRef: ref('source_field_mapping', cfg.mapping), rawRows: normalized.rawRows, canonicalRows: normalized.canonicalRows }, mapping: cfg.mapping, directoryEntities: cfg.directory!.entities, directoryLinks: cfg.directory!.links });
        if (!same(enriched, checkedEnrichment)) return fail('SOURCE_DIRECTORY_MISMATCH');
        const rejected = new Set(normalized.issues.flatMap(issue => issue.rowKeys));
        for (const issue of normalized.issues) result.problems.push(problem(issue.code, '/rows'));
        result.problems.push(...enriched.issues);
        const observed = new Set<string>(), keys = new Set<string>();
        for (const [index, row] of enriched.rows.entries()) {
          const original = normalized.canonicalRows.find(value => value.rowKey === row.rowKey); const { scope, directoryEntityRefs, ...canonical } = row;
          if (!original || keys.has(row.rowKey) || !same(original, canonical)) return fail('SOURCE_ROW_MISMATCH'); keys.add(row.rowKey);
          if (!scope || Object.values(row.numbers).some(n => n === null) || row.businessTime.kind === 'unknown' || !row.unitCode || enriched.issues.some(p => p.path.startsWith(`/canonicalRows/${index}`))) rejected.add(row.rowKey);
          else observed.add(stableJson(scope));
        }
        for (const row of normalized.canonicalRows) if (!keys.has(row.rowKey)) rejected.add(row.rowKey);
        result.rejectedPreviewRows = rejected.size; result.acceptedPreviewRows = normalized.rawRows.length - rejected.size;
        if (rejected.size && !result.problems.length) result.problems.push(problem('PREVIEW_ROWS_REJECTED', '/rows'));
        const exportBinding = { owner, sourceRef: ref('source_definition', cfg.source), mappingRef: ref('source_field_mapping', cfg.mapping), scenarioHash: initialHash, payloadHash };
        const observedEvidence = evidenceSchema.safeParse(await runtime.inspectExport?.(exportBinding, signal));
        if (!observedEvidence.success) return fail('EXPORT_COVERAGE_UNVERIFIED'); evidence = observedEvidence.data;
        const { publishedAssignment, observedAt, expiresAt, selectionVerified, allPagesExported, reportedRows, ...receivedBinding } = evidence;
        if (!same(exportBinding, receivedBinding) || !selectionVerified || !allPagesExported || reportedRows !== table.rows.length || Date.parse(observedAt) < Date.parse(started) || Date.parse(observedAt) > Date.parse(clock.now()) || Date.parse(expiresAt) <= Date.parse(clock.now()) || Date.parse(expiresAt) > Date.parse(observedAt) + 10 * 60_000) return fail('EXPORT_COVERAGE_UNVERIFIED');
        const assignment = assignmentFor(evidence, cfg); const method = methodConfiguration(assignment, cfg, ownRead(context, entry)); method.validate(); assignmentHash = method.digest;
        if (assignment.expectedPopulation!.some(scope => !observed.has(stableJson(scope))) || enriched.rows.some(row => row.scope && !assignment.expectedPopulation!.some(scope => same(scope, row.scope)))) result.problems.push(problem('EXPECTED_POPULATION_INCOMPLETE'));
      } catch (error) {
        if (error instanceof WorkbenchHttpError) { if (!result.problems.some(p => p.code === error.code)) result.problems.push(problem(error.code)); }
        else if (error instanceof WorkbenchParserError || error instanceof z.ZodError) result.problems.push(problem('SOURCE_SCHEMA_CHANGED'));
        else if (error instanceof ConnectorError) result.problems.push(problem(({ configuration_required: 'BROWSER_CONFIGURATION_REQUIRED', manual_required: 'AUTH_REQUIRED', manual_login_required: 'AUTH_REQUIRED', access_denied: 'SOURCE_ACCESS_DENIED', network: 'SOURCE_UNAVAILABLE', certificate: 'SOURCE_CERTIFICATE_REQUIRED', timeout: 'SOURCE_TIMEOUT', format: 'SOURCE_SCHEMA_CHANGED', incomplete: 'EXPORT_COVERAGE_UNVERIFIED', cancelled: 'SOURCE_CANCELLED' } as const)[error.code]));
        else result.problems.push(problem(error instanceof DOMException && error.name === 'AbortError' ? 'SOURCE_CANCELLED' : 'BROWSER_TEST_FAILED'));
      }
      // Awaited browser/parser work cannot bless edits or a changed published configuration.
      const current = drafts.readOwnEntry(context, input.draftId, ['browser_scenario']);
      if (!canUseCapability(context.ownAccess, 'uor.prepare') || initialHash !== inputHash(current)) return fail('SCENARIO_TEST_STALE', 409);
      if (cfg && cfg.configurationHash !== binding(browserScenarioDefinitionSchema.parse({ ...entry.header, ...entry.definition }), ownRead(context, current), ownDirectory(context, current)).configurationHash) return fail('SCENARIO_TEST_STALE', 409);
      if (cfg && evidence && assignmentHash && assignmentHash !== methodConfiguration(assignmentFor(evidence, cfg), cfg, ownRead(context, current)).digest) return fail('SCENARIO_TEST_STALE', 409);
      result.complete = result.problems.length === 0 && result.acceptedPreviewRows > 0;
      const receipt: TestReceipt = { inputHash: initialHash, configurationHash: cfg?.configurationHash ?? null, payloadHash, assignmentHash, evidence, result, expiresAt: evidence?.expiresAt ?? new Date(Date.parse(clock.now()) + 10 * 60_000).toISOString() };
      return commitCommandEffect(context, () => {
        sql.run('INSERT INTO wb_browser_scenarios_tests(installation_id,person_id,command_id,draft_id,receipt_json) VALUES(?,?,?,?,?)', [context.installationId, context.ownAccess.personId, context.commandId, input.draftId, stableJson(receipt)]);
        return { result, changedRefs: [], editToken: null };
      }).result;
    },
  };
}
