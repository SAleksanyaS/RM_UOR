import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readStatusRegister } from '../src/status-register.mjs';
import { openWorkspace } from '../src/workspace.mjs';

// Store three small OOXML parts without compression to keep the test independent of Office.
function workbookBytes(sheet) {
  const parts = {
    'xl/workbook.xml': '<workbook><sheets><sheet name="Реестр" r:id="r1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="r1" Target="worksheets/sheet.xml" Type="http://test/worksheet"/></Relationships>',
    'xl/worksheets/sheet.xml': sheet,
  };
  const local = [];
  const directory = [];
  let offset = 0;
  let directorySize = 0;
  for (const [path, xml] of Object.entries(parts)) {
    const name = Buffer.from(path);
    const data = Buffer.from(xml);
    const member = Buffer.alloc(30);
    member.writeUInt32LE(0x04034b50, 0);
    member.writeUInt32LE(data.length, 18);
    member.writeUInt32LE(data.length, 22);
    member.writeUInt16LE(name.length, 26);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt32LE(data.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(offset, 42);
    offset += member.length + name.length + data.length;
    directorySize += header.length + name.length;
    local.push(member, name, data);
    directory.push(header, name);
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(directory.length / 2, 8);
  end.writeUInt16LE(directory.length / 2, 10);
  end.writeUInt32LE(directorySize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...directory, end]);
}

const headings = [
  'Название цели', 'Вес целей, %', 'Направление и #',
  'Ключевой результат (КР)', 'План', 'Факт', 'прогресс выполнения цели', 'Артефакт',
  'Ключевой результат (КР)', 'План', 'Факт', 'прогресс выполнения цели', 'Артефакт',
  'Куратор', 'ФИО Руководителя - Исполнителя', 'Комментарии Куратора: риски',
  'Комментарий Руководителя -Исполнителя (риски)', 'прогноз выполнения 4q', 'легенда 4q',
  'прогноз выполнения Y', 'легенда Y', 'наличие артефакта',
];
const maturity = 'Доля команд исполняют практики начального (гигиенического минимума) по модели зрелости';

function row(number, cells) {
  const entries = Object.entries(cells).map(([column, value]) => {
    const address = column + number;
    return typeof value === 'number'
      ? '<c r="' + address + '"><v>' + value + '</v></c>'
      : '<c r="' + address + '" t="inlineStr"><is><t>' + value + '</t></is></c>';
  });
  return '<row r="' + number + '">' + entries.join('') + '</row>';
}

function fixture(header = headings, quarterStatus = 'выполнено') {
  const labels = Object.fromEntries(header.map((value, index) => [String.fromCharCode(66 + index), value]));
  return workbookBytes('<worksheet><sheetData>' +
    row(2, { E: 'Q4 2026', J: 'Y26' }) +
    row(3, labels) +
    row(4, { B: 'Общая цель', C: 10, D: '#Процесс', E: maturity, F: 80, G: 100, H: 1.25,
      I: 'Материал https://example.test/a?key=a&amp;b=c', J: 'Годовой КР', K: 'Годовой план',
      L: 'Текстовый факт', M: 0, N: 'Отчёт', O: 'Куратор', P: 'Лидер А. ', Q: 'Комментарий куратора',
      R: 'Комментарий лидера', S: 1, T: quarterStatus, U: 0, V: 'в плане', W: 'нет' }) +
    row(5, { E: 'SW26.1 или SW26.2', F: 'В работе', P: 'Лидер Б.' }) +
    row(6, { J: '[AR26.4] Результат', L: 'н/д', V: 'есть риски' }) +
    row(7, { E: 'Вне фильтра', T: 'выполнено' }) +
    '</sheetData><autoFilter ref="B3:W6"/><mergeCells><mergeCell ref="B4:B5"/>' +
    '<mergeCell ref="C4:C5"/><mergeCell ref="D4:D5"/></mergeCells></worksheet>');
}

test('reads two periods and keeps context, statuses, facts, and progress distinct', () => {
  const register = readStatusRegister(fixture());
  assert.equal(register.asOf, null);
  assert.equal(register.range, 'B3:W6');
  assert.deepEqual(register.periods, ['Q4 2026', 'Y26']);
  const [quarter, year, merged, unmappedContext] = register.entries;
  assert.deepEqual(register.entries.map(entry => entry.sourceRow), [4, 4, 5, 6]);
  assert.equal(new Set(register.entries.map(entry => entry.id)).size, 4);
  assert.deepEqual([quarter.plan, quarter.fact, quarter.progress, quarter.status, quarter.forecast], [80, 100, 1.25, 'выполнено', 1]);
  assert.deepEqual([year.plan, year.fact, year.progress, year.status, year.forecast], ['Годовой план', 'Текстовый факт', 0, 'в плане', 0]);
  assert.equal(quarter.goalId, 'SW26.1');
  assert.equal(year.goalId, null);
  assert.equal(quarter.curatorComment, 'Комментарий куратора');
  assert.equal(quarter.leaderComment, 'Комментарий лидера');
  assert.equal(quarter.artifactStatus, 'нет');
  assert.deepEqual(quarter.links, [{ label: 'https://example.test/a?key=a&b=c', url: 'https://example.test/a?key=a&b=c' }]);
  assert.deepEqual([merged.objective, merged.weight, merged.direction], ['Общая цель', 10, '#Процесс']);
  assert.equal(merged.goalId, null);
  assert.deepEqual([unmappedContext.objective, unmappedContext.direction, unmappedContext.goalId], [null, null, 'AR26.4']);
});

test('refuses a filtered sheet with unrelated headers', () => {
  const altered = [...headings];
  altered[5] = 'Цена';
  assert.throws(() => readStatusRegister(fixture(altered)), /структур|заголов/iu);
});

test('dates immutable sources, retains confirmed links across books, and compares the chosen period', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'rm-uor-status-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const workspace = await openWorkspace({ dataDir });
  const map = Buffer.from(`<script type="application/json" id="portal-data">${JSON.stringify({
    goals: [{ id: 'SW26.1', title: 'Модель зрелости', scopeType: 'global' }],
    leaders: { sample: { name: 'Лидер А.', teams: [], assignments: [{ goalId: 'SW26.1', allProducts: true }] } }
  })}</script>`);
  await workspace.importSource('карта.html', map);
  const currentBytes = fixture();
  await workspace.importSource('Свежий.xlsx', currentBytes);
  await workspace.importSource('Ранний.xlsx', fixture(headings, 'есть риски'));
  await workspace.importSource('Без даты.xlsx', fixture(headings, 'в плане'));
  const [current, previous, undated] = workspace.getState().sources.filter(source => source.type === 'xlsx');

  const row = (await workspace.statusRegister(previous.id)).entries[0];
  assert.equal(row.linkState, 'suggested');
  await workspace.execute('statuslink', {
    sourceId: previous.id, entryId: row.id, goalId: 'SW26.1', scopeId: 'sample', expectedRevision: null
  });
  await assert.rejects(workspace.execute('statuslink', {
    sourceId: current.id, entryId: row.id, goalId: null, expectedRevision: null
  }), { code: 'CONFLICT' });
  await workspace.execute('snapshot', { sourceId: current.id, asOf: '2026-11-10', expectedRevision: null });
  await workspace.execute('snapshot', { sourceId: previous.id, asOf: '2026-11-03', expectedRevision: null });
  await assert.rejects(workspace.execute('snapshot', {
    sourceId: previous.id, asOf: '2026-11-04', expectedRevision: null
  }), { code: 'CONFLICT' });

  const restarted = await openWorkspace({ dataDir });
  assert.deepEqual(restarted.getState().statusSnapshots.map(item => item.id), [current.id, previous.id]);
  const latest = await restarted.statusRegister();
  assert.equal(latest.source.id, current.id);
  assert.equal(latest.entries[0].linkState, 'confirmed');
  assert.equal(latest.entries[0].scopeId, 'sample');
  assert.deepEqual((await restarted.readOriginal(current.id)).bytes, currentBytes);
  assert.equal(restarted.getState().goals[0].published.length, 0);

  const report = await restarted.statusWeek({ previousId: previous.id, currentId: current.id, period: 'Q4 2026' });
  assert.equal(report.baseline.total, 2);
  assert.equal(report.comparison.closedRisks.length, 1);
  assert.equal(report.comparison.newRisks.length, 0);
  assert.equal(report.comparison.closedRisks[0].previous.sourceRow, 4);
  assert.equal(report.comparison.closedRisks[0].current.goalId, 'SW26.1');
  const baseline = await restarted.statusWeek({ currentId: previous.id, period: 'Q4 2026' });
  assert.equal(baseline.comparison, null);
  assert.equal(baseline.baseline.risks.length, 1);
  await assert.rejects(restarted.statusWeek({ currentId: undated.id, period: 'Q4 2026' }), /дату текущего/iu);

  await restarted.execute('snapshot', { sourceId: undated.id, asOf: '2026-11-10', expectedRevision: null });
  await assert.rejects(restarted.statusRegister(), { code: 'STATUS_SOURCE_CHOICE' });
  assert.equal((await restarted.statusRegister(current.id)).source.id, current.id);
});

test('reads the supplied workbook when explicitly available', { skip: !process.env.RMUOR_REAL_STATUS_XLSX }, async () => {
  const register = readStatusRegister(await readFile(process.env.RMUOR_REAL_STATUS_XLSX));
  assert.equal(register.range, 'B12:W410');
  assert.equal(register.asOf, null);
  assert.equal(register.entries.filter(entry => entry.period === 'Q4 2026').length, 354);
  assert.equal(register.entries.filter(entry => entry.period === 'Y26').length, 398);
  const candidates = register.entries.filter(entry => entry.goalId);
  assert.equal(candidates.length, 308);
  assert.equal(new Set(candidates.map(entry => entry.goalId)).size, 26);
  for (const row of [211, 266, 274, 357, 395]) {
    assert.ok(register.entries.filter(entry => entry.sourceRow === row).every(entry => entry.goalId === null));
  }
  assert.equal(register.entries.find(entry => entry.sourceRow === 364 && entry.period === 'Q4 2026').goalId, 'SD04.19');
  assert.equal(register.entries.find(entry => entry.sourceRow === 364 && entry.period === 'Y26').goalId, null);
  const maturityEntries = register.entries.filter(entry => entry.goalId === 'SW26.1');
  assert.equal(maturityEntries.length, 16);
  const lead = maturityEntries.find(entry => entry.sourceRow === 136 && entry.period === 'Q4 2026');
  assert.deepEqual([lead.leader, lead.fact, lead.progress, lead.status], ['Андреев А.', 100, 1.25, 'выполнено']);
  const merged = register.entries.find(entry => entry.sourceRow === 41 && entry.period === 'Q4 2026');
  assert.equal(merged.objective, 'КПЭ Блока Т');
  assert.match(merged.direction, /Импортозамещение/u);
  assert.ok(register.entries.every(entry => entry.sourceRow >= 13 && entry.sourceRow <= 410));
});
