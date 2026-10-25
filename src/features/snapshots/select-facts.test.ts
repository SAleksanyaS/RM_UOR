import { describe, expect, it } from 'vitest';
import type { LocalSnapshot, Observation } from '../../domain/contracts';
import { selectFacts } from './select-facts';

function snapshot(id: string, overrides: Partial<LocalSnapshot> = {}): LocalSnapshot {
  return { id, classification: 'demo', sourceId: 'demo', period: '2026-10',
    observations: [{ goalId: 'goal-demo', leaderId: 'leader-demo', period: '2026-10' } as Observation],
    collectedAt: '2026-10-24T10:00:00Z', sourceUpdatedAt: '2026-10-24T10:00:00Z', origin: 'demo',
    dataHash: id, status: 'personal', curatorId: null, curatorName: null, validatedAt: null,
    limitations: [], evidenceIds: [], ...overrides };
}
const base = { mode: 'auto' as const, goalId: 'goal-demo', leaderId: 'leader-demo', period: '2026-10',
  now: '2026-10-24T12:00:00Z', freshnessHours: 24, personal: [] as LocalSnapshot[], published: [] as LocalSnapshot[] };
function published(id: string, overrides: Partial<LocalSnapshot> = {}) {
  return snapshot(id, { status: 'validated', curatorId: 'curator-demo', curatorName: 'Куратор демо',
    validatedAt: '2026-10-24T11:00:00Z', ...overrides });
}

describe('selectFacts', () => {
  it('prefers a matching fresh personal snapshot in auto mode', () => {
    const personal = snapshot('personal');
    const result = selectFacts({ ...base, personal: [personal], published: [published('public')] });
    expect(result.snapshot?.id).toBe('personal');
    expect(result.provenance).toBe('personal');
    expect(result.isStale).toBe(false);
    expect(result.ageHours).toBe(2);
  });

  it('falls back to validated published facts and preserves personal error', () => {
    const result = selectFacts({ ...base, published: [published('public')], personalError: 'Нет доступа к источнику' });
    expect(result.snapshot?.id).toBe('public');
    expect(result.provenance).toBe('published');
    expect(result.reason).toBe('published_fallback');
    expect(result.personalError).toBe('Нет доступа к источнику');
  });

  it('rejects unpublished or incompletely validated snapshots', () => {
    const result = selectFacts({ ...base, published: [snapshot('unvalidated'), published('bad', { validatedAt: null })] });
    expect(result.snapshot).toBeNull();
    expect(result.provenance).toBe('none');
  });

  it('never crosses goal, source, leader or period boundaries', () => {
    const result = selectFacts({ ...base, sourceId: 'demo', published: [
      published('wrong-period', { period: '2026-09' }),
      published('wrong-source', { sourceId: 'other' }),
      published('wrong-goal', { observations: [{ goalId: 'other', leaderId: 'leader-demo', period: '2026-10' } as Observation] }),
      published('wrong-leader', { observations: [{ goalId: 'goal-demo', leaderId: 'other', period: '2026-10' } as Observation] }),
    ] });
    expect(result.snapshot).toBeNull();
  });

  it('explicit personal mode does not silently substitute public facts', () => {
    const result = selectFacts({ ...base, mode: 'personal', published: [published('public')] });
    expect(result.snapshot).toBeNull();
  });

  it('explicit published mode does not silently substitute personal facts', () => {
    const result = selectFacts({ ...base, mode: 'published', personal: [snapshot('personal')] });
    expect(result.snapshot).toBeNull();
  });

  it('prefers fresh public data over stale personal facts', () => {
    const stale = snapshot('old', { sourceUpdatedAt: '2026-10-01T00:00:00Z' });
    const result = selectFacts({ ...base, personal: [stale], published: [published('public')] });
    expect(result.snapshot?.id).toBe('public');
    expect(result.warnings).toContain('personal_snapshot_stale');
  });

  it('uses source date for freshness rather than the recent download date', () => {
    const stale = snapshot('old', { sourceUpdatedAt: '2026-10-01T00:00:00Z' });
    const result = selectFacts({ ...base, mode: 'personal', personal: [stale] });
    expect(result.snapshot?.id).toBe('old');
    expect(result.isStale).toBe(true);
    expect(result.warnings).toContain('selected_snapshot_stale');
  });

  it('deterministically picks the freshest available source snapshot', () => {
    const stale = snapshot('old', { sourceUpdatedAt: '2026-10-01T00:00:00Z' });
    const recent = snapshot('recent');
    expect(selectFacts({ ...base, personal: [recent, stale] }).snapshot?.id).toBe('recent');
    expect(selectFacts({ ...base, personal: [stale, recent] }).snapshot?.id).toBe('recent');
  });
  it('does not treat a newly downloaded historical file with unknown source date as fresh', () => {
    const period = '2026-10-02';
    const rows = [{ goalId: 'goal-demo', leaderId: 'leader-demo', period } as Observation];
    const personal = snapshot('old-personal', { period, observations: rows, sourceUpdatedAt: null });
    const shared = published('checked-historical', { period, observations: rows, sourceUpdatedAt: '2026-10-02T12:00:00Z' });
    const result = selectFacts({ ...base, period, personal: [personal], published: [shared] });
    expect(result.snapshot?.id).toBe('checked-historical');
    expect(result.provenance).toBe('published'); expect(result.isStale).toBe(true);
  });
});
