import type { LocalSnapshot } from '../../domain/contracts';

export interface SelectFactsInput {
  mode: 'personal' | 'published' | 'auto'; goalId: string; leaderId?: string | null; period: string;
  sourceId?: string; personal: LocalSnapshot[]; published: LocalSnapshot[];
  freshnessHours?: number; now?: string | number | Date; personalError?: string | null;
}
export interface SelectedFacts {
  snapshot: LocalSnapshot | null; provenance: 'personal' | 'published' | 'none'; isStale: boolean;
  ageHours: number | null; personalError: string | null;
  reason: 'personal_selected' | 'published_selected' | 'published_fallback' | 'no_matching_data'; warnings: string[];
}
/** Business freshness never becomes newer merely because an old period was downloaded again. */
export const snapshotBusinessDate = (snapshot: Pick<LocalSnapshot, 'period' | 'sourceUpdatedAt' | 'collectedAt'>) => {
  const periodAt = /^\d{4}-\d{2}-\d{2}$/.test(snapshot.period) ? Date.parse(`${snapshot.period}T23:59:59Z`) : NaN;
  const at = Date.parse(snapshot.sourceUpdatedAt ?? (Number.isFinite(periodAt) ? `${snapshot.period}T00:00:00Z` : snapshot.collectedAt));
  return Number.isFinite(periodAt) ? Math.min(at, periodAt) : at;
};
export function snapshotFreshness(snapshot: Pick<LocalSnapshot, 'period' | 'sourceUpdatedAt' | 'collectedAt'>, freshnessHours = 168, now: string | number | Date = Date.now()) {
  const clock = now instanceof Date ? now.getTime() : typeof now === 'number' ? now : Date.parse(now);
  const date = snapshotBusinessDate(snapshot);
  const ageHours = Number.isFinite(date) && Number.isFinite(clock) ? Math.max(0, (clock - date) / 3_600_000) : null;
  return { ageHours, isStale: ageHours === null || ageHours > freshnessHours };
}

/** Select one immutable source snapshot. Explicit modes never silently fall back. */
export function selectFacts(input: SelectFactsInput): SelectedFacts {
  const now = input.now ?? Date.now();
  const freshness = (snapshot: LocalSnapshot) => snapshotFreshness(snapshot, input.freshnessHours, now);
  const stale = (snapshot: LocalSnapshot) => freshness(snapshot).isStale;
  const matches = (snapshot: LocalSnapshot) => snapshot.period === input.period
    && (!input.sourceId || snapshot.sourceId === input.sourceId)
    && snapshot.observations.some((row) => row.goalId === input.goalId && row.period === input.period
      && (!input.leaderId || row.leaderId === input.leaderId));
  const latest = (snapshots: LocalSnapshot[]) => snapshots.filter(matches).sort((a, b) => {
    const aTime = snapshotBusinessDate(a), bTime = snapshotBusinessDate(b);
    return (Number.isFinite(bTime) ? bTime : -Infinity) - (Number.isFinite(aTime) ? aTime : -Infinity)
      || Date.parse(b.collectedAt) - Date.parse(a.collectedAt) || a.id.localeCompare(b.id);
  })[0] ?? null;
  const personal = latest(input.personal);
  const published = latest(input.published.filter((snapshot) => snapshot.status === 'validated'
    && !!snapshot.curatorId && !!snapshot.validatedAt));
  let snapshot: LocalSnapshot | null = null;
  let provenance: SelectedFacts['provenance'] = 'none';
  let reason: SelectedFacts['reason'] = 'no_matching_data';
  const warnings: string[] = [];
  if (personal && stale(personal)) warnings.push('personal_snapshot_stale');
  if (input.mode === 'personal' || (input.mode === 'auto' && personal && !stale(personal))) {
    snapshot = personal; provenance = personal ? 'personal' : 'none';
    reason = personal ? 'personal_selected' : 'no_matching_data';
  } else if (input.mode === 'published') {
    snapshot = published; provenance = published ? 'published' : 'none';
    reason = published ? 'published_selected' : 'no_matching_data';
  } else if (published && (!personal || (!stale(published) || snapshotBusinessDate(published) > snapshotBusinessDate(personal)))) {
    snapshot = published; provenance = 'published'; reason = 'published_fallback';
  } else if (personal) {
    snapshot = personal; provenance = 'personal'; reason = 'personal_selected';
  }
  const isStale = snapshot ? stale(snapshot) : false;
  if (isStale) warnings.push('selected_snapshot_stale');
  if (snapshot?.limitations.length) warnings.push('snapshot_has_limitations');
  return { snapshot, provenance, isStale, ageHours: snapshot ? freshness(snapshot).ageHours : null,
    personalError: input.personalError ?? null, reason, warnings };
}
