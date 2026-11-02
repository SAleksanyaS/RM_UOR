import {effectiveCells,effectiveBasisSchema} from '../../evaluation/workbench/effective-matrix';
import {selectEvaluationFacts} from '../../evaluation/workbench/select-facts';
import type {QueryRequest} from '../../../server/workbench/protocol';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Clock } from '../../../domain/workbench/primitives';
import type { WorkbenchRepository } from '../../../server/storage/workbench-repository';
import type { CommandContext } from '../../../server/workbench/command-registry';
import type { QueryContext } from '../../../server/workbench/query-registry';
import { commitCommandEffect, createCommandStore, stableJson } from '../../../server/workbench/command-store';
import { workbenchOutputSchemas, savedEvaluationInput, type WorkbenchReadModels } from '../../catalog/workbench-read-models';
import { metricDefinitionSchema, observedFactSchema } from '../../../domain/workbench/schemas';
import type { GlobalContext } from '../../../server/workbench/protocol';
import { WorkbenchHttpError } from '../../../server/workbench/protocol';
import { canUseCapability } from '../../identity/workbench-access-policy';
import type { MaturityMaterialBundle } from '../../maturity/workbench-contracts';
import { createMaturitySnapshot } from '../../maturity/workbench-materials';
import { reportDefinitionSchema, reportSnapshotSchema, type ReportDefinition, type ReportSnapshot, type ExportFormat } from './contracts';
import { goalReportTemplateBytes } from './template';
import { defaultReportDefinition, goalSectionNames } from './contracts';
import { createReportStore } from './store';
import { reportXlsx, reportPptx, reportHtml } from './exports';
import { renderMaturity2026Template } from '../../report-templates/maturity-2026-render';
type Context = CommandContext | QueryContext;
const fail = (code: string, status = 422): never => { throw new WorkbenchHttpError(status, code, code); };
export const reportDigest = (s: Omit<ReportSnapshot, 'digest'>) => createHash('sha256').update(stableJson(s)).digest('hex');
export function createReportService({ repository, clock, materials: defaultMaterials, materialsFor, pdf, readGoal, recipes }: {
    repository: WorkbenchRepository;
    clock: Clock;
    materials: MaturityMaterialBundle;
    materialsFor?: (context: Context) => MaturityMaterialBundle;
    recipes?: (context: Context) => ReportDefinition[];
    readGoal?: (c: QueryContext, context: GlobalContext) => Promise<WorkbenchReadModels['goals.detail']>;
    pdf?: (html: string) => Promise<Buffer>;
}) {
    const store = createReportStore(repository);
    const allowed = (c: Context) => { if (c.repository !== repository || !c.ownAccess.personId || !canUseCapability(c.ownAccess, 'uor.prepare'))
        fail('ACCESS_DENIED', 403); };
    const own = (c: Context, s: ReportSnapshot | null) => { allowed(c); if (!s || s.ownerPersonId !== c.ownAccess.personId || store.owner(s.id)?.installation_id !== c.installationId)
        fail('REPORT_NOT_FOUND', 404); return s!; };
    const freeze = async (c: Context, raw: ReportDefinition, id: string, revision: number): Promise<ReportSnapshot> => {
        allowed(c);
        const definition = reportDefinitionSchema.parse(raw);
        const materials = materialsFor?.(c) ?? defaultMaterials;
        if (definition.template === 'goal-management-v1') {
            if (!definition.context?.goalId || !readGoal)
                fail('REPORT_GOAL_CONTEXT_REQUIRED');
            const ctx = definition.context!;
            const period = ctx.time.kind === 'as_of' ? ctx.time.date : ctx.time.endExclusive;
            if (definition.period !== period)
                fail('REPORT_CONTEXT_PERIOD_MISMATCH');
            const goalData = workbenchOutputSchemas['goals.detail'].parse(await readGoal!(c, ctx));
            const metrics = goalData.tabs.method.flatMap(method => method.mode === 'numeric' ? method.rules.map(rule => metricDefinitionSchema.parse(repository.readVersion(rule.metricRef))) : []);
            const facts = goalData.tabs.calculation.flatMap(basis => basis.factRefs.map(ref => observedFactSchema.parse(repository.readVersion(ref))));
            const effectiveBases = goalData.rows.flatMap(row => {
                const input = savedEvaluationInput(row, {context:ctx} as QueryRequest, c, true);
                if (!input || input.method.mode !== 'numeric') return [];
                const basis = goalData.tabs.calculation.find(b => b.id === row.basisRef!.id && b.revision === row.basisRef!.revision);
                return [effectiveBasisSchema.parse({basis,assignment:input.assignment,goal:input.goal,method:input.method,metrics:input.metrics,facts:input.facts,captures:input.captures,corrections:input.corrections,applicability:input.applicability,publicationAnchors:input.resolution.publicationAnchors,selection:selectEvaluationFacts(input).metrics,cells:effectiveCells(input)})];
            });
            const bytes = goalReportTemplateBytes();
            const base = { schemaVersion: 1 as const, id, revision, createdAt: clock.now(), ownerPersonId: c.ownAccess.personId!, installationId: c.installationId, definition, maturity: null, goalData, metrics, facts, effectiveBases, template: { id: 'goal-management-v1' as const, version: 1 as const, bytesBase64: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex'), profile: null } };
            return reportSnapshotSchema.parse({ ...base, digest: reportDigest(base) });
        }
        if (definition.period !== materials.period)
            fail('REPORT_PERIOD_HAS_NO_FACTS');
        if (definition.teamIds.some(id => !materials.teams.some(t => t.id === id)))
            fail('REPORT_SCOPE_INVALID');
        const selected = new Set(definition.teamIds.length ? definition.teamIds : materials.teams.map(t => t.id));
        const scoped = { ...materials, teams: materials.teams.filter(t => selected.has(t.id)), leaders: materials.leaders.map(l => ({ ...l, teamIds: l.teamIds.filter(id => selected.has(id)) })).filter(l => l.teamIds.length), observations: materials.observations.filter(o => selected.has(o.teamId)) };
        const maturity = createMaturitySnapshot(scoped);
        if (selected.size !== materials.teams.length) {
            maturity.reportedClaims = [];
            maturity.evaluation.reportedClaims = [];
            maturity.limitations.push('Общие заявления источника не относятся к выбранной части команд.');
        }
        const source = materials.sources.find(s => s.kind === 'pptx')!;
        const bytes = readFileSync(path.resolve(source.path));
        if (createHash('sha256').update(bytes).digest('hex') !== source.sha256)
            fail('REPORT_TEMPLATE_CHANGED');
        const base = { schemaVersion: 1 as const, id, revision, createdAt: clock.now(), ownerPersonId: c.ownAccess.personId!, installationId: c.installationId, definition, maturity, goalData: null, metrics: [], facts: [], template: { id: 'maturity-management-v1' as const, version: 1 as const, bytesBase64: bytes.toString('base64'), sha256: source.sha256, profile: { kind: 'dit-maturity-2026-10-v1' as const, name: 'Модель зрелости · источник 30 октября', rowsPerSlide: 10, sourceLayout: 'overview-leaders-eight-details' as const } } };
        return reportSnapshotSchema.parse({ ...base, digest: reportDigest(base) });
    };
    const detail = (c: Context, id: string, revision?: number) => own(c, store.read(id, revision));
    return {
        recipes: (c: Context) => { allowed(c); const defaults = defaultReportDefinition((materialsFor?.(c) ?? defaultMaterials).period); return [defaults, { ...defaults, template: 'goal-management-v1', title: 'Отчёт по цели', sections: defaults.sections.map(s => ({ ...s, title: goalSectionNames[s.kind] })) }, ...(recipes?.(c) ?? [])].slice(0, 200).map(v => reportDefinitionSchema.parse(v)); },
        prepare: (c: Context, definition: ReportDefinition) => freeze(c, definition, randomUUID(), 1), detail,
        list: (c: Context) => { allowed(c); return store.latest(c.ownAccess.personId!, c.installationId).map(s => ({ ...s, editToken: `report:${s.id}:${s.revision}` })); },
        async save(c: CommandContext, input: {
            id: string | null;
            definition: ReportDefinition;
        }) {
            allowed(c);
            if (c.actor.installationId !== c.installationId || c.actor.profilePersonId !== c.ownAccess.personId)
                fail('COMMAND_CONTEXT_MISMATCH', 409);
            const previous = input.id ? detail(c, input.id) : null;
            const expected = previous ? `report:${previous.id}:${previous.revision}` : null;
            const intent = createCommandStore(repository).get(c.installationId, c.commandId);
            if (!intent)
                fail('COMMAND_INTENT_MISSING', 409);
            if (JSON.parse(intent!.request_json).baseRevision !== expected)
                fail('REVISION_CONFLICT', 409);
            const s = await freeze(c, input.definition, input.id ?? randomUUID(), (previous?.revision ?? 0) + 1);
            return commitCommandEffect(c, () => { const current = input.id ? detail(c, input.id) : null; if ((current ? `report:${current.id}:${current.revision}` : null) !== expected)
                fail('REVISION_CONFLICT', 409); store.insert(s); return { result: { id: s.id, revision: s.revision, digest: s.digest }, changedRefs: [], editToken: `report:${s.id}:${s.revision}` }; });
        },
        async readExport(c: Context, id: string, revision: number, format: ExportFormat) { const s = detail(c, id, revision); const bytes = format === 'xlsx' ? await reportXlsx(s) : format === 'pptx' ? await reportPptx(s) : format === 'native-pptx' ? s.maturity && s.template.profile ? await renderMaturity2026Template(Buffer.from(s.template.bytesBase64, 'base64'), s.template.profile, s.maturity) : fail('REPORT_PRESET_UNAVAILABLE') : pdf ? await pdf(reportHtml(s)) : fail('PDF_RENDERER_UNAVAILABLE', 503); return { bytes, filename: `report-${id}-v${revision}.${format === 'native-pptx' ? 'pptx' : format}`, mimeType: format === 'pdf' ? 'application/pdf' : format === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }; },
    };
}
export type ReportService = ReturnType<typeof createReportService>;
