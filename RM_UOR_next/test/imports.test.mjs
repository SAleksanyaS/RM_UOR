import assert from 'node:assert/strict';
import test from 'node:test';
import { deflateRawSync } from 'node:zlib';
import { openWorkbook, parseGoalMap } from '../src/imports.mjs';

function zip(parts) {
  const locals = [];
  const entries = [];
  let offset = 0;
  let centralSize = 0;
  for (const [path, text] of Object.entries(parts)) {
    const name = Buffer.from(path);
    const bytes = Buffer.from(text);
    const compressed = deflateRawSync(bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(bytes.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, compressed);
    entries.push(central, name);
    offset += local.length + name.length + compressed.length;
    centralSize += central.length + name.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(parts).length, 8);
  end.writeUInt16LE(Object.keys(parts).length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...entries, end]);
}

test('the goal map reads only structured data and preserves leader scope', () => {
  const payload = {
    goals: [{ id: 'G.01', title: 'Цель', summary: 'Описание', scopeType: 'specific',
      curators: ['Куратор'], links: [{ label: 'Дашборд', url: 'https://source.example/path', kind: 'dashboard' },
        { label: 'Script', url: 'javascript:alert(1)' }] }],
    leaders: { a: { name: 'Лидер', teams: ['Команда'], assignments: [{ goalId: 'G.01', teams: ['Команда'], agents: ['Агент'], active: false }] } },
  };
  const source = Buffer.from(`<script>throw new Error('HTML must not run');</script>
    <script type='application/json' id='portal-data'>${JSON.stringify(payload)}</script>`);
  const { goals, directory } = parseGoalMap(source);
  assert.equal(goals[0].id, 'G.01');
  assert.equal(goals[0].description, 'Описание');
  assert.equal(goals[0].scope, 'specific');
  assert.deepEqual(goals[0].links, [payload.goals[0].links[0]]);
  const assignment = goals[0].assignments[0];
  assert.equal(assignment.leaderId, 'a');
  assert.equal(assignment.active, false);
  const team = directory.find(item => item.name === 'Команда');
  assert.equal(team.type, 'team');
  assert.equal(team.leaderId, 'a');
  assert.deepEqual(assignment.teamIds, [team.id]);
  assert.ok(assignment.scopeIds.includes(team.id));
  assert.deepEqual(parseGoalMap(source).directory, directory);
  assert.throws(() => parseGoalMap('<script id="portal-data">()</script>'), /JSON/);
});

test('workbook preview uses cached values and a bounded sparse grid', () => {
  const bytes = zip({
    'xl/workbook.xml': `<workbook><bookViews><workbookView activeTab="1"/></bookViews><sheets>
      <sheet name="Скрытый" state="hidden" r:id="r1"/><sheet name="Данные &amp; тест" r:id="r2"/>
      </sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<Relationships>
      <Relationship Id="r1" Target="worksheets/hidden.xml" Type="http://test/worksheet"/>
      <Relationship Id="r2" Target="worksheets/data.xml" Type="http://test/worksheet"/>
      <Relationship Id="ignored" Target="https://no-network.example/" TargetMode="External" Type="http://test/externalLink"/>
      </Relationships>`,
    'xl/sharedStrings.xml': '<sst><si><r><t>Значе</t></r><r><t>ние</t></r><rPh><t>ignore</t></rPh></si></sst>',
    'xl/worksheets/hidden.xml': '<worksheet><sheetData/></worksheet>',
    'xl/worksheets/data.xml': `<worksheet><dimension ref="A1:C3"/><sheetData>
      <row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="inlineStr"><is><t>&lt;текст&gt;</t></is></c></row>
      <row r="3"><c r="A3"><f>WEBSERVICE(&quot;https://no-network.example/&quot;)</f><v>42</v></c>
      <c r="B3"><f>1+2</f></c><c r="C3" t="b"><v>1</v></c></row>
      <row r="34"><c r="P34" s="6"/></row>
      </sheetData><autoFilter ref="A1:C3"/><mergeCells><mergeCell ref="A2:B2"/></mergeCells></worksheet>`,
  });
  const book = openWorkbook(bytes);
  assert.deepEqual(book.sheets.map(({ name, rows, columns, hidden }) => ({ name, rows, columns, hidden })), [
    { name: 'Скрытый', rows: 0, columns: 0, hidden: true },
    { name: 'Данные & тест', rows: 3, columns: 3, hidden: false },
  ]);
  assert.equal(book.sheets[1].filterRange, 'A1:C3');
  assert.deepEqual(book.preview(undefined, 2, 1), { sheet: 'Данные & тест', rows: [[42, null, true]], offset: 2, total: 3, merges: [] });
  assert.deepEqual(book.preview().merges, ['A2:B2']);
  assert.deepEqual(book.getRows('Данные & тест'), [['Значение', null, '<текст>'], [null, null, null], [42, null, true]]);
  assert.throws(() => book.preview('unknown'), /лист/i);
  assert.throws(() => openWorkbook(bytes.subarray(0, -4)), /ZIP/i);
});
