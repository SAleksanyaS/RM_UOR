import assert from 'node:assert/strict';
import test from 'node:test';
import { projectDitGoalStatuses, projectGoalStatuses } from '../public/goal-status.js';
import { renderMapOverview, summarizeMap } from '../public/map-overview.js';

const period = 'Q4 2026';
const directory = [
  { id: 'a', name: 'Анна', type: 'leader' },
  { id: 'b', name: 'Борис', type: 'leader' },
];
const row = (scopeId, status) => ({ scopeId, status, period, mode: 'manual' });
const excel = (goalId, scopeId, status, linkState = 'confirmed', selectedPeriod = period) =>
  ({ goalId, scopeId, status, linkState, period: selectedPeriod, progress: 1.2, plan: 80, fact: 96 });
const goal = (id, scope, extra = {}) => ({ id, assignments: [{ leaderId: scope }], ...extra });

test('overview counts explicit statuses per assignment and prefers reliably linked Excel evidence', () => {
  const goals = [
    goal('excel-done', 'a', { published: [row('a', 'Есть риски')] }),
    goal('risk', 'a'),
    goal('unknown', 'a'),
    goal('incomplete', 'b', { published: [row('b', 'Выполнено')] }),
    goal('fallback', 'b', { local: [row('b', 'Выполнено')] }),
    goal('missing', 'b', { local: [{ ...row('b', 'Выполнено'), mode: 'automatic' }] }),
    goal('monitor', 'a', { status: 'monitor' }),
    goal('inactive', 'b', { assignments: [{ leaderId: 'b', active: false }] }),
  ];
  const report = [
    excel('excel-done', 'a', 'Выполнено', 'suggested'),
    excel('risk', 'a', 'Выполнено'), excel('risk', 'a', 'Есть риски'), excel('risk', 'a', 'Нет данных'),
    excel('unknown', 'a', 'Выполнено'), excel('unknown', 'a', 'Нет данных'),
    excel('incomplete', 'b', 'В плане'), excel('incomplete', 'b', ''), excel('incomplete', 'b', 'Есть риски', 'suggested'),
    excel('fallback', 'b', 'Есть риски', 'suggested'), excel('fallback', 'b', 'Есть риски', 'suggested'),
    excel('missing', 'b', 'Выполнено', 'confirmed', 'Y26'),
    excel('monitor', 'a', 'Выполнено'), excel('inactive', 'b', 'Выполнено'),
  ];
  const result = summarizeMap(goals, directory, period, report);
  const counts = ({ assigned, assessed, completed, risk, excel, preliminary }) =>
    [assigned, assessed, completed, risk, excel, preliminary];
  assert.deepEqual(result.leaders.map(counts), [[3, 2, 1, 1, 1, 1], [3, 1, 0, 0, 1, 0]]);
  assert.deepEqual(counts(result.total), [6, 3, 1, 1, 2, 1]);
});

test('shared projection keeps unknown eligible assignments and original evidence for each period', () => {
  const goals = [goal('unknown', 'a', { title: 'Цель A' }), goal('method', 'a'), goal('accepted', 'b'), goal('done', 'b')];
  const rows = [
    excel('unknown', 'a', 'Выполнено'), excel('unknown', 'a', 'Нет данных'),
    excel('method', 'a', 'Нет методики для оценки статуса исполнения'),
    excel('accepted', 'b', 'Риск принят', 'suggested'), excel('done', 'b', 'Выполнено', 'confirmed', 'Y26'),
    excel('done', 'outside', 'Выполнено'),
  ];
  const projected = projectGoalStatuses(goals, directory, { entries: rows, periods: [period, 'Y26', period] });
  assert.equal(projected.length, 8);
  assert.equal(new Set(projected.map(entry => entry.id)).size, 8);
  const current = projected.filter(entry => entry.period === period);
  assert.deepEqual(current.map(entry => entry.status), ['', 'Нет методики', 'Под риском', '']);
  assert.equal(current[0].objective, 'Цель A');
  assert.deepEqual(current[0].rows, rows.slice(0, 2));
  assert.equal(current[2].preliminary, true);
  assert.equal(projected.find(entry => entry.period === 'Y26' && entry.goalId === 'done').status, 'Выполнено');
});

test('overview renders counts and explicitly marks missing coverage', () => {
  const escape = value => String(value ?? '');
  const view = renderMapOverview({ goals: [goal('unassessed', 'a')], directory, period, periods: [period], leaderId: '' }, {
    escape, option: value => `<option>${value}</option>`, numberFormat: new Intl.NumberFormat('ru-RU'),
  });
  assert.match(view, /Выполнено\s+—\s+из 1/);
  assert.match(view, /Под риском\s+—/);
  assert.match(view, /Статус есть у 0 из 1/);
  assert.match(view, /Нет данных о статусах за выбранный период/);
  assert.match(view, /data-action="map-leader" data-id="a"/);
  assert.doesNotMatch(view, /%|<progress|К плану/);
});

test('DIT uses an explicit Excel total or shows the leader spread without fabricating a total', () => {
  const goals = [goal('maturity', 'a', { title: 'Модель зрелости', target: '80% команд', assignments: [{ leaderId: 'a' }, { leaderId: 'b' }] })];
  const leaderRows = [{ ...excel('maturity', 'a', 'Выполнено'), fact: 83, keyResult: 'Доля команд' },
    { ...excel('maturity', 'b', 'Выполнено'), fact: 100, keyResult: 'Доля команд' }];
  const [withoutTotal] = projectDitGoalStatuses(goals, directory, { periods: [period], entries: leaderRows });
  assert.deepEqual([withoutTotal.scopeId, withoutTotal.plan, withoutTotal.fact, withoutTotal.status], ['dit', 80, null, 'Выполнено']);
  assert.match(withoutTotal.basis, /83–100/);
  const total = { ...excel('maturity', 'dit', 'Есть риски'), fact: 97 };
  const [withTotal] = projectDitGoalStatuses(goals, directory, { periods: [period], entries: [...leaderRows, total] });
  assert.deepEqual([withTotal.plan, withTotal.fact, withTotal.status], [80, 97, 'Под риском']);
  assert.deepEqual(withTotal.rows, [total]);
  const [overridden] = projectDitGoalStatuses(goals, directory, { periods: [period], entries: [...leaderRows, total] }, [period],
    [{ goalId: 'maturity', period, status: 'В плане' }]);
  assert.deepEqual([overridden.plan, overridden.fact, overridden.status], [80, 97, 'В плане']);
  assert.match(overridden.basis, /Ручной статус ДИТ/);
});
