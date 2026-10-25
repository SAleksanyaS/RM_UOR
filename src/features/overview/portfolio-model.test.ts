import { describe, expect, it } from 'vitest';
import type { CatalogSnapshot, Evaluation, Goal, LocalSnapshot } from '../../domain/contracts';
import type { OverviewInput } from './overview-model';
import { buildPortfolioModel } from './portfolio-model';

const catalog = {
  goals: [{ id: 'g1', title: 'Первая цель', category: 'process', summary: '', weight: 1000 }, { id: 'g2', title: 'Вторая цель', category: 'data', summary: '', weight: 1 }],
  leaders: [{ id: 'l1', name: 'Лидер А', teams: [] }, { id: 'l2', name: 'Лидер Б', teams: [] }],
  assignments: [{ id: 'a1', goalId: 'g1', leaderId: 'l1', teams: [] }, { id: 'a2', goalId: 'g1', leaderId: 'l2', teams: [] }, { id: 'a3', goalId: 'g2', leaderId: 'l2', teams: [] }],
  sources: [], comments: [], entities: [],
} as unknown as CatalogSnapshot;
const evaluation = (goalId: string, leaderId: string | null, official: Evaluation['official'], validation: Evaluation['validation'] = 'not_required', actual: number | null = 80): Evaluation =>
  ({ id: `${goalId}:${leaderId ?? 'all'}`, goalId, leaderId, official, internal: 'unknown', validation, actual, period: '2026-10-02', qualityFlags: [],
    progress: actual === null ? null : official === 'met' ? 100 : actual, officialTarget: official === 'met' ? actual : 80, internalTarget: null, fingerprint: 'fixture',
    eligibleMetrics: actual === null ? 0 : 1, metMetrics: official === 'met' ? 1 : 0, eligibleParticipants: actual === null ? 0 : 1,
    metParticipants: official === 'met' ? 1 : 0, excluded: 0, missing: 0, coverage: actual === null ? null : 100 });
const input = (evaluations: Evaluation[] = [], overrides: Partial<OverviewInput> = {}): OverviewInput => ({ catalog, evaluations, snapshots: [], ...overrides });

describe('goal portfolio projection', () => {
  it('keeps goals without facts visible and counts unknown as missing coverage', () => {
    const model = buildPortfolioModel(input());
    expect(model.goalCount).toBe(2); expect(model.assignmentCount).toBe(3);
    expect(model).toMatchObject({ knownGoals: 0, confirmedGoals: 0, remainingGoals: 2, coverage: 0, assignmentCoverage: 0, overall: 'insufficient_data' });
    expect(model.segments.find(segment => segment.status === 'unknown')).toMatchObject({ count: 2, share: 100 });
    expect(model.goals.every(row => row.status === 'unknown')).toBe(true);
  });

  it('uses the global official goal result even when one leader misses an individual target', () => {
    const model = buildPortfolioModel(input([
      evaluation('g1', null, 'met', 'confirmed', 80), evaluation('g1', 'l1', 'not_met', 'not_required', 20), evaluation('g1', 'l2', 'met', 'confirmed', 100),
    ]), 'g1');
    expect(model.goals[0].status).toBe('confirmed'); expect(model.goals[0].evaluation?.actual).toBe(80);
    expect(model).toMatchObject({ overall: 'confirmed', confirmedGoals: 1, remainingGoals: 0, knownAssignments: 2 });
    expect(model.leaders.find(row => row.leader.id === 'l1')?.segments.find(segment => segment.status === 'not_met')?.count).toBe(1);
  });

  it('does not substitute fully known leader results for a missing global evaluation', () => {
    const model = buildPortfolioModel(input([evaluation('g1', 'l1', 'met', 'confirmed'), evaluation('g1', 'l2', 'met', 'confirmed')]), 'g1');
    expect(model).toMatchObject({ knownGoals: 0, coverage: 0, knownAssignments: 2, assignmentCoverage: 1, overall: 'insufficient_data' });
    expect(model.goals[0].status).toBe('unknown'); expect(model.goals[0].evaluation).toBeUndefined();
  });

  it('deduplicates goal-leader assignments and excludes inactive-only goals', () => {
    const duplicated = { ...catalog, goals: [...catalog.goals, { ...catalog.goals[0] }, { id: 'inactive-goal', category: 'process' } as Goal],
      leaders: [...catalog.leaders, { ...catalog.leaders[0] }], assignments: [...catalog.assignments, { ...catalog.assignments[0], id: 'duplicate' },
        { id: 'inactive', goalId: 'inactive-goal', leaderId: 'l1', teams: [], active: false }] };
    const model = buildPortfolioModel(input([], { catalog: duplicated }));
    expect(model.goalCount).toBe(2); expect(model.assignmentCount).toBe(3);
    expect(model.leaders.reduce((sum, leader) => sum + leader.total, 0)).toBe(3);
    expect(model.goals.reduce((sum, goal) => sum + goal.totalAssignments, 0)).toBe(3);
  });

  it('filters the entire cohort to one selected goal even when that goal has no facts', () => {
    const source = input([evaluation('g1', null, 'met', 'confirmed')]);
    expect(buildPortfolioModel(source).goals.map(row => row.goal.id)).toEqual(['g1', 'g2']);
    const selected = buildPortfolioModel(source, 'g2');
    expect(selected.goals.map(row => row.goal.id)).toEqual(['g2']);
    expect(selected).toMatchObject({ goalCount: 1, assignmentCount: 1, remainingGoals: 1, overall: 'insufficient_data', periods: [] });
    expect(selected.leaders.map(row => row.leader.id)).toEqual(['l2']);
    expect(buildPortfolioModel(source, 'missing')).toMatchObject({ goalCount: 0, coverage: null, assignmentCoverage: null, overall: 'no_goals' });
  });

  it('counts distinct goal statuses without averaging incomparable actual values or weights', () => {
    const model = buildPortfolioModel(input([evaluation('g1', null, 'met', 'confirmed', 90), evaluation('g2', null, 'met', 'pending', 2)]));
    expect(model).toMatchObject({ goalCount: 2, knownGoals: 2, confirmedGoals: 1, remainingGoals: 1, coverage: 1, overall: 'validation' });
    expect(model.segments.find(segment => segment.status === 'confirmed')).toMatchObject({ count: 1, share: 50 });
    expect(model.segments.find(segment => segment.status === 'pending')).toMatchObject({ count: 1, share: 50 });
    expect(model).not.toHaveProperty('actual'); expect(model).not.toHaveProperty('weightedScore');
  });

  it('gives insufficient data precedence over attention and attention precedence over validation', () => {
    expect(buildPortfolioModel(input([evaluation('g1', null, 'not_met')])).overall).toBe('insufficient_data');
    expect(buildPortfolioModel(input([evaluation('g1', null, 'not_met'), evaluation('g2', null, 'met', 'pending')])).overall).toBe('attention');
    expect(buildPortfolioModel(input([evaluation('g1', null, 'met', 'confirmed'), evaluation('g2', null, 'met', 'confirmed')])).overall).toBe('confirmed');
    expect(buildPortfolioModel(input([], { catalog: { ...catalog, goals: [], assignments: [] } })).overall).toBe('no_goals');
  });

  it('takes periods only from current selections and keeps stale known facts distinct from coverage', () => {
    const selected = { id: 'selected', period: '2026-10-02', collectedAt: '2026-10-03T00:00:00Z', observations: [{ goalId: 'g1', leaderId: 'l1' }] } as unknown as LocalSnapshot;
    const history = { ...selected, id: 'history', period: '2026-09-01' };
    const empty = { ...selected, id: 'empty', period: '2026-10-24', observations: [] };
    const model = buildPortfolioModel(input([
      { ...evaluation('g1', null, 'met', 'pending'), qualityFlags: ['stale'], snapshotIds: ['selected'] },
      evaluation('g2', null, 'not_met', 'not_required', 0),
      { ...evaluation('g1', 'l2', 'unknown', 'not_required', null), period: '2026-10-24', snapshotIds: [] },
    ], { snapshots: [history, selected, empty] }));
    expect(model.periods).toEqual(['2026-10-02']);
    expect(model).toMatchObject({ knownGoals: 2, coverage: 1, staleGoals: 1, overall: 'attention' });
    expect(model.goals.find(row => row.goal.id === 'g1')?.stale).toBe(true);
  });

  it('shows a new global goal before assignment and makes an inactive goal explicitly selectable without inventing facts', () => {
    const source = { ...catalog, goals: [{ ...catalog.goals[0], id: 'global-new' }, { ...catalog.goals[1], id: 'inactive' }],
      assignments: [{ id: 'inactive-only', goalId: 'inactive', leaderId: 'l1', teams: [], active: false }] };
    const all = buildPortfolioModel(input([], { catalog: source }));
    expect(all.goals.map(row => row.goal.id)).toEqual(['global-new']);
    expect(all).toMatchObject({ goalCount: 1, assignmentCount: 0, coverage: 0, assignmentCoverage: null, overall: 'insufficient_data' });
    expect(all.goals[0]).toMatchObject({ cells: [], status: 'unknown' });
    const selected = buildPortfolioModel(input([], { catalog: source }), 'inactive');
    expect(selected.goals.map(row => row.goal.id)).toEqual(['inactive']);
    expect(selected).toMatchObject({ goalCount: 1, assignmentCount: 0, knownGoals: 0, coverage: 0, overall: 'insufficient_data', periods: [] });
    const confirmed = buildPortfolioModel(input([evaluation('global-new', null, 'met', 'confirmed')], { catalog: source }));
    expect(confirmed).toMatchObject({ goalCount: 1, confirmedGoals: 1, assignmentCount: 0, overall: 'confirmed' });
  });
});
