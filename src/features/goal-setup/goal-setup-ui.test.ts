import { expect, it } from 'vitest';
import { createSetupForm, makeSetupInput, setupStepError } from './goal-setup-ui';
import type { CatalogSnapshot } from '../../domain/contracts';

const catalog = { goals: [], assignments: [], sources: [], entities: [], leaders: [{ id: 'l1', name: 'Лидер', teams: [] }] } as unknown as CatalogSnapshot;
it('keeps a new form empty rather than inventing an official threshold or actual result', () => {
  const form = createSetupForm(catalog, 'Куратор');
  expect(form.title).toBe(''); expect(form.officialTarget).toBe(''); expect(form.samples).toEqual([]);
  expect(setupStepError(0, form, catalog)).toMatch(/название/i);
});
it('builds explicit leader aggregate scope and numeric input without saving samples as facts', () => {
  const form = { ...createSetupForm(catalog, 'Куратор'), title: 'Стабильность сервиса', ownerId: 'Владелец', officialTarget: '99,9', selectedLeaders: ['l1'] };
  const input = makeSetupInput(form, catalog);
  expect(input.goal.officialTarget).toBe(99.9);
  expect(input.measurement.metrics[0].target).toBe(99.9);
  expect(input.assignments).toEqual([{ leaderId: 'l1', participantIds: ['l1'] }]);
  expect(input.sample.rows).toEqual([]);
});
it('rejects a participant-share scope without selected teams and preserves explicit team scope', () => {
  const form = { ...createSetupForm(catalog, 'Куратор'), kind: 'participant_share' as const, selectedLeaders: ['l1'], officialTarget: '80' };
  expect(setupStepError(2, form, catalog)).toMatch(/команд/i);
  const withTeams = { ...form, participants: { l1: ['team-1'] } };
  expect(makeSetupInput(withTeams, catalog).assignments[0].participantIds).toEqual(['team-1']);
  expect(makeSetupInput(withTeams, catalog).measurement.aggregation).toBe('average');
});
it('requires an explicit nonzero base for a percent change and valid range bounds', () => {
  const form = { ...createSetupForm(catalog, 'Куратор'), kind: 'change' as const, changeMode: 'percent' as const, changeBaseline: '0', officialTarget: '10' };
  expect(setupStepError(1, form, catalog)).toMatch(/нул/i);
  expect(setupStepError(1, { ...form, kind: 'range', rangeMin: '10', rangeMax: '5' }, catalog)).toMatch(/границ/i);
});
it('creates an explicit DIT-wide goal without inventing leader assignments', () => {
  const form = { ...createSetupForm(catalog, 'Куратор'), globalGoal: true, title: 'Общий результат ДИТ', officialTarget: '90' };
  expect(setupStepError(2, form, catalog)).toBeNull();
  const input = makeSetupInput(form, catalog); expect(input.assignments).toEqual([]); expect(input.goal.scopeType).toBe('global');
});
