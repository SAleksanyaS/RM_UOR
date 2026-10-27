import { describe, expect, it } from 'vitest';
import { entityReferences, entitySchemas, parseEntity, publicationAnchorSchema, validateCustomFieldValue, validateReferences } from './schemas';
import { fixtureId, makeEntityGraph, makeHeader, makeNumericFixture, versionRef } from '../../../tests/fixtures/workbench/factories';

describe('versioned domain schemas', () => {
  it('registers every header entity and validates a complete reference graph', () => {
    expect([...entitySchemas.keys()].sort()).toEqual([
      'core_goal_definition', 'goal_assignment', 'template', 'metric_definition', 'method_version', 'directory_entity', 'directory_link',
      'source_field_mapping', 'source_definition', 'capture', 'observed_fact', 'applicability', 'manual_correction', 'manual_status_event',
      'work', 'work_dependency', 'decision', 'custom_field_def', 'custom_field_value', 'commentary', 'evidence', 'dashboard_def',
      'business_calendar', 'reminder_settings', 'evaluation_basis', 'calculation_result', 'attestation', 'agreed_snapshot',
    ].sort());
    const graph = makeEntityGraph();
    for (const anchor of graph.anchors) publicationAnchorSchema.parse(anchor);
    const versions = new Map<string, unknown>();
    for (const { entityType, value } of graph.entries) {
      parseEntity(entityType, value);
      versions.set(`${entityType}/${value.id}`, value);
      versions.set(`${entityType}/${value.id}/${value.revision}`, value);
    }
    for (const anchor of graph.anchors) versions.set(`publication_anchor/${anchor.id}`, anchor);
    for (const { entityType, value } of graph.entries) {
      validateReferences(entityReferences(entityType, value), ref => versions.get(`${ref.entityType}/${ref.id}${'revision' in ref ? '/' + ref.revision : ''}`) ?? null);
    }
    expect(makeNumericFixture({ seedBase: 1000 }).goal.id).not.toBe(graph.input.goal.id);
  });

  it('rejects_invalid_domain_and_cross_references', () => {
    const i = makeNumericFixture();
    if (i.method.mode !== 'numeric') throw new Error('numeric fixture required');
    const rule = i.method.rules[0];
    for (const rules of [
      [{ ...rule, originalWeight: '-1' }], [{ ...rule, originalWeight: '0' }], [rule, rule],
      [{ ...rule, condition: { op: 'range', min: '2', max: '1' } }],
      [{ ...rule, freshness: { maxAgeHours: '0', updateEveryHours: '24' } }],
    ]) expect(() => parseEntity('method_version', { ...i.method, rules })).toThrow();
    expect(() => parseEntity('goal_assignment', { ...i.assignment, expectedPopulation: [] })).toThrow();
    expect(() => parseEntity('goal_assignment', { ...i.assignment, expectedPopulation: [i.assignment.scope, i.assignment.scope] })).toThrow();
    expect(() => parseEntity('observed_fact', { ...i.facts[0], state: 'missing', value: '0', missingReason: 'gap' })).toThrow();
    expect(() => parseEntity('observed_fact', { ...i.facts[0], value: null })).toThrow();
    expect(() => parseEntity('capture', { ...i.captures[0], acceptedRows: -1 })).toThrow();
    expect(() => parseEntity('method_version', { ...i.method, extra: true })).toThrow();
    expect(() => validateReferences([{ ref: versionRef('directory_entity', 201), expectedEntityTypes: ['metric_definition'] }], () => i.metrics[0])).toThrow();
    expect(() => validateReferences([{ ref: versionRef('method_version', 1, 999), expectedEntityTypes: ['method_version'] }], () => null)).toThrow();
    expect(() => makeNumericFixture({ values: ['1', '2'], weights: ['1'] })).toThrow();
  });

  it('validates_extension_values_and_manual_states', () => {
    const objectRef = { entityType: 'goal_assignment', id: fixtureId(501) };
    const field = { ...makeHeader(801), name: 'Demo', entityTypes: ['goal_assignment'], valueType: 'enum' as const, enumValues: ['a', 'b'] };
    const value = { ...makeHeader(802), objectRef, fieldRef: versionRef('custom_field_def', 801), value: 'a' };
    expect(() => validateCustomFieldValue(value, field)).not.toThrow();
    expect(() => validateCustomFieldValue({ ...value, value: 'c' }, field)).toThrow();
    expect(() => validateCustomFieldValue({ ...value, value: ['a', 'a'] }, { ...field, valueType: 'multi_enum' })).toThrow();
    expect(() => validateCustomFieldValue({ ...value, value: '2026-02-29' }, { ...field, valueType: 'date', enumValues: null })).toThrow();
    expect(() => validateCustomFieldValue(value, { ...field, id: fixtureId(803) })).toThrow();
    expect(() => parseEntity('commentary', { ...makeHeader(804), targetRef: objectRef, text: '  ' })).toThrow();
    expect(() => parseEntity('evidence', { ...makeHeader(805), kind: 'url', url: 'https://user:pass@example.org/proof' })).toThrow();
    expect(() => parseEntity('evidence', { ...makeHeader(805), kind: 'file', file: { artifactId: fixtureId(806), bytes: -1 } })).toThrow();
    const file = { artifactId: fixtureId(806), hash: 'sha256:' + 'a'.repeat(64), mimeType: 'text/plain', bytes: 0 };
    expect(() => parseEntity('evidence', { ...makeHeader(805), kind: 'file', file })).not.toThrow();
    expect(() => parseEntity('evidence', { ...makeHeader(805), kind: 'url', url: 'https://example.org/proof' })).not.toThrow();
    expect(() => parseEntity('evidence', { ...makeHeader(805), kind: 'file', file, url: 'https://example.org/proof' })).toThrow();
    const event = { ...makeHeader(807), assignmentId: objectRef.id, from: null, to: 'completed', resultDescription: null, reason: null, evidenceIds: [] };
    expect(() => parseEntity('manual_status_event', event)).toThrow();
    expect(() => parseEntity('manual_status_event', { ...event, from: 'completed', to: 'in_progress' })).toThrow();
    expect(() => parseEntity('decision', { ...makeHeader(808), workId: fixtureId(809), request: 'Help', requestedFromPersonId: fixtureId(810), dueOn: '2026-10-30', answer: 'Yes', answeredAt: null })).toThrow();
    expect(() => parseEntity('work_dependency', { ...makeHeader(811), predecessorWorkId: fixtureId(809), successorWorkId: fixtureId(809), active: true, changeReason: null })).toThrow();
    expect(() => parseEntity('reminder_settings', { ...makeHeader(812), calendarId: fixtureId(813), dailyAt: '25:00', repeatEveryWorkdays: 1 })).toThrow();
    expect(() => parseEntity('business_calendar', { ...makeHeader(813), timeZone: 'Europe/Moscow', workingWeekdays: [1, 2, 3, 4, 5], exceptions: [{ date: '2026-10-30', working: true }, { date: '2026-10-30', working: false }] })).toThrow();
  });

  it('validates source profiles and separates publication and row revisions', () => {
    const graph = makeEntityGraph();
    const mapping = graph.entries.find(e => e.entityType === 'source_field_mapping')!.value;
    const parsed = parseEntity('source_field_mapping', mapping);
    expect(parsed.parsingProfile).toEqual({ sheetName: null, csvDelimiter: ',', csvEncoding: 'utf8', dateFormat: 'iso', decimalSeparator: '.', groupSeparator: 'none' });
    expect(() => parseEntity('source_field_mapping', { ...mapping, parsingProfile: { ...parsed.parsingProfile, groupSeparator: 'dot' } })).toThrow();
    const source = parseEntity('source_definition', graph.entries.find(e => e.entityType === 'source_definition')!.value);
    expect(() => parseEntity('source_definition', { ...source, browserScenarioRef: versionRef('method_version', 2) })).toThrow();
    const anchor = graph.anchors[0];
    expect(publicationAnchorSchema.parse({ ...anchor, revision: 7 }).revision).toBe(7);
    expect(() => publicationAnchorSchema.parse({ ...anchor, timeVerification: 'verified', mergedAt: null })).toThrow();
  });

  it('checks the meaning of linked goals, scopes and custom field definitions', () => {
    const graph = makeEntityGraph();
    const resolve = (ref: { entityType: string; id: string; revision?: number }) => graph.entries.find(e => e.entityType === ref.entityType && e.value.id === ref.id && (ref.revision === undefined || e.value.revision === ref.revision))?.value ?? graph.anchors.find(a => ref.entityType === 'publication_anchor' && a.id === ref.id) ?? null;
    expect(() => validateReferences(entityReferences('goal_assignment', { ...graph.input.assignment, expectedPopulation: null }), resolve)).toThrow();
    expect(() => validateReferences(entityReferences('goal_assignment', { ...graph.input.assignment, scope: { kind: 'cluster', id: graph.input.assignment.scope.id } }), resolve)).toThrow();
    const source = parseEntity('source_definition', graph.entries.find(e => e.entityType === 'source_definition')!.value);
    expect(() => validateReferences(entityReferences('source_definition', { ...source, kind: 'manual_status' }), resolve)).toThrow();
    const definition = { ...makeHeader(850), name: 'Demo', entityTypes: ['goal_assignment'], valueType: 'enum' as const, enumValues: ['a'] };
    const fieldValue = { ...makeHeader(851), objectRef: { entityType: 'goal_assignment', id: graph.input.assignment.id }, fieldRef: versionRef('custom_field_def', 850), value: 'b' };
    expect(() => validateReferences(entityReferences('custom_field_value', fieldValue), ref => ref.entityType === 'custom_field_def' ? definition : resolve(ref))).toThrow();
  });
});
