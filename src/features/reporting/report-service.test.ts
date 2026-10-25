import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import JSZip from 'jszip';
import type { Attestation, CatalogSnapshot, LocalSnapshot, Session } from '../../domain/contracts';
import { createContext, type ApplicationContext } from '../../server/workspace/context';
import { buildReport, generateReport, readReport } from './report-service';
import { paginate, reportHtml, reportPptx, textPages } from './report-export';
import { reportStatus } from './report-contracts';
import { saveReportProfile } from './report-profile-service';

const now = '2026-10-25T12:00:00.000Z';
const reader: Session = { id: 'reader-one', role: 'reader', curatorId: null, name: 'Просмотр', createdAt: now };
function fixture(): CatalogSnapshot { return { schemaVersion: 1, id: 'report-demo', name: 'Синтетический пример', classification: 'demo', importedAt: now,
  goals: [{ id: 'g', title: 'Полное русское название цели <script>alert(1)</script>', category: 'process', summary: '', target: '', metric: '', status: '', actions: [], links: [], scopeType: '', officialTarget: 80, internalTarget: 90, unit: '%', baseline: null, weight: null, direction: 'increase', priority: null, ownerId: null, curatorId: null, revision: 'g-revision', dueDate: '2026-11-01' }],
  leaders: [{ id: 'leader', name: 'Лидер синтетического примера с полным длинным именем', teams: [] }], assignments: [{ id: 'assignment', goalId: 'g', leaderId: 'leader', teams: [], active: true }],
  sources: [{ id: 's', name: 'Источник примера', kind: 'manual', url: null, accessUrl: null, mode: 'local', goalIds: ['g'], freshnessHours: 168 }], comments: [], entities: [] }; }
function snapshot(): LocalSnapshot { return { id: 'facts', classification: 'demo', sourceId: 's', period: '2026-10-25', origin: 'manual', status: 'personal', collectedAt: now, sourceUpdatedAt: now, dataHash: 'facts-hash', curatorId: null, curatorName: null, validatedAt: null, limitations: ['Тестовые данные'], evidenceIds: [],
  observations: [{ id: 'row', goalId: 'g', leaderId: 'leader', participantId: 'p', participantName: 'Участник примера', metricId: 'g', metricName: 'Цель', value: 85, target: 80, state: 'numeric', reason: null, unit: '%', sourceId: 's', period: '2026-10-25', sourceUpdatedAt: now, downloadedAt: now }] }; }
const roots: string[] = [], contexts: ApplicationContext[] = [];
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); for (const context of contexts.splice(0)) context.db.close(); for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true }); });
async function setup() { const root = await mkdtemp(join(tmpdir(), 'uor-report-')); roots.push(root); const context = await createContext({ projectRoot: root, initialCatalog: fixture(), startupCheck: false }); contexts.push(context); return context; }
describe('frozen report projection', () => {
  it('keeps official result, pending confirmation, named leaders and independent goal totals consistent', () => {
    const catalog = fixture(), fact = snapshot(), report = buildReport(catalog, [fact], [], { goalIds: ['g'], leaderIds: ['leader'], period: '2026-10-25' }, 'Просмотр', now);
    expect(report.rows).toHaveLength(2); expect(report.rows[1].leaderName).toBe(catalog.leaders[0].name);
    expect(report.summary).toEqual({ goals: 1, confirmed: 0, pending: 1, notMet: 0, unknown: 0 });
    expect(reportStatus(report.rows[0])).toBe('Ожидает подтверждения УОР');
    const before = structuredClone(report); catalog.goals[0].title = 'Изменённая цель'; fact.observations[0].value = 0; fact.limitations.push('Поздняя правка');
    expect(report).toEqual(before);
    const missing = buildReport(catalog, [], [], { goalIds: ['g'], leaderIds: [], period: '2026-10-01' }, 'Просмотр', now);
    expect(missing.summary.unknown).toBe(1); expect(missing.rows[0].evaluation.actual).toBeNull();
  });
  it('binds confirmation to exact fingerprint and drops stale success without mutating the attestation', () => {
    const catalog = fixture(), fact = snapshot(), selection = { goalIds: ['g'], leaderIds: [], period: '2026-10-25' };
    const initial = buildReport(catalog, [fact], [], selection, 'Просмотр', now);
    const approval: Attestation = { id: 'a', goalId: 'g', leaderId: null, period: selection.period, fingerprint: initial.rows[0].evaluation.fingerprint, curatorId: 'c', curatorName: 'Куратор примера', confirmedAt: now, comment: 'Проверено на синтетике', evidenceIds: [], invalidatedAt: null };
    expect(buildReport(catalog, [fact], [approval], selection, 'Просмотр', now).summary.confirmed).toBe(1);
    expect(buildReport(catalog, [fact], [approval], selection, 'Просмотр', '2026-11-20T12:00:00Z').summary.pending).toBe(1);
    fact.observations[0].value = 20;
    const regressed = buildReport(catalog, [fact], [approval], selection, 'Просмотр', now);
    expect(regressed.summary.notMet).toBe(1); expect(regressed.rows[0].confirmation).toBeNull(); expect(approval.invalidatedAt).toBeNull();
  });
  it('escapes all HTML content and paginates without dropping long names or comments in PPTX', async () => {
    const catalog = fixture(); catalog.comments.push({ id: 'comment', goalId: 'g', leaderId: null, text: '<img onerror="alert(1)">', author: 'Куратор примера', createdAt: now, validUntil: null, revision: 'r' });
    const report = buildReport(catalog, [snapshot()], [], { goalIds: ['g'], leaderIds: ['leader'], period: '2026-10-25' }, 'Просмотр', now);
    const html = reportHtml(report); expect(html).toContain('&lt;script&gt;'); expect(html).toContain('&lt;img onerror='); expect(html).not.toContain('<script>alert'); expect(html).not.toContain('<img onerror');
    expect(paginate(Array.from({ length: 17 }, (_, index) => index), 6).map(page => page.length)).toEqual([6, 6, 5]);
    expect(() => paginate([], 0)).toThrow(); expect(textPages('строка\n'.repeat(80)).length).toBeGreaterThan(3);
    const buffer = await reportPptx(report); expect(buffer.subarray(0, 2).toString()).toBe('PK');
    const zip = await JSZip.loadAsync(buffer); const slides = Object.keys(zip.files).filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name));
    expect(slides.length).toBeGreaterThanOrEqual(6);
    const xml = (await Promise.all(slides.map(name => zip.file(name)!.async('text')))).join('');
    expect(xml).toContain(catalog.leaders[0].name); expect(xml).toContain('Ожидает подтверждения УОР'); expect(xml).toContain(report.versions.catalog); expect(xml).toContain('&lt;script&gt;');
  });
  it('generates reader snapshots from server state without invoking mutating evaluation and isolates downloads by session', async () => {
    const context = await setup(); context.db.set('snapshots', 'facts', snapshot());
    context.db.set('attestations', 'old', { id: 'old', invalidatedAt: null });
    const previous = context.db.list('attestations');
    const spy = vi.spyOn(context, 'state').mockImplementation(async () => { throw new Error('Must not run'); });
    const report = await generateReport(context, reader, { goalIds: ['g'], leaderIds: [], period: '2026-10-01' });
    expect(report.summary.unknown).toBe(1); expect(spy).not.toHaveBeenCalled(); expect(context.db.list('attestations')).toEqual(previous); expect(context.db.list('last-evaluations')).toEqual([]);
    context.db.remove('snapshots', 'facts'); expect(readReport(context, reader, report.id)).toEqual(report);
    expect(() => readReport(context, { ...reader, id: 'reader-other' }, report.id)).toThrow();
  });
  it('allows only curators to save valid composition profiles with revision protection', async () => {
    const context = await setup(), profile = { name: 'Состав примера', goalIds: ['g'], leaderIds: ['leader'], period: '2026-10-25' };
    await expect(saveReportProfile(context, reader, { baseRevision: null, profile })).rejects.toMatchObject({ statusCode: 403 });
    const curator = { ...reader, role: 'curator' as const, curatorId: 'demo-curator' };
    const first = await saveReportProfile(context, curator, { baseRevision: null, profile });
    expect(first.profile.type).toBe('report_profile');
    await expect(saveReportProfile(context, curator, { id: first.profile.id, baseRevision: null, profile })).rejects.toMatchObject({ statusCode: 409 });
    expect((await context.catalogs.readForSession(curator)).entities[0]).toEqual(first.profile);
  });
  it('matches the current screen projection for an explicit methodology even when its metric id equals the goal id', async () => {
    const context = await setup(), catalog = fixture(), fact = snapshot();
    catalog.goals[0].measurement = { kind: 'scalar', aggregation: 'single', metrics: [{ id: 'g', name: 'Основной показатель', unit: '%', target: 80, direction: 'increase' }] };
    catalog.goals[0].requiredMetricIds = ['g']; catalog.assignments[0].participantIds = ['p'];
    const current = context.evaluations(catalog, [fact]);
    const report = buildReport(catalog, [fact], [], { goalIds: ['g'], leaderIds: ['leader'], period: fact.period }, 'Просмотр');
    expect(report.rows.map(row => row.evaluation)).toEqual(current);
    expect(report.rows[0].evaluation.actual).toBe(85); expect(report.summary.pending).toBe(1);
  });
  it('uses the same conservative freshness for state and report when source date is unknown', async () => {
    const context = await setup(), catalog = fixture(), fact = snapshot();
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(now));
    catalog.sources[0].freshnessHours = 24;
    fact.period = '2026-10-24'; fact.sourceUpdatedAt = null;
    fact.observations[0].period = fact.period; fact.observations[0].sourceUpdatedAt = null;
    const selection = { goalIds: ['g'], leaderIds: [], period: fact.period };
    const initial = buildReport(catalog, [fact], [], selection, 'Просмотр', now);
    const approval: Attestation = { id: 'freshness-approval', goalId: 'g', leaderId: null, period: fact.period, fingerprint: initial.rows[0].evaluation.fingerprint, curatorId: 'c', curatorName: 'Куратор примера', confirmedAt: now, comment: 'Проверка примера', evidenceIds: [], invalidatedAt: null };
    context.db.set('catalog', 'active', catalog); context.db.set('snapshots', fact.id, fact); context.db.set('attestations', approval.id, approval);
    const state = await context.state(reader), report = buildReport(catalog, [fact], [approval], selection, 'Просмотр', now);
    expect(state.evaluations.find(item => item.leaderId === null)).toEqual(report.rows[0].evaluation);
    expect(report.rows[0].evaluation.validation).toBe('pending');
    expect(report.rows[0].evaluation.qualityFlags).toContain('stale');
    expect(report.rows[0].evaluation.qualityFlags).toContain('source_date_unknown');
  });
  it('freezes configured range bounds as the official target in HTML and PPTX', async () => {
    const catalog = fixture(), fact = snapshot();
    catalog.goals[0].officialTarget = null; catalog.goals[0].internalTarget = null; catalog.goals[0].unit = 'мс';
    catalog.goals[0].measurement = { kind: 'range', aggregation: 'single', metrics: [{ id: 'g', name: 'Задержка', unit: 'мс', target: 20, direction: 'decrease' }], range: { min: 10, max: 20 } };
    catalog.assignments[0].participantIds = ['p']; fact.observations[0].value = 15;
    const report = buildReport(catalog, [fact], [], { goalIds: ['g'], leaderIds: [], period: fact.period }, 'Просмотр', now);
    expect(report.rows[0].evaluation.official).toBe('met'); expect(report.rows[0].officialTargetLabel).toBe('10–20 мс');
    catalog.goals[0].measurement.range!.max = 30;
    const html = reportHtml(report); expect(html).toContain('Порог: 10–20 мс'); expect(html).toContain('Официальный порог: 10–20 мс');
    const zip = await JSZip.loadAsync(await reportPptx(report));
    const xml = (await Promise.all(Object.keys(zip.files).filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name)).map(name => zip.file(name)!.async('text')))).join('');
    expect(xml).toContain('10–20 мс'); expect(xml).not.toContain('10–30 мс');
  });
});
