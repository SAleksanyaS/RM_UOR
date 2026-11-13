import assert from 'node:assert/strict';
import test from 'node:test';
import { compareStatusSnapshots, registerKey } from '../src/status-snapshots.mjs';

const period = 'Q4 2026';
const risk = 'есть риски';
const onTrack = 'в плане';
const done = 'выполнено';
const noMethod = 'нет методики для оценки статуса исполнения';

function row(keyResult, status, sourceRow, fields = {}) {
  return {
    id: sourceRow + ':' + period,
    sourceRow, period, objective: 'Цель ДИТ', keyResult, leader: 'Лидер А.',
    plan: 80, fact: 60, progress: 0.75, status, ...fields,
  };
}

function snapshot(id, asOf, entries) {
  return { source: { id, name: id + '.xlsx' }, asOf, entries };
}

test('identifies a KR independently of period, source row, and mapped goal', () => {
  const before = row('Выпустить продукт', onTrack, 16);
  const moved = row('  выпустить   продукт ', done, 211, {
    objective: 'Цель\u00a0ДИТ', leader: ' лидер а. ', period: 'Y26', goalId: 'SW26.1', scopeId: 'leader-a',
  });
  assert.ok(registerKey(before));
  assert.equal(registerKey(before), registerKey(moved));
  assert.notEqual(registerKey(before), registerKey({ ...before, leader: 'Лидер Б.' }));
  assert.notEqual(registerKey(before), registerKey({ ...before, objective: 'Другая цель' }));
  assert.equal(registerKey({ ...before, leader: null }), null);
});

test('compares only the selected period and distinguishes unverified or missing risks', () => {
  const before = snapshot('previous', '2026-10-27', [
    row('Новый риск', onTrack, 13),
    row('Закрытый риск', risk, 14),
    row('Оставшийся риск', risk, 15),
    row('Пропавшая строка', risk, 16),
    row('Пропал статус', risk, 17),
    row('Неизвестное предыдущее состояние', noMethod, 18),
    row('Переместился', onTrack, 19, { fact: 60, progress: 0.75 }),
    row('Другой период', risk, 20, { period: 'Y26' }),
    row('Дубликат', risk, 21),
    row('Дубликат', risk, 22),
    row('Дубликат в новом срезе', risk, 23),
    row('Нет лидера', risk, 24, { leader: '' }),
  ]);
  const after = snapshot('current', '2026-11-03', [
    row('Новый риск', ' ЕСТЬ   РИСКИ ', 39),
    row('Закрытый риск', done, 40),
    row('Оставшийся риск', risk, 41),
    row('Пропал статус', noMethod, 42),
    row('Неизвестное предыдущее состояние', risk, 43),
    row('Впервые в срезе', risk, 44),
    row('Переместился', 'В плане', 45, { fact: 90, progress: 1.125 }),
    row('Пропавшая строка', done, 46, { period: 'Y26' }),
    row('Другой период', done, 47, { period: 'Y26' }),
    row('Дубликат', done, 48),
    row('Дубликат в новом срезе', done, 49),
    row('Дубликат в новом срезе', risk, 50),
  ]);
  const diff = compareStatusSnapshots(before, after, { period });
  assert.equal(diff.period, period);
  assert.deepEqual(diff.previous, { source: before.source, asOf: before.asOf });
  assert.deepEqual(diff.current, { source: after.source, asOf: after.asOf });
  const names = items => items.map(pair => (pair.current ?? pair.previous).keyResult);
  assert.deepEqual(names(diff.newRisks), ['Новый риск']);
  assert.deepEqual(names(diff.closedRisks), ['Закрытый риск']);
  assert.deepEqual(names(diff.persistingRisks), ['Оставшийся риск']);
  assert.deepEqual(names(diff.missingRisks), ['Пропавшая строка']);
  assert.deepEqual(diff.unverifiedRisks.map(item => [item.current.keyResult, item.reason]), [
    ['Неизвестное предыдущее состояние', 'unknownPreviousStatus'],
    ['Впервые в срезе', 'missingPrevious'],
  ]);
  assert.deepEqual(diff.unresolvedRisks.map(item => [item.current.keyResult, item.reason]), [
    ['Пропал статус', 'unknownCurrentStatus'],
  ]);
  const moved = diff.changed.find(item => item.current.keyResult === 'Переместился');
  assert.deepEqual([moved.previous.sourceRow, moved.current.sourceRow], [19, 45]);
  assert.deepEqual(moved.fields, [
    { name: 'fact', previous: 60, current: 90 },
    { name: 'progress', previous: 0.75, current: 1.125 },
  ]);
  assert.deepEqual(diff.ambiguous.map(item => [item.previous.length, item.current.length]), [[2, 1], [1, 2]]);
  assert.deepEqual(diff.withoutIdentity.map(item => [item.side, item.entry.sourceRow]), [['previous', 24]]);
  assert.equal(diff.counts.matched, 6);
});

test('requires an explicit period and real ordered snapshot dates', () => {
  const dated = snapshot('dated', '2026-11-03', []);
  assert.throws(() => compareStatusSnapshots(dated, dated), /период/iu);
  assert.throws(() => compareStatusSnapshots(dated, dated, { period }), /дата/iu);
  assert.throws(() => compareStatusSnapshots(snapshot('invalid', '2026-02-30', []), dated, { period }), /дата/iu);
});
