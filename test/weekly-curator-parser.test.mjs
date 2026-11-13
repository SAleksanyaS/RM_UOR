import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCuratorWeeks } from '../src/weekly-curator-parser.mjs';

test('reads the explicitly dated SberTrack interval and bounded Russian sections', () => {
  const [report] = parseCuratorWeeks([
    'Направление: Практики разработки · 10.10.2026 - 17.10.2026',
    'Топ-3', 'достижения за неделю',
    '1. Сверили выгрузку', '   по всем командам.', '2) Уточнили методику',
    '3. Обновили карту', '4. Четвёртый пункт не входит',
    'Требует внимания:', '• Нет данных за октябрь', 'Планы на следующую неделю: Проверить расчёт',
    'Инсайты недели', '— Уточнение справочника меняет состав',
  ].join('\n'));
  assert.deepEqual(report, {
    week: '2026-10-12',
    range: { start: '2026-10-10', end: '2026-10-17' },
    sections: {
      achievements: ['Сверили выгрузку\nпо всем командам.', 'Уточнили методику', 'Обновили карту'],
      attention: ['Нет данных за октябрь'],
      plans: ['Проверить расчёт'],
      insights: ['Уточнение справочника меняет состав'],
    },
  });
});

test('supports ISO weeks, explicit Monday starts, and a Monday-to-Monday interval', () => {
  const parsed = parseCuratorWeeks([
    '## 2026-W01', '**Главные выполненные задачи УОР**', 'Действие без маркера', 'Ещё одно действие',
    'Отчётная неделя: 02.11.2026', 'Планы следующей недели', '• Передать сводку',
    '09.11.2026 — 16.11.2026 · Надёжность', 'Топ 3 задачи', '– Изучить данные',
  ].join('\r\n'));
  assert.deepEqual(parsed.map(entry => entry.week), ['2025-12-29', '2026-11-02', '2026-11-16']);
  assert.deepEqual(parsed[0].sections.achievements, ['Действие без маркера', 'Ещё одно действие']);
  assert.equal(parsed[1].range, undefined);
  assert.deepEqual(parsed[2].range, { start: '2026-11-09', end: '2026-11-16' });
});

test('reads compact direction headings and leaves placeholder sections empty', () => {
  const [report] = parseCuratorWeeks('Практики разработки 10.10.2026 - 17.10.2026\nТоп-3 достижения\nНет данных\nТоп 3 внимания\n• Уточнить вводные\nТоп-3 плана\n- Сверить список\nТоп-3 инсайта\n- Формат пригодится');
  assert.deepEqual(report.sections, { achievements: [], attention: ['Уточнить вводные'], plans: ['Сверить список'], insights: ['Формат пригодится'] });
});

test('does not infer dates from prose or let invalid boundaries contaminate valid weeks', () => {
  assert.deepEqual(parseCuratorWeeks('Достижения\n- Обновили статус 05.11.2026'), []);
  assert.deepEqual(parseCuratorWeeks('Отчётная неделя: 03.11.2026\nТребует внимания\n- Нет выгрузки'), []);
  assert.deepEqual(parseCuratorWeeks('2025-W53\nИнсайты\n- Нет такой недели'), []);
  assert.deepEqual(parseCuratorWeeks('Отчётная неделя: 31.02.2026\nИнсайты\n- Невозможная дата'), []);
  assert.deepEqual(parseCuratorWeeks('02.11.2026 - 20.11.2026\nПланы\n- Диапазон длиннее недели'), []);
  const [report] = parseCuratorWeeks('2026-W45\nДостижения\n- Одно дело\n2026-W99\nИнсайты\n- Не попадёт в предыдущую неделю');
  assert.deepEqual(report.sections.insights, []);
});

test('deduplicates exact reports and omits conflicting blocks for one week', () => {
  const a = '2026-W45\nДостижения\n- Первое';
  const b = '2026-W46\nИнсайты\n- Отдельная неделя';
  assert.equal(parseCuratorWeeks(a + '\n' + a).length, 1);
  assert.deepEqual(parseCuratorWeeks(a + '\n' + b + '\n' + a.replace('Первое', 'Другое')).map(entry => entry.week), ['2026-11-09']);
  assert.deepEqual(parseCuratorWeeks(a + '\nДостижения\n- Второй конфликт'), []);
});
