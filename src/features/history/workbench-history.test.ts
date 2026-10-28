import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { createWorkbenchRepository, type WorkbenchRepository } from '../../server/storage/workbench-repository';
import { fixtureId, makeEntityGraph, makeHeader, makeNumericFixture, makePublicationAnchor, versionRef } from '../../../tests/fixtures/workbench/factories';
import { seedGraph } from '../../../tests/fixtures/workbench/repository';
import { addMoscowDays, moscowStart } from '../../domain/workbench/time';
import { prepareEvaluation } from '../evaluation/workbench/prepare-evaluation';
import { installHistoryIndex } from './workbench-history-index';
import { queryHistorySeries } from './workbench-history';
import type { HistorySeriesInput } from './workbench-history-contracts';
const cleanup: Array<() => void> = [];
afterEach(() => {
    while (cleanup.length)
        cleanup.pop()!();
});
function setup(count = 2, install = true) {
    const i = makeNumericFixture({ values: ['92'] });
    const fact = i.facts[0], capture = i.captures[0];
    i.facts = [];
    i.captures = [];
    for (let n = 0; n < count; n++) {
        const date = count > 2 ? addMoscowDays('2018-01-01', n) : n === 0 ? '2026-10-22' : '2026-10-24';
        const c = { ...capture, id: fixtureId(20000 + n), capturedAt: moscowStart(date), recordedAt: moscowStart(date) };
        i.captures.push(c);
        i.facts.push({ ...fact, id: fixtureId(30000 + n), captureId: c.id, recordedAt: c.capturedAt, value: n === 1 ? '93' : '92', businessTime: { kind: 'as_of', date }, lineage: { ...fact.lineage, captureId: c.id }, factKey: 'demo_' + n });
    }
    const root = mkdtempSync(path.join(tmpdir(), 'uor-history-'));
    const filename = path.join(root, 'state.sqlite');
    let r = createWorkbenchRepository({ filename, artifactRoot: path.join(root, 'artifacts') });
    if (install)
        installHistoryIndex(r);
    seedGraph(r, makeEntityGraph(i));
    cleanup.push(() => { r.close(); rmSync(root, { recursive: true, force: true }); });
    const input: HistorySeriesInput = { assignmentRef: versionRef('goal_assignment', 15), metricRef: versionRef('metric_definition', 201), mode: 'current', snapshotRef: null, granularity: 'day', fromInclusive: count > 2 ? '2018-01-01' : '2026-10-22', toExclusive: count > 2 ? '2026-10-24' : '2026-10-25', evaluatedAt: '2026-10-26T12:00:00Z', effectiveAt: null, cursor: null, limit: 500 };
    return { i, input, filename, get r() { return r; }, reopen() { r.close(); r = createWorkbenchRepository({ filename, artifactRoot: path.join(root, 'artifacts') }); installHistoryIndex(r); return r; } };
}
it('uses_index_and_preserves_daily_gaps', () => {
    const { r, input, filename, i } = setup();
    const before = r.getStateRevision();
    expect(queryHistorySeries(input, r).points).toEqual([expect.objectContaining({ date: '2026-10-22', value: '92' }), expect.objectContaining({ date: '2026-10-23', value: null, sourceFactRef: null }), expect.objectContaining({ date: '2026-10-24', value: '93' })]);
    expect(queryHistorySeries({ ...input, granularity: 'friday' }, r).points).toEqual([expect.objectContaining({ friday: '2026-10-23', value: '92', carried: true, sourceBusinessTime: { kind: 'as_of', date: '2026-10-22' } })]);
    expect(queryHistorySeries({ ...input, granularity: 'friday', fromInclusive: '2026-10-23' }, r).points[0]).toEqual(expect.objectContaining({ value: '92', carried: true }));
    expect(r.getStateRevision()).toBe(before);
    const db = new DatabaseSync(filename, { readOnly: true });
    try {
        const plan = db.prepare('EXPLAIN QUERY PLAN SELECT id FROM wb_history_observations INDEXED BY wb_history_scope_time WHERE source_id=? AND metric_id=? AND scope_kind=? AND scope_id=? AND business_start>=? AND business_start<? ORDER BY business_start,captured_at,id,revision LIMIT ?').all(i.goal.sourceId, i.metrics[0].id, i.assignment.scope.kind, i.assignment.scope.id, input.fromInclusive, input.toExclusive, 100) as Array<{
            detail: string;
        }>;
        expect(plan.some(p => p.detail.includes('wb_history_scope_time'))).toBe(true);
        expect(plan.some(p => p.detail.includes('SCAN wb_entity_versions'))).toBe(false);
    }
    finally {
        db.close();
    }
    const sql = r.sqlForModule('history');
    const n = sql.get<{
        n: number;
    }>('SELECT COUNT(*) n FROM wb_history_observations')!.n;
    r.registerProjection('demo-fail', type => {
        if (type === 'observed_fact')
            throw new Error('demo rollback');
    });
    expect(() => r.append('observed_fact', { ...i.facts[0], id: fixtureId(99999) }, null)).toThrow('demo rollback');
    expect(sql.get<{
        n: number;
    }>('SELECT COUNT(*) n FROM wb_history_observations')!.n).toBe(n);
});
it('retains_history_and_frozen_agreed_basis', () => {
    const s = setup(3001);
    const { i, input } = s;
    const link = { ...makeHeader(91000, { publicationAnchorId: i.goal.publicationAnchorId }), kind: 'leader' as const, scope: i.assignment.scope, personId: i.goal.primaryCuratorPersonId };
    s.r.append('directory_link', link, null);
    i.resolution.directoryLinkRefs = [versionRef('directory_link', 91000)];
    const saved = prepareEvaluation(i, s.r);
    const result = s.r.readVersion<import('../../domain/workbench/entities').CalculationResult>(saved.resultRef!)!;
    const snapshot = { ...makeHeader(90000), basisRef: saved.basisRef, numericResult: ((({ schemaVersion, id, revision, recordedAt, actor, publicationAnchorId, ...n }) => n)(result)), manualStatusRef: null, attestationRef: null };
    s.r.append('agreed_snapshot', snapshot, null);
    const original = JSON.stringify(s.r.readVersion(saved.basisRef));
    const frozenSnapshot = JSON.stringify(s.r.readVersion(versionRef('agreed_snapshot', 90000)));
    const frozenResult = JSON.stringify(result);
    s.r.append('directory_link', { ...link, revision: 2 }, 1);
    s.r.append('method_version', { ...i.method, revision: 2 }, 1);
    s.r.append('core_goal_definition', { ...i.goal, revision: 2, lifecycle: 'archived', archiveReason: 'demo archive' }, 1);
    const r = s.reopen();
    let cursor: string | null = null;
    const refs: string[] = [];
    do {
        const page = queryHistorySeries({ ...input, cursor, limit: 73 }, r);
        for (const point of page.points)
            if (point.sourceFactRef)
                refs.push(point.sourceFactRef.id);
        cursor = page.nextCursor;
    } while (cursor);
    expect(refs).toHaveLength(3001);
    expect(new Set(refs).size).toBe(3001);
    expect(JSON.stringify(r.readVersion(saved.basisRef))).toBe(original);
    expect(queryHistorySeries({ ...input, mode: 'agreed', snapshotRef: versionRef('agreed_snapshot', 90000) }, r).basisRef).toEqual(saved.basisRef);
    expect(JSON.stringify(r.readVersion(versionRef('agreed_snapshot', 90000)))).toBe(frozenSnapshot);
    expect(JSON.stringify(r.readVersion(saved.resultRef!))).toBe(frozenResult);
    expect(r.readVersion<import('../../domain/workbench/entities').EvaluationBasis>(saved.basisRef)!.directoryLinkRefs).toEqual([versionRef('directory_link', 91000)]);
    expect(() => queryHistorySeries({ ...input, mode: 'agreed', snapshotRef: versionRef('agreed_snapshot', 90000), metricRef: { ...input.metricRef, revision: 2 } }, r)).toThrowError(expect.objectContaining({ code: 'BASIS_MISMATCH' }));
    const broken: WorkbenchRepository = { ...r, readVersion(ref) { return ref.entityType === 'evaluation_basis' ? null : r.readVersion(ref); } };
    expect(() => queryHistorySeries({ ...input, mode: 'agreed', snapshotRef: versionRef('agreed_snapshot', 90000) }, broken)).toThrowError(expect.objectContaining({ code: 'HISTORICAL_BASIS_UNAVAILABLE' }));
});
it('separates_current_publication_from_wall_clock_history', () => {
    const { r, input, i } = setup();
    const unknown = makePublicationAnchor({ id: fixtureId(60000), packageId: fixtureId(60001), timeVerification: 'unknown', mergedAt: null });
    r.appendPublicationAnchor(unknown, null);
    r.append('core_goal_definition', { ...i.goal, revision: 2, publicationAnchorId: unknown.id }, 1);
    expect(queryHistorySeries(input, r).points).toHaveLength(3);
    expect(() => queryHistorySeries({ ...input, effectiveAt: '2026-10-25T00:00:00Z' }, r)).toThrowError(expect.objectContaining({ code: 'EFFECTIVE_TIME_UNVERIFIED' }));
    expect(() => queryHistorySeries({ ...input, mode: 'agreed' }, r)).toThrow();
    const first = queryHistorySeries({ ...input, limit: 1 }, r);
    expect(first.nextCursor).not.toBeNull();
    expect(() => queryHistorySeries({ ...input, fromInclusive: '2026-10-23', cursor: first.nextCursor }, r)).toThrowError(expect.objectContaining({ code: 'INVALID_CURSOR' }));
    expect(() => queryHistorySeries({ ...input, metricRef: { ...input.metricRef, revision: 2 } }, r)).toThrowError(expect.objectContaining({ code: 'BASIS_MISMATCH' }));
    expect(i.goal.lifecycle).toBe('active');
});
it('backfills existing immutable observations once and preserves period boundaries', () => {
    const s = setup(2, false);
    const db = new DatabaseSync(s.filename);
    db.prepare('DELETE FROM wb_schema_migrations WHERE id=?').run('workbench-history-backfill-v1');
    db.close();
    s.reopen();
    expect(queryHistorySeries(s.input, s.r).points.filter(p => p.sourceFactRef)).toHaveLength(2);
    const i = makeNumericFixture({ context: { evaluatedAt: '2026-10-26T12:00:00Z', businessTime: { kind: 'period', startInclusive: '2026-10-01', endExclusive: '2026-11-01' } } });
    const root = mkdtempSync(path.join(tmpdir(), 'uor-history-'));
    const r = createWorkbenchRepository({ filename: ':memory:', artifactRoot: root });
    cleanup.push(() => { r.close(); rmSync(root, { recursive: true, force: true }); });
    installHistoryIndex(r);
    seedGraph(r, makeEntityGraph(i));
    const h = queryHistorySeries({ ...s.input, fromInclusive: '2026-10-01', toExclusive: '2026-11-01' }, r);
    expect(h.points).toHaveLength(1);
    expect(h.points[0]).toEqual(expect.objectContaining({ businessTime: i.context.businessTime }));
    expect(h.points[0]).not.toHaveProperty('date');
});
it('pages_raw_history_by_stable_index_tuple_without_a_lifetime_cap', () => {
    const { r, input, i } = setup(3001);
    let cursor: string | null = null;
    const ids: string[] = [];
    do {
        const p = r.readHistoryRecords({ assignmentRef: input.assignmentRef, metricRef: input.metricRef, scope: i.assignment.scope, fromInclusive: input.fromInclusive, toExclusive: input.toExclusive, capturedBefore: input.evaluatedAt, cursor, limit: 97 });
        ids.push(...p.facts.map(f => f.id));
        cursor = p.nextCursor;
    } while (cursor);
    expect(ids).toHaveLength(3001);
    expect(new Set(ids).size).toBe(3001);
});
it('bounds_period_pages_by_observations_instead_of_calendar_days', () => {
    const s = setup();
    const i = s.i;
    s.r.append('core_goal_definition', { ...i.goal, revision: 2, measurementMode: 'period' }, 1);
    s.r.transaction(() => {
        for (let n = 0; n < 7; n++)
            s.r.append('observed_fact', { ...i.facts[0], id: fixtureId(50000 + n), businessTime: { kind: 'period', startInclusive: '2026-10-01', endExclusive: '2026-11-01' }, factKey: 'demo_period_' + n }, null);
    });
    let cursor: string | null = null;
    const refs: string[] = [];
    do {
        const h = queryHistorySeries({ ...s.input, fromInclusive: '2026-10-01', toExclusive: '2026-11-01', limit: 2, cursor }, s.r);
        expect(h.points.length).toBeLessThanOrEqual(2);
        refs.push(...h.points.map(p => p.sourceFactRef!.id));
        cursor = h.nextCursor;
    } while (cursor);
    expect(refs).toHaveLength(7);
    expect(new Set(refs).size).toBe(7);
});
it('does_not_hide_older_known_friday_value_behind_a_missing_predecessor', () => {
    const s = setup();
    s.r.append('observed_fact', { ...s.i.facts[0], id: fixtureId(70000), businessTime: { kind: 'as_of', date: '2026-10-25' }, state: 'missing', value: null, missingReason: 'demo missing' }, null);
    const h = queryHistorySeries({ ...s.input, granularity: 'friday', fromInclusive: '2026-10-30', toExclusive: '2026-10-31' }, s.r);
    expect(h.points[0]).toEqual(expect.objectContaining({ value: '93', sourceBusinessTime: { kind: 'as_of', date: '2026-10-24' } }));
});
it('does_not_resolve_conflicting_friday_predecessors_by_uuid', () => {
    const s = setup();
    s.r.append('observed_fact', { ...s.i.facts[0], id: fixtureId(70001), value: '99' }, null);
    expect(() => queryHistorySeries({ ...s.input, granularity: 'friday', fromInclusive: '2026-10-23', toExclusive: '2026-10-24' }, s.r)).toThrowError(expect.objectContaining({ code: 'AMBIGUOUS_FACT_SELECTION' }));
});
it('retains_late_arriving_predecessors_for_later_fridays_in_the_same_page', () => {
    const s = setup();
    const old = s.i.captures[0];
    const c = { ...old, id: fixtureId(72000), capturedAt: '2026-10-28T09:00:00Z', recordedAt: '2026-10-28T09:00:00Z' };
    s.r.transaction(() => { s.r.append('capture', c, null); s.r.append('observed_fact', { ...s.i.facts[0], id: fixtureId(72001), captureId: c.id, recordedAt: c.recordedAt, value: '97', businessTime: { kind: 'as_of', date: '2026-10-22' }, lineage: { ...s.i.facts[0].lineage, captureId: c.id } }, null); });
    const h = queryHistorySeries({ ...s.input, granularity: 'friday', fromInclusive: '2026-10-23', toExclusive: '2026-10-31', evaluatedAt: '2026-10-31T12:00:00Z' }, s.r);
    // The Oct24 business observation remains newer than Oct22 even when the latter arrived later.
    expect(h.points).toEqual([expect.objectContaining({ friday: '2026-10-23', value: '92' }), expect.objectContaining({ friday: '2026-10-30', value: '93' })]);
    const c2 = { ...old, id: fixtureId(72002), capturedAt: '2026-10-28T09:00:00Z', recordedAt: '2026-10-28T09:00:00Z' };
    s.r.transaction(() => { s.r.append('capture', c2, null); s.r.append('observed_fact', { ...s.i.facts[0], id: fixtureId(72003), captureId: c2.id, recordedAt: c2.recordedAt, value: '98', businessTime: { kind: 'as_of', date: '2026-10-24' }, lineage: { ...s.i.facts[0].lineage, captureId: c2.id } }, null); });
    const c3 = { ...old, id: fixtureId(72004), capturedAt: '2026-11-04T09:00:00Z', recordedAt: '2026-11-04T09:00:00Z' };
    s.r.transaction(() => { s.r.append('capture', c3, null); s.r.append('observed_fact', { ...s.i.facts[0], id: fixtureId(72005), captureId: c3.id, recordedAt: c3.recordedAt, value: '99', businessTime: { kind: 'as_of', date: '2026-10-24' }, lineage: { ...s.i.facts[0].lineage, captureId: c3.id } }, null); });
    const later = queryHistorySeries({ ...s.input, granularity: 'friday', fromInclusive: '2026-10-30', toExclusive: '2026-11-07', evaluatedAt: '2026-11-07T12:00:00Z' }, s.r);
    expect(later.points).toEqual([expect.objectContaining({ value: '98' }), expect.objectContaining({ value: '99' })]);
});
