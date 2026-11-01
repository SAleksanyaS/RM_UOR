import type { AgreedSnapshot, Capture, CoreGoalDefinition, EvaluationBasis, GoalAssignment, MethodVersion, ObservedFact, Template } from '../../domain/workbench/entities';
import type { Header, VersionRef } from '../../domain/workbench/primitives';
import { moscowDateSchema, utcInstantSchema, versionRefSchema } from '../../domain/workbench/primitives';
import { WorkbenchError } from '../../domain/workbench/errors';
import { addMoscowDays, moscowEnd } from '../../domain/workbench/time';
import { toRational } from '../../domain/workbench/exact-number';
import type { WorkbenchRepository } from '../../server/storage/workbench-repository';
import { projectFridaySeries } from '../evaluation/workbench/friday';
import type { DailyPoint, HistorySeries, HistorySeriesInput, PeriodHistoryPoint } from './workbench-history-contracts';
import { decodeHistoryCursor, encodeHistoryCursor, historyFingerprint } from './workbench-history-cursor';
const same = (a: VersionRef, b: VersionRef) => a.entityType === b.entityType && a.id === b.id && a.revision === b.revision;
export function queryHistorySeries(input: HistorySeriesInput, repository: WorkbenchRepository): HistorySeries {
    versionRefSchema.parse(input.assignmentRef);
    versionRefSchema.parse(input.metricRef);
    moscowDateSchema.parse(input.fromInclusive);
    moscowDateSchema.parse(input.toExclusive);
    utcInstantSchema.parse(input.evaluatedAt);
    if (input.effectiveAt)
        utcInstantSchema.parse(input.effectiveAt);
    if (input.assignmentRef.entityType !== 'goal_assignment' || input.metricRef.entityType !== 'metric_definition' || !['current', 'agreed'].includes(input.mode) || !['day', 'friday'].includes(input.granularity) || input.fromInclusive >= input.toExclusive || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > 500)
        throw new WorkbenchError('INVALID_HISTORY_QUERY');
    if (input.mode === 'agreed' && !input.snapshotRef)
        throw new WorkbenchError('SNAPSHOT_REQUIRED');
    const exact = <T extends Header>(ref: VersionRef): T => {
        const value = repository.readVersion<T>(ref);
        if (!value)
            throw new WorkbenchError('HISTORICAL_BASIS_UNAVAILABLE', { ref });
        return value;
    };
    const published = <T extends Header>(value: T | null): T => {
        if (!value)
            throw new WorkbenchError('HISTORICAL_BASIS_UNAVAILABLE');
        const anchor = value.publicationAnchorId ? repository.readPublicationAnchor({ entityType: 'publication_anchor', id: value.publicationAnchorId }) : null;
        if (!anchor || anchor.publicationState !== 'confirmed')
            throw new WorkbenchError('REFERENCE_NOT_PUBLISHED');
        if (input.effectiveAt) {
            if (anchor.timeVerification !== 'verified' || !anchor.mergedAt)
                throw new WorkbenchError('EFFECTIVE_TIME_UNVERIFIED');
            if (Date.parse(anchor.mergedAt) > Date.parse(input.effectiveAt))
                throw new WorkbenchError('HISTORICAL_BASIS_UNAVAILABLE');
        }
        return value;
    };
    const head = <T extends Header>(entityType: string, id: string): T => published(input.effectiveAt ? repository.readPublishedAt<T>({ entityType, id }, input.effectiveAt) : repository.readPublishedHead<T>({ entityType, id }));
    let basis: EvaluationBasis | null = null;
    if (input.mode === 'agreed') {
        versionRefSchema.parse(input.snapshotRef);
        if (input.snapshotRef!.entityType !== 'agreed_snapshot')
            throw new WorkbenchError('BASIS_MISMATCH');
        const snapshot = exact<AgreedSnapshot>(input.snapshotRef!);
        basis = exact<EvaluationBasis>(snapshot.basisRef);
        if (!same(basis.assignmentRef, input.assignmentRef))
            throw new WorkbenchError('BASIS_MISMATCH');
        // Validate the saved closure without substituting current catalog heads or current quality.
        for (const ref of [basis.goalRef, basis.methodRef, ...basis.factRefs, ...basis.correctionRefs, ...basis.applicabilityRefs, ...basis.directoryLinkRefs, ...(basis.templateRef ? [basis.templateRef] : []), ...(snapshot.manualStatusRef ? [snapshot.manualStatusRef] : []), ...(snapshot.attestationRef ? [snapshot.attestationRef] : [])])
            exact(ref);
        if (snapshot.numericResult && !same(snapshot.numericResult.basisRef, snapshot.basisRef))
            throw new WorkbenchError('BASIS_MISMATCH');
    }
    const assignment = basis ? exact<GoalAssignment>(basis.assignmentRef) : published(exact<GoalAssignment>(input.assignmentRef));
    const goal = basis ? exact<CoreGoalDefinition>(basis.goalRef) : head<CoreGoalDefinition>('core_goal_definition', assignment.goalId);
    const template = !basis && assignment.methodBinding.kind === 'template' ? head<Template>('template', assignment.methodBinding.templateId) : null;
    const methodRef = basis?.methodRef ?? template?.methodRef ?? (assignment.methodBinding.kind === 'standalone' ? assignment.methodBinding.methodRef : null);
    if (!methodRef)
        throw new WorkbenchError('BASIS_MISMATCH');
    const method = basis ? exact<MethodVersion>(methodRef) : published(exact<MethodVersion>(methodRef));
    if (method.mode !== 'numeric' || !method.rules.some(r => same(r.metricRef, input.metricRef)))
        throw new WorkbenchError('BASIS_MISMATCH');
    if (basis)
        exact(input.metricRef);
    else
        published(exact(input.metricRef));
    if (basis && input.effectiveAt)
        for (const ref of [basis.assignmentRef, basis.goalRef, basis.methodRef, ...basis.directoryLinkRefs])
            published(exact(ref));
    const fingerprint = historyFingerprint({ ...input, cursor: null });
    const position = input.cursor ? decodeHistoryCursor(input.cursor, fingerprint) : null;
    if (goal.measurementMode === 'period' && input.granularity === 'day') {
        let periodFacts: ObservedFact[];
        let nextCursor: string | null = null;
        const periodCaptures = new Map<string, Capture>();
        if (basis) {
            if (position !== null && (!Number.isSafeInteger(position) || Number(position) < 0))
                throw new WorkbenchError('INVALID_CURSOR');
            const all = basis.factRefs.map(ref => exact<ObservedFact>(ref)).filter(f => f.metricId === input.metricRef.id && f.sourceId === goal.sourceId && f.scope.kind === assignment.scope.kind && f.scope.id === assignment.scope.id && f.businessTime.kind === 'period' && f.businessTime.startInclusive >= input.fromInclusive && f.businessTime.startInclusive < input.toExclusive).sort((a, b) => JSON.stringify(a.businessTime).localeCompare(JSON.stringify(b.businessTime)) || a.id.localeCompare(b.id) || a.revision - b.revision);
            const offset = Number(position ?? 0);
            periodFacts = all.slice(offset, offset + input.limit);
            if (offset + input.limit < all.length)
                nextCursor = encodeHistoryCursor(fingerprint, offset + input.limit);
        }
        else {
            if (position !== null && typeof position !== 'string')
                throw new WorkbenchError('INVALID_CURSOR');
            const page = repository.readHistoryRecords({ assignmentRef: input.assignmentRef, metricRef: input.metricRef, scope: assignment.scope, sourceId: goal.sourceId, fromInclusive: input.fromInclusive, toExclusive: input.toExclusive, capturedBefore: input.evaluatedAt, cursor: position as string | null, limit: input.limit });
            periodFacts = page.facts.filter(f => f.businessTime.kind === 'period');
            page.captures.forEach(c => periodCaptures.set(c.id, c));
            if (page.nextCursor)
                nextCursor = encodeHistoryCursor(fingerprint, page.nextCursor);
        }
        const points = periodFacts.filter(f => basis || Date.parse(f.recordedAt) <= Date.parse(input.evaluatedAt)).map(f => {
            const c = periodCaptures.get(f.captureId) ?? repository.getHead<Capture>({ entityType: 'capture', id: f.captureId });
            if (!c)
                throw new WorkbenchError('HISTORICAL_BASIS_UNAVAILABLE');
            return { assignmentId: assignment.id, metricId: input.metricRef.id, businessTime: f.businessTime, value: f.value, sourceFactRef: { entityType: 'observed_fact', id: f.id, revision: f.revision }, sourceCapturedAt: c.capturedAt } satisfies PeriodHistoryPoint;
        });
        return { mode: input.mode, basisRef: basis ? { entityType: 'evaluation_basis', id: basis.id, revision: basis.revision } : null, points, nextCursor, qualityFlags: [] };
    }
    if (position !== null && (typeof position !== 'string' || !moscowDateSchema.safeParse(position).success || position < input.fromInclusive || position >= input.toExclusive))
        throw new WorkbenchError('INVALID_CURSOR');
    let start = position as string | null ?? input.fromInclusive;
    if (input.granularity === 'friday')
        start = addMoscowDays(start, (5 - new Date(start + 'T00:00:00Z').getUTCDay() + 7) % 7);
    if (start >= input.toExclusive)
        return { mode: input.mode, basisRef: basis ? { entityType: 'evaluation_basis', id: basis.id, revision: basis.revision } : null, points: [], nextCursor: null, qualityFlags: [] };
    // Time windows bound memory and preserve explicit daily gaps. A raw page is independently keyset-paginated.
    let end = start;
    for (let n = 0; n < input.limit && end < input.toExclusive; n++) {
        const days = input.granularity === 'friday' ? 7 : 1;
        const remaining = (Date.parse(input.toExclusive + 'T00:00:00Z') - Date.parse(end + 'T00:00:00Z')) / 86400000;
        end = remaining <= days ? input.toExclusive : addMoscowDays(end, days);
    }
    let facts: ObservedFact[] = [];
    const captures = new Map<string, Capture>();
    if (basis) {
        facts = basis.factRefs.map(ref => exact<ObservedFact>(ref)).filter(f => f.sourceId === goal.sourceId && f.metricId === input.metricRef.id && f.scope.kind === assignment.scope.kind && f.scope.id === assignment.scope.id);
        for (const f of facts) {
            const c = repository.getHead<Capture>({ entityType: 'capture', id: f.captureId });
            if (!c)
                throw new WorkbenchError('HISTORICAL_BASIS_UNAVAILABLE');
            captures.set(c.id, c);
        }
    }
    else {
        let cursor: string | null = null;
        do {
            const page = repository.readHistoryRecords({ assignmentRef: input.assignmentRef, metricRef: input.metricRef, scope: assignment.scope, sourceId: goal.sourceId, fromInclusive: start, toExclusive: end, capturedBefore: input.evaluatedAt, cursor, limit: 500, ...(input.granularity === 'friday' ? { predecessorBefore: new Date(Math.min(Date.parse(input.evaluatedAt), Date.parse(moscowEnd(start)))).toISOString() } : {}) });
            facts.push(...page.facts);
            if (page.predecessors)
                facts.push(...page.predecessors);
            else if (page.predecessor)
                facts.push(page.predecessor);
            page.captures.forEach(c => captures.set(c.id, c));
            cursor = page.nextCursor;
        } while (cursor);
    }
    if (!basis && input.granularity === 'friday') {
        // A prior business date can be captured between Fridays. Re-resolve the
        // indexed predecessor at each boundary rather than freezing the first one.
        for (let friday = addMoscowDays(start, 7); friday < end; friday = addMoscowDays(friday, 7)) {
            const page = repository.readHistoryRecords({ assignmentRef: input.assignmentRef, metricRef: input.metricRef, scope: assignment.scope, sourceId: goal.sourceId, fromInclusive: start, toExclusive: end, capturedBefore: input.evaluatedAt, cursor: null, limit: 1, predecessorBefore: new Date(Math.min(Date.parse(input.evaluatedAt), Date.parse(moscowEnd(friday)))).toISOString() });
            facts.push(...(page.predecessors ?? (page.predecessor ? [page.predecessor] : [])));
            page.captures.forEach(c => captures.set(c.id, c));
        }
    }
    facts = facts.filter(f => Date.parse(f.recordedAt) <= Date.parse(input.evaluatedAt) && Date.parse(captures.get(f.captureId)!.capturedAt) <= Date.parse(input.evaluatedAt));
    let points: HistorySeries['points'];
    if (input.granularity === 'friday')
        points = projectFridaySeries({ assignmentRef: input.assignmentRef, metricRef: input.metricRef, scope: assignment.scope, facts, captures: [...captures.values()], fromInclusive: start, toExclusive: end, evaluatedAt: input.evaluatedAt });
    else {
        points = [];
        for (let date = start; date < end; date = addMoscowDays(date, 1)) {
            const heads = new Map<string, ObservedFact>();
            for (const f of facts)
                if (!heads.has(f.id) || heads.get(f.id)!.revision < f.revision)
                    heads.set(f.id, f);
            const eligible = [...heads.values()].filter(f => f.businessTime.kind === 'as_of' && f.businessTime.date === date && Date.parse(captures.get(f.captureId)!.capturedAt) <= Math.min(Date.parse(input.evaluatedAt), Date.parse(moscowEnd(date))));
            eligible.sort((a, b) => Date.parse(captures.get(b.captureId)!.capturedAt) - Date.parse(captures.get(a.captureId)!.capturedAt) || b.revision - a.revision || a.id.localeCompare(b.id));
            const f = eligible[0];
            if (f) {
                const tied = eligible.filter(x => Date.parse(captures.get(x.captureId)!.capturedAt) === Date.parse(captures.get(f.captureId)!.capturedAt));
                const semantics = (x: ObservedFact) => JSON.stringify([x.value === null ? null : toRational(x.value), x.unitCode, x.state, captures.get(x.captureId)!.payloadHash, [...x.lineage.sourceRowKeys].sort()]);
                if (new Set(tied.map(semantics)).size > 1)
                    throw new WorkbenchError('AMBIGUOUS_FACT_SELECTION');
            }
            points.push({ assignmentId: assignment.id, metricId: input.metricRef.id, date, value: f?.value ?? null, sourceFactRef: f ? { entityType: 'observed_fact', id: f.id, revision: f.revision } : null, sourceBusinessTime: f?.businessTime ?? null, sourceCapturedAt: f ? captures.get(f.captureId)!.capturedAt : null } satisfies DailyPoint);
        }
    }
    return { mode: input.mode, basisRef: basis ? { entityType: 'evaluation_basis', id: basis.id, revision: basis.revision } : null, points, nextCursor: end < input.toExclusive ? encodeHistoryCursor(fingerprint, end) : null, qualityFlags: [] };
}
