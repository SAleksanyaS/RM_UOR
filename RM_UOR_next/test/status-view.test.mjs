import assert from 'node:assert/strict';
import test from 'node:test';
import { renderStatusPage, renderStatusRows } from '../public/status-view.js';

const helpers = {
  escape: value => String(value ?? '').replace(/&/gu, '&amp;').replace(/</gu, '&lt;'),
  numberFormat: new Intl.NumberFormat('ru-RU'),
  statusLabel: value => value,
  rowBadge: () => '',
  heading: title => `<h1>${title}</h1>`,
  empty: () => '',
  option: (value, label, selected) => `<option value="${value}"${value === selected ? ' selected' : ''}>${label}</option>`,
};
const period = 'Q4 2026';

function model(entries, leader = '') {
  return { register: { entries, periods: [period] }, filters: { period, leader }, leaders: ['Кластер А', 'Кластер Б'] };
}

test('shows an Excel plan next to the fact and leaves multi-KR evidence to the goal details', () => {
  const html = renderStatusRows(model([
    { goalId: 'a', objective: 'Цель А', scopeId: 'lead-a', leader: 'Кластер А', period, rows: [{ plan: 0, fact: 25 }] },
    { goalId: 'b', objective: 'Цель Б', scopeId: 'lead-b', leader: 'Кластер Б', period, rows: [{ plan: 100, fact: 98 }, { plan: 20, fact: 12 }] },
  ]), helpers);
  assert.match(html, /<th[^>]*>План<\/th><th[^>]*>Текущий факт<\/th>/u);
  assert.match(html, /<td[^>]*>0<\/td><td[^>]*>25<\/td>/u);
  assert.match(html, /colspan="2"[^>]*>2 КР · план и факт в деталях/u);
  assert.doesNotMatch(html, />98<|>12</u);
});

test('DIT mode uses explicit plan and fact and retains the leaders in the scope chooser', () => {
  const entries = [
    { goalId: 'a', objective: 'Цель А', scopeId: 'dit', leader: 'ДИТ OPS', period, plan: '80%', fact: '75%', basis: 'Охват < 8', rows: [{ plan: 90, fact: 93 }] },
    { goalId: 'b', objective: 'Цель Б', scopeId: 'lead-b', leader: 'Кластер Б', period, rows: [{ plan: 99, fact: 96 }] },
  ];
  const html = renderStatusPage(model(entries, '@dit'), helpers);
  assert.match(html, /<option value="@dit" selected>Весь ДИТ<\/option>/u);
  assert.match(html, /<option value="Кластер А">Кластер А<\/option>/u);
  assert.match(html, /<td[^>]*>80%<\/td><td[^>]*>75%<p[^>]*>Охват &lt; 8<\/p><\/td>/u);
  assert.doesNotMatch(html, /Цель Б|>93<|>96</u);
});
