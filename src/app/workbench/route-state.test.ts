import { expect, it } from 'vitest';
import { fixtureId } from '../../../tests/fixtures/workbench/factories';
import type { GlobalContext } from '../../server/workbench/protocol';
import { readRouteState, routeUrl, updateGlobalContext, businessTimeFromRange } from './route-state';

const base: GlobalContext = { scopePath: { ditId: fixtureId(100), clusterId: fixtureId(103), productId: fixtureId(101), teamId: fixtureId(104) }, goalId: null, time: { kind: 'as_of', date: '2026-10-28' }, resultMode: 'current', snapshotId: null };
it('normalizes_parent_scope_and_history', () => {
  const next = updateGlobalContext(base, { scopePath: { clusterId: fixtureId(106) } });
  expect(next.scopePath).toEqual({ ditId: base.scopePath.ditId, clusterId: fixtureId(106), productId: null, teamId: null });
  const historical = { ...next, resultMode: 'agreed' as const, snapshotId: fixtureId(110), time: businessTimeFromRange({ from: '2026-10-01', to: '2026-11-01' }) };
  const url = routeUrl('/goals', historical);
  expect(readRouteState(url, base)).toMatchObject({ pathname: '/goals', context: historical });
  expect(readRouteState(routeUrl('/data', next), base).context).toEqual(next);
  expect(readRouteState('/overview', null).context).toBeNull();
  const root = updateGlobalContext(base, { scopePath: { clusterId: null } });
  expect(readRouteState(routeUrl('/overview', root), base).context?.scopePath).toEqual(root.scopePath);
});
it('does_not_turn_invalid_snapshot_or_time_into_an_agreed_result', () => {
  const route = readRouteState(`/goals?dit=${base.scopePath.ditId}&mode=agreed&snapshot=invalid&at=2026-02-30`, base);
  expect(route.context).toMatchObject({ resultMode: 'agreed', snapshotId: null, time: base.time });
  expect(route.warnings.length).toBeGreaterThan(0);
  expect(readRouteState(`/overview?dit=${base.scopePath.ditId}&mode=current&snapshot=${fixtureId(110)}`, base).context?.snapshotId).toBeNull();
  expect(() => businessTimeFromRange({ from: '2026-11-01', to: '2026-10-01' })).toThrow();
});
it('roundtrips_cleared_goal_and_snapshot_against_nonnull_saved_defaults', () => {
  const saved: GlobalContext = { ...base, goalId: fixtureId(11), resultMode: 'agreed', snapshotId: fixtureId(110) };
  expect(readRouteState('/goals', saved).context).toEqual(saved);
  const clearedGoal = { ...saved, goalId: null, snapshotId: null };
  expect(readRouteState(routeUrl('/goals', clearedGoal), saved).context).toEqual(clearedGoal);
  const clearedSnapshot = { ...saved, snapshotId: null };
  expect(readRouteState(routeUrl('/goals', clearedSnapshot), saved).context).toEqual(clearedSnapshot);
});
