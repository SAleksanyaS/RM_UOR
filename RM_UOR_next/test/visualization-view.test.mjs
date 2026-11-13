import assert from 'node:assert/strict';
import test from 'node:test';
import { renderVisualization, renderVisualizationEditor } from '../public/visualization-view.js';

const helpers = {
  escape: value => String(value ?? ''),
  heading: (title, copy) => `<h1>${title}</h1><p>${copy}</p>`,
  empty: () => '',
  statusLabel: value => value,
  option: (value, label, current) => `<option value="${value}"${current === value ? ' selected' : ''}>${label}</option>`,
  numberFormat: new Intl.NumberFormat('ru-RU'),
};
const period = 'Q4 2026';
const entries = [
  { goalId: 'GOAL1', scopeId: 'lead-1', objective: 'Общее название', leader: 'Руководитель А', status: '', period },
  { goalId: 'GOAL2', scopeId: 'lead-1', objective: 'Общее название', leader: 'Руководитель А', status: 'в плане', period },
  { goalId: 'GOAL2', scopeId: 'lead-2', objective: 'Общее название', leader: 'Руководитель Б', status: 'в плане', period },
];
const card = { id: 'chart', title: 'Статусы карты', kind: 'table', group: 'status', period, status: '', leader: '' };
const model = { register: { entries, periods: [period] }, cards: [card] };

test('counts goal assignments and includes unknown status without drilling to a broader list', () => {
  const html = renderVisualization(model, helpers);
  assert.match(html, /Назначения целей/u);
  assert.match(html, /<strong>3<\/strong>/u);
  assert.match(html, /<span>Нет статуса<\/span>.*<td>1<\/td>/u);
  assert.doesNotMatch(html, /data-status=""[^>]*>Нет статуса/u);
  assert.match(html, /data-action="viz-drill" data-period="Q4 2026" data-status="в плане"/u);
});

test('keeps distinct goal identities and forwards canonical drill identifiers with legacy text', () => {
  const html = renderVisualization({ ...model, cards: [{ ...card, group: 'objective' }] }, helpers);
  assert.match(html, /data-objective="Общее название" data-goal-id="GOAL1"/u);
  assert.match(html, /data-objective="Общее название" data-goal-id="GOAL2"/u);
  const leader = renderVisualization({ ...model, cards: [{ ...card, group: 'leader' }] }, helpers);
  assert.match(leader, /data-leader="Руководитель Б"[^>]*data-scope-id="lead-2"/u);
});

test('editor shows assignment vocabulary and only canonical leader names', () => {
  const html = renderVisualizationEditor({ ...model, editingCard: { ...card, leader: 'Старое имя из книги' } }, helpers);
  assert.match(html, /Все статусы/u);
  assert.match(html, /<option value="objective">Цель<\/option>/u);
  assert.match(html, /Руководитель А/u);
  assert.doesNotMatch(html, /Старое имя из книги/u);
});
