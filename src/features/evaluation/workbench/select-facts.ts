import type { Applicability, CanonicalSourceRow, EvaluationInput, ManualCorrection, MetricRule, ObservedFact } from '../../../domain/workbench/entities';
import type { BusinessTime, ExactNumber, Header, UtcInstant, VersionRef } from '../../../domain/workbench/primitives';
import { compare, multiply, toRational } from '../../../domain/workbench/exact-number';
import { WorkbenchError } from '../../../domain/workbench/errors';
import { moscowEnd, moscowStart } from '../../../domain/workbench/time';
import { reduceRows } from './reducers';
import type { FactSelection, Freshness, SelectedMetric } from './selection-contracts';

const version = (entityType: string, entity: Header): VersionRef => ({ entityType, id: entity.id, revision: entity.revision });
const key = (ref: VersionRef): string => `${ref.entityType}/${ref.id}/${ref.revision}`;
const refs = (values: VersionRef[]): VersionRef[] => [...new Map(values.map(v => [key(v), v])).values()].sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
const flags = (values: string[]): string[] => [...new Set(values)].sort();
export function aggregateFreshness(values: Freshness[]): Freshness { return values.includes('stale') ? 'stale' : values.includes('unknown') ? 'unknown' : 'fresh'; }
const sameTime = (a: BusinessTime, b: BusinessTime): boolean => a.kind === b.kind && (a.kind === 'unknown' || (a.kind === 'as_of' ? b.kind === 'as_of' && a.date === b.date : b.kind === 'period' && a.startInclusive === b.startInclusive && a.endExclusive === b.endExclusive));

export function factFreshness(input: { fact: ObservedFact; rule: MetricRule; evaluatedAt: UtcInstant }): { freshness: Freshness; qualityFlags: string[] } {
  const { fact, rule, evaluatedAt } = input;
  const time = fact.businessTime;
  const anchor = fact.sourceUpdatedAt !== null ? Date.parse(fact.sourceUpdatedAt)
    : time.kind === 'as_of' ? Date.parse(moscowStart(time.date))
      : time.kind === 'period' ? Date.parse(moscowStart(time.endExclusive)) - 1 : NaN;
  const evaluated = Date.parse(evaluatedAt);
  if (!Number.isFinite(anchor) || !Number.isFinite(evaluated)) return { freshness: 'unknown', qualityFlags: ['unknown_freshness_anchor'] };
  if (anchor > evaluated) return { freshness: 'unknown', qualityFlags: ['future_freshness_anchor'] };
  const stale = compare((evaluated - anchor).toString(), multiply(rule.freshness.maxAgeHours, '3600000')) > 0;
  return { freshness: stale ? 'stale' : 'fresh', qualityFlags: stale ? ['stale_data'] : [] };
}

export function selectEvaluationFacts(input: EvaluationInput): FactSelection {
  if (input.goal.measurementMode !== input.context.businessTime.kind) throw new WorkbenchError('MEASUREMENT_MODE_MISMATCH');
  if (input.method.mode !== 'numeric') throw new WorkbenchError('NUMERIC_METHOD_REQUIRED');
  const business = input.context.businessTime;
  const cutoff = Math.min(Date.parse(input.context.evaluatedAt), business.kind === 'as_of' ? Date.parse(moscowEnd(business.date)) : Infinity);
  const captures = new Map(input.captures.map(c => [c.id, c]));
  const byRef = new Map<string, ObservedFact>(); const conflictingRefs = new Set<string>();
  for (const fact of input.facts) {
    const id = key(version('observed_fact', fact)); const old = byRef.get(id);
    if (old && JSON.stringify(old) !== JSON.stringify(fact)) conflictingRefs.add(id); else byRef.set(id, fact);
  }
  const confirmed = new Set(input.resolution.publicationAnchors.filter(a => a.publicationState === 'confirmed').map(a => a.id));
  const verifiedDirectoryRefs = new Set(input.resolution.directoryLinkRefs.map(key));
  const isPublished = (entity: Header) => entity.publicationAnchorId !== null && confirmed.has(entity.publicationAnchorId);
  const heads = <T extends Header>(values: T[]): T[] => {
    const result = new Map<string, T>(); for (const v of values.filter(isPublished)) if (!result.has(v.id) || result.get(v.id)!.revision < v.revision) result.set(v.id, v);
    return [...result.values()];
  };
  const corrections = heads(input.corrections); const exceptions = heads(input.applicability);
  const population = input.assignment.expectedPopulation;
  if (!population?.length) throw new WorkbenchError('EXPECTED_POPULATION_REQUIRED');

  function applicableRange(a: Applicability): 'full' | 'partial' | 'none' {
    const { startInclusive: start, endExclusive: end } = a.period;
    if (business.kind === 'as_of') return start <= business.date && (end === null || business.date < end) ? 'full' : 'none';
    if ((end !== null && end <= business.startInclusive) || start >= business.endExclusive) return 'none';
    return start <= business.startInclusive && (end === null || business.endExclusive <= end) ? 'full' : 'partial';
  }
  function eligible(fact: ObservedFact): boolean {
    const capture = captures.get(fact.captureId);
    if (!capture || Date.parse(capture.capturedAt) > cutoff || !Number.isFinite(Date.parse(capture.capturedAt)) || Date.parse(fact.recordedAt) > Date.parse(input.context.evaluatedAt)) return false;
    return business.kind === 'as_of' ? fact.businessTime.kind === 'as_of' && fact.businessTime.date <= business.date : sameTime(fact.businessTime, business);
  }

  const metrics: SelectedMetric[] = input.method.rules.map(rule => {
    const result: SelectedMetric = { metricRef: rule.metricRef, applicable: true, value: null, factRefs: [], correctionRefs: [], applicabilityRefs: [], missingPopulation: [], freshness: 'unknown', qualityFlags: [] };
    const problems: string[] = [];
    const matchingExceptions = exceptions.filter(a => a.assignmentId === input.assignment.id && a.metricId === rule.metricRef.id).map(a => ({ value: a, coverage: applicableRange(a) })).filter(a => a.coverage !== 'none');
    result.applicabilityRefs = refs(matchingExceptions.map(a => version('applicability', a.value)));
    if (matchingExceptions.some(a => a.coverage === 'full')) { result.applicable = false; result.freshness = 'fresh'; return result; }
    if (matchingExceptions.length) { result.qualityFlags = ['partial_applicability_period']; return result; }
    const metric = input.metrics.find(m => m.id === rule.metricRef.id && m.revision === rule.metricRef.revision);
    if (!metric) { result.qualityFlags = ['metric_version_missing']; return result; }
    const chosen: ObservedFact[] = [];
    for (const scope of population) {
      const candidates = [...byRef.values()].filter(f => f.sourceId === input.goal.sourceId && f.metricId === metric.id && f.scope.kind === scope.kind && f.scope.id === scope.id && eligible(f));
      candidates.sort((a, b) => {
        if (business.kind === 'as_of' && a.businessTime.kind === 'as_of' && b.businessTime.kind === 'as_of' && a.businessTime.date !== b.businessTime.date) return a.businessTime.date < b.businessTime.date ? 1 : -1;
        return Date.parse(captures.get(b.captureId)!.capturedAt) - Date.parse(captures.get(a.captureId)!.capturedAt);
      });
      const first = candidates[0];
      if (!first) { result.missingPopulation.push({ metricId: metric.id, scope }); continue; }
      const tied = candidates.filter(f => sameTime(f.businessTime, first.businessTime) && Date.parse(captures.get(f.captureId)!.capturedAt) === Date.parse(captures.get(first.captureId)!.capturedAt));
      // Multiple revisions of one logical fact use the exact latest eligible revision, never an ID order.
      const tiedHeads = new Map<string, ObservedFact>();
      for (const fact of tied) if (!tiedHeads.has(fact.id) || tiedHeads.get(fact.id)!.revision < fact.revision) tiedHeads.set(fact.id, fact);
      const alternatives = [...tiedHeads.values()];
      const semanticKey = (f: ObservedFact) => JSON.stringify([f.sourceId, f.metricId, f.scope, f.businessTime, f.state, f.value === null ? null : toRational(f.value), f.missingReason, f.unitCode, f.sourceUpdatedAt, captures.get(f.captureId)!.payloadHash, [...f.lineage.sourceRowKeys].sort(), refs(f.lineage.inputFactRefs), refs(f.lineage.directoryLinkRefs), f.lineage.reducerMethodRef]);
      if (new Set(alternatives.map(semanticKey)).size > 1 || tied.some(f => conflictingRefs.has(key(version('observed_fact', f))))) { problems.push('ambiguous_fact_selection'); result.factRefs.push(...tied.map(f => version('observed_fact', f))); continue; }
      result.factRefs.push(...alternatives.map(f => version('observed_fact', f)));
      const selected = alternatives[0]; chosen.push(selected); result.factRefs.push(version('observed_fact', selected));
      if (selected.state !== 'known') result.missingPopulation.push({ metricId: metric.id, scope });
    }
    const leaves = new Map<string, ObservedFact>();
    const visit = (fact: ObservedFact, visiting: Set<string>) => {
      const id = key(version('observed_fact', fact)); result.factRefs.push(version('observed_fact', fact));
      if (visiting.has(id)) { problems.push('lineage_cycle'); return; }
      if (fact.metricId !== metric.id) { problems.push('lineage_metric_mismatch'); return; }
      if (fact.unitCode !== metric.unit.code) { problems.push('incompatible_units'); return; }
      if (fact.sourceId !== input.goal.sourceId) { problems.push('lineage_source_mismatch'); return; }
      if (!fact.lineage.inputFactRefs.length) { leaves.set(id, fact); return; }
      const path = new Set(visiting); path.add(id);
      for (const ref of fact.lineage.inputFactRefs) {
        const child = byRef.get(key(ref));
        if (ref.entityType !== 'observed_fact' || !child || !eligible(child)) { problems.push('lineage_reference_missing'); continue; }
        if ((child.scope.kind !== fact.scope.kind || child.scope.id !== fact.scope.id) && (!fact.lineage.directoryLinkRefs.length || fact.lineage.directoryLinkRefs.some(ref => !verifiedDirectoryRefs.has(key(ref))))) { problems.push('lineage_scope_mismatch'); continue; }
        visit(child, path);
      }
    };
    chosen.forEach(fact => visit(fact, new Set()));
    const freshness: Freshness[] = []; const rows: CanonicalSourceRow[] = []; const overrides = new Map<string, ExactNumber>();
    const rowOwners = new Map<string, ObservedFact>();
    const overlappingLeaves = new Set<string>();
    const acceptedCorrection = (fact: ObservedFact) => {
      const matching = corrections.filter(c => c.factKey === fact.factKey);
      const usable: Array<{ correction: ManualCorrection; originals: ObservedFact[] }> = [];
      for (const correction of matching) {
        const originals = correction.originalFactRefs.map(ref => byRef.get(key(ref)));
        if (originals.some(f => !f)) { problems.push('correction_original_fact_missing'); continue; }
        const exact = originals.filter((f): f is ObservedFact => !!f);
        if (exact.every(f => f.factKey === fact.factKey && f.sourceId === fact.sourceId && f.metricId === fact.metricId && f.scope.kind === fact.scope.kind && f.scope.id === fact.scope.id && sameTime(f.businessTime, fact.businessTime))) usable.push({ correction, originals: exact });
      }
      for (const item of usable) { result.correctionRefs.push(version('manual_correction', item.correction)); result.factRefs.push(...item.originals.map(f => version('observed_fact', f))); }
      if (usable.length > 1) { problems.push('ambiguous_correction'); return undefined; }
      return usable[0];
    };
    const originalQuality = (original: ObservedFact, visited = new Set<string>()) => {
      const id = key(version('observed_fact', original));
      if (visited.has(id)) { problems.push('lineage_cycle'); return; }
      const path = new Set(visited); path.add(id); result.factRefs.push(version('observed_fact', original));
      if (!eligible(original)) { problems.push('correction_original_fact_missing'); return; }
      const quality = factFreshness({ fact: original, rule, evaluatedAt: input.context.evaluatedAt }); freshness.push(quality.freshness); problems.push(...quality.qualityFlags);
      for (const ref of original.lineage.inputFactRefs) { const child = byRef.get(key(ref)); if (!child) problems.push('correction_original_fact_missing'); else originalQuality(child, path); }
    };
    for (const leaf of leaves.values()) {
      if (leaf.state !== 'known' || leaf.value === null) { freshness.push('unknown'); problems.push('missing_fact'); continue; }
      const accepted = acceptedCorrection(leaf);
      if (accepted) {
        overrides.set(leaf.id, accepted.correction.replacement);
        if (compare(leaf.value, accepted.correction.replacement) !== 0) problems.push('correction_source_discrepancy');
      }
      for (const original of accepted?.originals ?? [leaf]) originalQuality(original);
      const capture = captures.get(leaf.captureId);
      if (!capture || capture.sourceId !== leaf.sourceId || capture.id !== leaf.lineage.captureId) { problems.push('lineage_capture_missing'); continue; }
      const selectedRows = leaf.lineage.sourceRowKeys.map(rowKey => capture.canonicalRows.find(row => row.rowKey === rowKey));
      if (!selectedRows.length || selectedRows.some(row => !row)) { problems.push('lineage_row_missing'); continue; }
      for (const row of selectedRows) if (row) {
        // Raw keys identify rows within a capture, not across independent files.
        const rowKey=JSON.stringify([capture.id,row.rowKey]);
        const previousOwner=rowOwners.get(rowKey);
        if(previousOwner&&previousOwner.id!==leaf.id){overlappingLeaves.add(previousOwner.id);overlappingLeaves.add(leaf.id);}
        rows.push({...row,rowKey}); rowOwners.set(rowKey,leaf);
      }
    }
    let rootOverride: ExactNumber | null = null;
    for (const root of chosen.filter(f => f.lineage.inputFactRefs.length > 0)) {
      const accepted = acceptedCorrection(root); if (!accepted) continue;
      accepted.originals.forEach(original => originalQuality(original));
      if (root.value !== null && compare(root.value, accepted.correction.replacement) !== 0) problems.push('correction_source_discrepancy');
      if (chosen.length === 1) rootOverride = accepted.correction.replacement;
      else problems.push('unsupported_correction_reduction');
    }
    result.factRefs = refs(result.factRefs); result.correctionRefs = refs(result.correctionRefs);
    result.freshness = aggregateFreshness(result.missingPopulation.length ? [...freshness, 'unknown'] : freshness.length ? freshness : ['unknown']);
    const warningOnly = new Set(['stale_data', 'unknown_freshness_anchor', 'future_freshness_anchor', 'correction_source_discrepancy']);
    if (!result.missingPopulation.length && !problems.some(p => !warningOnly.has(p))) {
      if (rule.reducer.kind === 'source_provided_value' && leaves.size === 1 && rows.length === 1) {
        const leaf = [...leaves.values()][0];
        const reduced = reduceRows({ reducer: rule.reducer, rows, unitCode: metric.unit.code, assignmentRef: version('goal_assignment', input.assignment), methodRef: version('method_version', input.method), metricRef: rule.metricRef });
        problems.push(...reduced.qualityFlags);
        if (reduced.value !== null && leaf.value !== null && compare(reduced.value, leaf.value) !== 0) problems.push('fact_source_discrepancy');
        result.value = reduced.value === null ? null : overrides.get(leaf.id) ?? reduced.value;
      } else {
        // Corrections replace a logical observation, not arbitrary numerator/denominator cells.
        // One aggregate replacement is unambiguous; multi-input ratio/count correction needs a dedicated contract.
        if (overrides.size && (rule.reducer.kind === 'ratio' || rule.reducer.kind === 'count')) {
          if (leaves.size === 1 && overrides.size === 1) result.value = [...overrides.values()][0];
          else problems.push('unsupported_correction_reduction');
        } else {
          const replaced = new Set<string>();
          if([...overrides.keys()].some(id=>overlappingLeaves.has(id)))problems.push('unsupported_correction_reduction');
          const correctedRows = rows.flatMap(row => {
            if (!overrides.size || (rule.reducer.kind !== 'sum' && rule.reducer.kind !== 'source_provided_value')) return [row];
            const owner = rowOwners.get(row.rowKey);
            const replacement = owner ? overrides.get(owner.id) : undefined;
            if (replacement === undefined) return [row];
            if (typeof replacement !== 'string' || rule.reducer.kind==='source_provided_value'&&owner!.lineage.sourceRowKeys.length!==1) { problems.push('unsupported_correction_reduction'); return [row]; }
            if (replaced.has(owner!.id)) return [];
            replaced.add(owner!.id);
            return [{ ...row, numbers: { ...row.numbers, [rule.reducer.valueField]: replacement } }];
          });
          const reduced = reduceRows({ reducer: rule.reducer, rows: correctedRows, unitCode: metric.unit.code, assignmentRef: version('goal_assignment', input.assignment), methodRef: version('method_version', input.method), metricRef: rule.metricRef });
          result.value = reduced.value; problems.push(...reduced.qualityFlags);
        }
      }
    }
    if (rootOverride !== null && result.value !== null) result.value = rootOverride;
    result.qualityFlags = flags(problems);
    if (problems.some(p => !warningOnly.has(p))) result.value = null;
    return result;
  });
  const applicable = metrics.filter(m => m.applicable);
  const missingPopulation = applicable.flatMap(m => m.missingPopulation).sort((a, b) => `${a.metricId}/${a.scope.kind}/${a.scope.id}`.localeCompare(`${b.metricId}/${b.scope.kind}/${b.scope.id}`));
  return { metrics, factRefs: refs(metrics.flatMap(m => m.factRefs)), correctionRefs: refs(metrics.flatMap(m => m.correctionRefs)), applicabilityRefs: refs(metrics.flatMap(m => m.applicabilityRefs)), missingMetricIds: applicable.filter(m => m.value === null).map(m => m.metricRef.id).sort(), missingPopulation, complete: applicable.every(m => m.value !== null), freshness: aggregateFreshness(applicable.map(m => m.freshness)), qualityFlags: flags(metrics.flatMap(m => m.qualityFlags)) };
}
