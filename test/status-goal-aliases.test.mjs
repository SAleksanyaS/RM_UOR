import assert from 'node:assert/strict';
import test from 'node:test';
import { statusGoalAlias } from '../src/status-goal-aliases.mjs';

const source = {
  objective: 'КПЭ Блока Т',
  direction: '#Техландшафт #Производственный_процесс',
  keyResult: 'Доля команд мигрировали на Dream Jenkins',
  period: 'Q4 2026',
  plan: 100,
};

test('matches a whole known KR only in its objective, direction, and measure', () => {
  assert.equal(statusGoalAlias(source), 'SW26');
  assert.equal(statusGoalAlias({ ...source, direction: '#Производственный_процесс  #Техландшафт' }), 'SW26');
  assert.equal(statusGoalAlias({ ...source, objective: 'Другая цель' }), null);
  assert.equal(statusGoalAlias({ ...source, direction: '#Данные #Техландшафт' }), null);
  assert.equal(statusGoalAlias({ ...source, keyResult: source.keyResult + ' / планы сопровождения' }), null);
  assert.equal(statusGoalAlias({ ...source, plan: 95 }), null);
});

test('keeps period-specific and conflicting-threshold variants for review', () => {
  const offers = {
    objective: 'КПЭ Блока Т (вне скоупа целей А.Венкова)',
    direction: '#Техландшафт #Данные',
    keyResult: 'Выполняется цель 98% по исполнению оферт',
    plan: 98,
  };
  assert.equal(statusGoalAlias({ ...offers, period: 'Q4 2026' }), 'SD04.19');
  assert.equal(statusGoalAlias({ ...offers, period: 'Y26', keyResult: 'Выполняется цель 97% по исполнению оферт' }), null);
  assert.equal(statusGoalAlias({ ...offers, period: 'Y26' }), null);

  const replica = {
    ...offers, objective: source.objective, period: 'Y26', plan: 26,
    keyResult: 'Обеспечена T2Data загрузки данных в КАП (создание реплики) р.д.',
  };
  assert.equal(statusGoalAlias(replica), 'SD37.10');
  assert.equal(statusGoalAlias({ ...replica, keyResult: replica.keyResult.replace('создание', 'расширение') }), null);
});
