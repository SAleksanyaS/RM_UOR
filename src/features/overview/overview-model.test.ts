import { describe, expect, it } from 'vitest';
import type { CatalogSnapshot, Evaluation, Goal, LocalSnapshot } from '../../domain/contracts';
import { buildDirectionOverview, buildExecutiveModel, buildOverview, buildTeamPracticeRows, selectGoalSnapshot, statusPresentation } from './overview-model';

const catalog = {
  goals: [
    { id: 'g1', category: 'process', title: 'Зрелость процессов', summary: 'Контроль зрелости' },
    { id: 'g2', category: 'data', title: 'Качество данных', summary: '' },
  ],
  leaders: [{ id: 'l1', name: 'Вольнова', teams: ['Команда 1'] }, { id: 'l2', name: 'Сидоров', teams: ['Команда 2'] }],
  assignments: [{ id: 'a1', goalId: 'g1', leaderId: 'l1', teams: [] }, { id: 'a2', goalId: 'g1', leaderId: 'l2', teams: [] }, { id: 'a3', goalId: 'g2', leaderId: 'l2', teams: [] }],
  comments: [], sources: [], entities: [],
} as unknown as CatalogSnapshot;
const evaluation = (goalId: string, leaderId: string, validation: Evaluation['validation']): Evaluation => ({ goalId, leaderId, official: 'met', internal: 'unknown', validation, actual: 100, progress: 100, qualityFlags: [], period: '2026-10', coverage: 100 } as unknown as Evaluation);

describe('director overview', () => {
  it('groups goals by direction and shows every assigned IT leader by name', () => {
    const model = buildOverview({ catalog, evaluations: [], snapshots: [] });
    expect(model.leaders.map(leader => leader.name)).toEqual(['Вольнова', 'Сидоров']);
    expect(model.groups.map(group => group.category)).toEqual(['process', 'data']);
    expect(model.totals.assignments).toBe(3);
    expect(model.totals.unknown).toBe(3);
  });
  it('distinguishes met pending validation from confirmed and never treats unknown as success', () => {
    const model = buildOverview({ catalog, evaluations: [evaluation('g1', 'l1', 'pending'), evaluation('g1', 'l2', 'confirmed')], snapshots: [] });
    expect(model.totals).toMatchObject({ confirmed: 1, pending: 1, unknown: 1 });
    expect(statusPresentation('pending').label).toBe('На проверке УОР');
    expect(statusPresentation('confirmed').label).toBe('Подтверждено');
  });
  it('preserves selected leader scope and consistent counts after filtering', () => {
    const model = buildOverview({ catalog, evaluations: [], snapshots: [] }, { leaderId: 'l1' });
    expect(model.goals.map(row => row.goal.id)).toEqual(['g1']);
    expect(model.goals[0].cells.map(cell => cell.leader.id)).toEqual(['l1']);
    expect(model.totals.assignments).toBe(1);
  });
  it('keeps curator provenance and stale-data flags beside actual values', () => {
    const snap = { id: 's1', status: 'validated', curatorName: 'Куратор УОР', collectedAt: '2026-10-01T00:00:00Z', period: '2026-10', sourceId: 'src', observations: [{ goalId: 'g1', leaderId: 'l1' }] } as unknown as LocalSnapshot;
    const model = buildOverview({ catalog, evaluations: [{ ...evaluation('g1', 'l1', 'pending'), qualityFlags: ['stale_data'] }], snapshots: [snap] });
    expect(model.goals[0].cells[0]).toMatchObject({ provenance: snap, stale: true });
  });
  it('searches leader names while retaining their assigned goals', () => {
    const model = buildOverview({ catalog, evaluations: [], snapshots: [] }, { search: 'вольн' });
    expect(model.leaders.map(leader => leader.id)).toEqual(['l1']);
    expect(model.totals.assignments).toBe(1);
  });
  it('uses provenance from the evaluated period even when another period was imported more recently', () => {
    const current = { id: 'correct-period', status: 'personal', period: '2026-10', collectedAt: '2026-10-20T00:00:00Z', observations: [{ goalId: 'g1', leaderId: 'l1' }] } as unknown as LocalSnapshot;
    const recentOld = { ...current, id: 'recent-old-period', period: '2026-09', collectedAt: '2026-10-24T00:00:00Z' };
    const model = buildOverview({ catalog, evaluations: [evaluation('g1', 'l1', 'pending')], snapshots: [recentOld, current] });
    expect(model.goals[0].cells[0].provenance?.id).toBe('correct-period');
  });
  it('never substitutes a global observation for a named leader source', () => {
    const global = { id: 'global', period: '2026-10', collectedAt: '2026-10-24T00:00:00Z', observations: [{ goalId: 'g1', leaderId: null }] } as unknown as LocalSnapshot;
    expect(selectGoalSnapshot([global], 'g1', 'l1', '2026-10')).toBeUndefined();
    expect(selectGoalSnapshot([global], 'g1', null, '2026-10')?.id).toBe('global');
  });
  it('keeps provenance on the exact fact selection and leaves an empty selection empty', () => {
    const selected = { id: 'selected', period: '2026-10', collectedAt: '2026-10-20T00:00:00Z', observations: [{ goalId: 'g1', leaderId: 'l1' }] } as unknown as LocalSnapshot;
    const other = { ...selected, id: 'other', collectedAt: '2026-10-24T00:00:00Z' };
    expect(selectGoalSnapshot([selected, other], 'g1', 'l1', '2026-10', ['selected'])?.id).toBe('selected');
    expect(selectGoalSnapshot([selected, other], 'g1', 'l1', '2026-10', [])).toBeUndefined();
  });
  it('uses all assignments as the same denominator for every executive chart', () => {
    const model = buildExecutiveModel({ catalog, evaluations: [evaluation('g1', 'l1', 'pending'), { ...evaluation('g1', 'l2', 'pending'), official: 'not_met' }], snapshots: [] });
    expect(model.total).toBe(3);
    expect(model.known).toBe(2);
    expect(model.segments.reduce((total, segment) => total + segment.count, 0)).toBe(3);
    expect(model.segments.find(segment => segment.status === 'confirmed')?.count).toBe(0);
    expect(model.segments.find(segment => segment.status === 'unknown')?.share).toBeCloseTo(100 / 3);
    expect(model.leaders.reduce((total, leader) => total + leader.total, 0)).toBe(3);
    expect(model.directions.reduce((total, direction) => total + direction.total, 0)).toBe(3);
  });
  it('recalculates chart cohorts after filtering and gives deviations first in the action queue', () => {
    const model = buildExecutiveModel({ catalog, evaluations: [evaluation('g1', 'l1', 'pending'), { ...evaluation('g1', 'l2', 'pending'), official: 'not_met' }], snapshots: [] }, { category: 'process' });
    expect(model.total).toBe(2);
    expect(model.knownShare).toBe(100);
    expect(model.actions.map(action => action.status)).toEqual(['not_met', 'pending']);
  });
  it('charts actual practice compliance per participant without averaging metric percentages', () => {
    const observations = [{ participantId: 'p1', participantName: 'Команда', metricId: 'm1', state: 'numeric', value: 95, target: 90 }, { participantId: 'p1', participantName: 'Команда', metricId: 'm2', state: 'numeric', value: 60, target: 80 }, { participantId: 'p1', participantName: 'Команда', metricId: 'm3', state: 'exception', value: null, target: 70 }] as import('../../domain/contracts').Observation[];
    const rows = buildTeamPracticeRows(observations, { direction: 'increase', requiredMetricIds: ['m1', 'm2', 'm3', 'm4'] } as Goal);
    expect(rows[0]).toMatchObject({ eligible: 2, met: 1, share: 50, excluded: 1, missing: 1 });
  });
  it('keeps focus-chart facts and thresholds inside one selected goal', () => {
    const model = buildExecutiveModel({ catalog, evaluations: [{ ...evaluation('g1', 'l1', 'pending'), actual: 75, officialTarget: 80 }, { ...evaluation('g2', 'l2', 'pending'), actual: 20, officialTarget: 30 }], snapshots: [] });
    expect(model.focusGoals.map(goal => goal.id)).toEqual(['g1', 'g2']);
    expect(model.focusRows('g1').filter(row => row.evaluation).map(row => row.evaluation?.actual)).toEqual([75]);
    expect(model.focusRows('g1')[0].evaluation?.officialTarget).toBe(80);
  });
  it('keeps six official directions, explicit unassigned goals and empty resource direction distinct', () => {
    const directions = ['architecture', 'production', 'technical-debt', 'data', 'metla', 'resources'].map((id, order) => ({ id, name: id, description: '', color: '#159d90', order }));
    const source = { ...catalog, directions, goals: [{ ...catalog.goals[0], workDirectionId: 'production' }, { ...catalog.goals[1], workDirectionId: null }], assignments: [...catalog.assignments, { ...catalog.assignments[0], id: 'duplicate-assignment' }] };
    const model = buildDirectionOverview({ catalog: source, evaluations: [], snapshots: [] });
    expect(model.directions).toHaveLength(6);
    expect(model.directions.find(direction => direction.id === 'resources')).toMatchObject({ goals: [], total: 0, coverage: null });
    expect(model.unassigned.goals.map(goal => goal.id)).toEqual(['g2']);
    expect(model.total).toBe(3);
    expect(model.directions.reduce((total, direction) => total + direction.total, model.unassigned.total)).toBe(3);
  });
});
