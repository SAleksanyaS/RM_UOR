import JSZip from 'jszip';
import { DOMParser, XMLSerializer, type Document, type Element } from '@xmldom/xmldom';
import { inflateRawSync } from 'node:zlib';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { ReportRow, ReportSnapshot } from '../reporting/report-contracts';
import { reportNumber, reportOfficialTarget, reportStatus } from '../reporting/report-contracts';
import { templateProfileSchema, templateFieldSchema, type TemplateProfile, type TemplateInspection, type TemplateShape, type TemplateField } from './contracts';
import { ActionError } from '../identity/role-service';

const P = 'http://schemas.openxmlformats.org/presentationml/2006/main', A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const R = 'http://schemas.openxmlformats.org/package/2006/relationships';
function fail(message: string): never { throw new ActionError(message, 400); }
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export const TEMPLATE_LIMITS = { compressed: 20 * 1024 * 1024, expanded: 64 * 1024 * 1024, entry: 8 * 1024 * 1024, entries: 2000, slides: 500, outputSlides: 2000 };
/** Inspect raw central records before JSZip inflates or sanitizes any name. */
export function validateZipEnvelope(bytes: Buffer) {
  if (bytes.length > TEMPLATE_LIMITS.compressed) fail('PPTX превышает 20 МБ');
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (bytes.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  if (end < 0) fail('Файл не является ZIP/PPTX');
  if (bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) fail('Многотомный ZIP не поддерживается');
  const count = bytes.readUInt16LE(end + 10), start = bytes.readUInt32LE(end + 16), centralSize = bytes.readUInt32LE(end + 12);
  if (count > TEMPLATE_LIMITS.entries || count === 65535 || start + centralSize > end) fail('Превышен лимит ZIP или используется ZIP64');
  let offset = start, expanded = 0;
  const seen = new Set<string>();
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) fail('Повреждён каталог ZIP');
    const flags = bytes.readUInt16LE(offset + 8), method = bytes.readUInt16LE(offset + 10), compressed = bytes.readUInt32LE(offset + 20), size = bytes.readUInt32LE(offset + 24);
    const length = bytes.readUInt16LE(offset + 28), extra = bytes.readUInt16LE(offset + 30), comment = bytes.readUInt16LE(offset + 32);
    if (offset + 46 + length + extra + comment > end) fail('Повреждено имя ZIP');
    const name = bytes.subarray(offset + 46, offset + 46 + length).toString('utf8');
    if (!name || name.includes('\\') || name.includes('\0') || name.startsWith('/') || /^[a-z]:/i.test(name) || name.split('/').some(p => p === '..' || p === '.') || seen.has(name)) fail(`Недопустимый путь ZIP: ${name}`);
    seen.add(name);
    if (flags & 1 || ![0,8].includes(method)) fail('Зашифрованный или неподдерживаемый ZIP');
    if (size > TEMPLATE_LIMITS.entry || size > Math.max(compressed,1) * 1000) fail('Превышен лимит распакованного объекта ZIP');
    expanded += size; if (expanded > TEMPLATE_LIMITS.expanded) fail('Распакованный PPTX превышает 64 МБ');
    const unixMode = bytes.readUInt32LE(offset + 38) >>> 16;
    if ((unixMode & 0xf000) === 0xa000) fail('Символические ссылки в PPTX запрещены');
    const local = bytes.readUInt32LE(offset + 42);
    if (local + 30 > start || bytes.readUInt32LE(local) !== 0x04034b50) fail('Повреждён локальный объект ZIP');
    const dataStart = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    if (dataStart + compressed > start) fail('ZIP содержит объект вне области данных');
    try {
      const output = method === 8 ? inflateRawSync(bytes.subarray(dataStart,dataStart + compressed), { maxOutputLength: TEMPLATE_LIMITS.entry }) : bytes.subarray(dataStart,dataStart + compressed);
      if (output.length !== size) fail('Размер распакованного ZIP не совпадает с каталогом');
    } catch { fail('Повреждённый или чрезмерно расширяющийся объект ZIP'); }
    offset += 46 + length + extra + comment;
  }
  if (offset !== start + centralSize) fail('Несогласованный каталог ZIP');
  return expanded;
}
function xml(source: string) {
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) fail('DTD и XML entities запрещены');
  const errors: string[] = [];
  let document: Document;
  try { document = new DOMParser({ onError: (_level, message) => { errors.push(message); } }).parseFromString(source, 'application/xml'); }
  catch { fail('Некорректный XML в PPTX'); }
  if (errors.length || !document.documentElement) fail('Некорректный XML в PPTX'); return document;
}
const serialize = (doc: Document | Element) => new XMLSerializer().serializeToString(doc);
const all = (node: Document | Element, ns: string, name: string) => Array.from(node.getElementsByTagNameNS(ns,name));
const text = (node: Element) => all(node,A,'t').map(t => t.textContent ?? '').join('');
function shapeNodes(doc: Document) { return [...all(doc,P,'sp'), ...all(doc,P,'graphicFrame')]; }
function shapeId(node: Element) { return all(node,P,'cNvPr')[0]?.getAttribute('id') ?? ''; }
function capacity(node: Element) {
  const size = Number(all(node,A,'rPr')[0]?.getAttribute('sz') || all(node,A,'defRPr')[0]?.getAttribute('sz') || 1800) / 100;
  const ext = all(node,A,'ext')[0] ?? all(node,P,'ext')[0];
  const w = Number(ext?.getAttribute('cx') || 3_657_600) / 12700, h = Number(ext?.getAttribute('cy') || 914_400) / 12700;
  return Math.max(20, Math.floor(w / (size * .65)) * Math.max(1,Math.floor(h / (size * 1.5))));
}
function inspectShape(node: Element): TemplateShape {
  const table = all(node,A,'tbl')[0], id = shapeId(node), name = all(node,P,'cNvPr')[0]?.getAttribute('name') ?? id, value = text(node);
  const kind = table ? 'table' : node.localName === 'sp' && all(node,P,'txBody').length ? 'text' : 'unsupported';
  return { id, name, kind, text: value, tokens: [...value.matchAll(/\{\{([^{}]+)\}\}/g)].map(m => m[1].trim()), capacity: capacity(node), ...(table ? { rows: all(table,A,'tr').length, columns: all(table,A,'gridCol').length } : {}) };
}
async function load(bytes: Buffer) {
  validateZipEnvelope(bytes);
  const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
  if (!zip.file('[Content_Types].xml') || !zip.file('ppt/presentation.xml')) fail('Архив не содержит презентацию OOXML');
  let expanded = 0;
  for (const item of Object.values(zip.files)) {
    if (item.dir) continue;
    if (/(vbaProject|activeX|embeddings\/|\.exe$|\.bin$|customUI\/)/i.test(item.name)) fail(`Исполняемое или вложенное содержимое не поддерживается: ${item.name}`);
    const content = await item.async('uint8array'); expanded += content.length;
    if (expanded > TEMPLATE_LIMITS.expanded || content.length > TEMPLATE_LIMITS.entry) fail('Превышен лимит распаковки PPTX');
    if (/\.(xml|rels)$/.test(item.name)) {
      const doc = xml(Buffer.from(content).toString('utf8'));
      if (item.name.endsWith('.rels')) for (const rel of all(doc,R,'Relationship')) {
        const target = rel.getAttribute('Target') ?? '', type = rel.getAttribute('Type') ?? '';
        if (rel.getAttribute('TargetMode') === 'External' && !(type.endsWith('/hyperlink') && /^(https?:|mailto:)/i.test(target))) fail(`Опасная внешняя связь: ${item.name}`);
        if (/^(file:|javascript:|data:|vbscript:|\\\\)/i.test(target)) fail('Опасная связь OOXML');
      }
    }
  }
  return zip;
}
async function orderedSlides(zip: JSZip) {
  const presentation = xml(await zip.file('ppt/presentation.xml')!.async('text'));
  const relsFile = zip.file('ppt/_rels/presentation.xml.rels'); if (!relsFile) fail('Отсутствуют связи презентации');
  const rels = xml(await relsFile.async('text'));
  const paths = all(presentation,P,'sldId').map(s => {
    const id = s.getAttribute('r:id'), target = all(rels,R,'Relationship').find(r => r.getAttribute('Id') === id)?.getAttribute('Target') ?? '';
    const path = target.startsWith('/') ? target.slice(1) : `ppt/${target}`;
    if (!/^ppt\/slides\/[^/]+\.xml$/.test(path) || !zip.file(path)) fail('Неподдерживаемая связь слайда'); return path;
  });
  if (!paths.length || paths.length > TEMPLATE_LIMITS.slides) fail('Допустимо от 1 до 500 слайдов'); return { presentation, rels, paths };
}
export async function inspectTemplate(bytes: Buffer): Promise<TemplateInspection> {
  const zip = await load(bytes), { paths } = await orderedSlides(zip);
  const slides = await Promise.all(paths.map(async (path, index) => ({ number: index + 1, path, shapes: shapeNodes(xml(await zip.file(path)!.async('text'))).map(inspectShape) })));
  return { slides, sha256: digest(bytes), size: bytes.length, warnings: slides.flatMap(s => s.shapes.filter(o => o.kind === 'unsupported').map(o => `Слайд ${s.number}, ${o.name}: графика/диаграмма/SmartArt сохраняется статически; привязка не поддерживается`)) };
}
export function checkTemplate(inspection: TemplateInspection, raw: unknown) {
  const profile = templateProfileSchema.parse(raw), used = new Set<string>();
  for (const binding of profile.bindings) {
    const shape = inspection.slides.find(s => s.number === binding.slide)?.shapes.find(o => o.id === binding.shapeId);
    if (!shape || shape.kind !== binding.kind) fail(`Слайд ${binding.slide}, объект ${binding.shapeId}: требуется поддержанный ${binding.kind}`);
    const key = `${binding.slide}:${binding.shapeId}`; if (used.has(key)) fail('Объект имеет несколько привязок'); used.add(key);
    if (binding.kind === 'table' && (shape.rows! <= binding.headerRows || shape.columns !== binding.columns.length)) fail('Таблица должна иметь строку образца и точное число колонок');
  }
  const repeatSlides = new Set<number>();
  for (const repeat of profile.repeats) { if (!inspection.slides.some(s => s.number === repeat.slide) || repeatSlides.has(repeat.slide)) fail('Некорректный повтор слайда'); repeatSlides.add(repeat.slide); }
  for (const slide of inspection.slides) {
    if (profile.bindings.filter(b => b.slide === slide.number && b.kind === 'table').length > 1) fail('Один повторяемый блок таблицы на слайд');
    if (repeatSlides.has(slide.number) && profile.bindings.some(b => b.slide === slide.number && b.kind === 'table')) fail('Повтор таблицы и повтор слайда задаются на разных слайдах');
    for (const shape of slide.shapes) for (const token of shape.tokens) {
      if (used.has(`${slide.number}:${shape.id}`)) continue;
      if (!templateFieldSchema.safeParse(token).success) fail(`Неизвестная привязка {{${token}}}, слайд ${slide.number}`);
      if (shape.kind !== 'text') fail('Автоподстановка токенов поддерживается только в тексте; задайте таблице колонки');
      if (token.startsWith('row.') && !repeatSlides.has(slide.number)) fail(`Поле ${token} требует повтора слайда по строкам/целям/лидерам`);
    }
    if (profile.bindings.some(b => b.slide === slide.number && b.kind === 'text' && b.field.startsWith('row.')) && !repeatSlides.has(slide.number)) fail('Поля строки требуют повтора слайда');
  }
  return { valid: true as const, warnings: inspection.warnings, profile };
}
/** An export may not quietly omit a selected goal or leader name. */
export function assertTemplateCoverage(inspection: TemplateInspection, profile: TemplateProfile, report: ReportSnapshot) {
  const coverage = new Map(report.rows.map(row => [row,new Set<string>()]));
  const add = (kind: 'rows'|'goals'|'leaders', fields: string[]) => {
    for (const row of collection(report,kind)) for (const field of fields) coverage.get(row)!.add(field);
  };
  for (const slide of inspection.slides) {
    const bindings = profile.bindings.filter(b => b.slide === slide.number), repeat = profile.repeats.find(r => r.slide === slide.number);
    if (repeat) add(repeat.collection,slide.shapes.flatMap(shape => {
      const binding = bindings.find(b => b.shapeId === shape.id);
      return binding?.kind === 'text' ? [binding.field] : binding ? [] : shape.tokens;
    }));
    for (const binding of bindings) if (binding.kind === 'table') add(binding.collection,binding.columns);
  }
  for (const [row,fields] of coverage) if (!fields.has('row.goalTitle') || !fields.has('row.leaderName')) fail(`Шаблон пропускает название цели или ИТ-лидера: ${row.goalTitle} / ${row.leaderName}. Привяжите row.goalTitle и row.leaderName к повтору или колонкам таблицы.`);
}
function value(field: TemplateField, report: ReportSnapshot, row?: ReportRow): string {
  const reportFields = { 'report.period': report.selection.period, 'report.baselinePeriod': report.comparison?.baselinePeriod ?? 'Не выбран', 'report.createdAt': report.createdAt, 'report.catalogName': report.catalogName, 'report.limitations': report.limitations.join('\n'), 'report.summary': `Целей ${report.summary.goals}; подтверждено ${report.summary.confirmed}; ожидает УОР ${report.summary.pending}; не выполнено ${report.summary.notMet}; нет данных ${report.summary.unknown}` };
  if (field in reportFields) return reportFields[field as keyof typeof reportFields];
  if (!row) fail(`Нет строки для ${field}`);
  const comparison = report.comparison?.rows.find(r => r.goalId === row.goalId && r.leaderId === row.leaderId);
  return ({ 'row.goalTitle': row.goalTitle, 'row.leaderName': row.leaderName, 'row.actual': `${reportNumber(row.evaluation.actual)} ${row.unit}`, 'row.target': reportOfficialTarget(row), 'row.status': reportStatus(row), 'row.dueDate': row.officialDueDate ?? 'Не задан', 'row.nextAction': row.plan?.nextAction ?? 'Не задан', 'row.decisionNeeded': row.plan?.decisionNeeded ?? 'Не задано', 'row.comments': row.comments.map(c => `${c.author}: ${c.text}`).join('\n') || 'Нет', 'row.sources': row.sources.map(s => `${s.sourceName}; ${s.period}; ${s.id}; ${s.dataHash}`).join('\n') || 'Нет', 'row.delta': comparison?.actualDelta !== null && comparison?.actualDelta !== undefined ? reportNumber(comparison.actualDelta) : 'Несопоставимо', 'row.changes': comparison?.changes.map(c => `${c.field}: ${c.before ?? 'нет'} → ${c.after ?? 'нет'}`).join('\n') || 'Нет зафиксированных изменений' } as Record<string,string>)[field];
}
function setText(node: Element, result: string) {
  const texts = all(node,A,'t'); if (!texts.length) fail('Объект не содержит текстовый образец');
  texts[0].textContent = result; texts[0].setAttribute('xml:space','preserve'); for (const rest of texts.slice(1)) rest.textContent = '';
}
function replaceTokens(node: Element, resolve: (field: string) => string) {
  const nodes = all(node,A,'t'), source = nodes.map(n => n.textContent ?? '').join('');
  let offset = 0;
  const ranges = nodes.map(n => { const start=offset; offset += (n.textContent ?? '').length; return { node:n,start,end:offset }; });
  for (const match of [...source.matchAll(/\{\{([^{}]+)\}\}/g)].reverse()) {
    const start=match.index!, end=start+match[0].length, affected=ranges.filter(r=>r.end>start&&r.start<end);
    affected.forEach((range,index)=>{ const current=range.node.textContent ?? ''; range.node.textContent=current.slice(0,Math.max(0,start-range.start))+(index===0?resolve(match[1].trim()):'')+current.slice(Math.min(current.length,end-range.start)); range.node.setAttribute('xml:space','preserve'); });
  }
}
function chunks(input: string, size: number): string[] {
  const points = Array.from(input); if (!points.length) return [''];
  return Array.from({ length: Math.ceil(points.length / size) }, (_,i) => points.slice(i*size,(i+1)*size).join(''));
}
const collection = (report: ReportSnapshot, kind: 'rows'|'goals'|'leaders') => report.rows.filter(r => kind === 'rows' || (kind === 'goals' ? r.leaderId === null : r.leaderId !== null));
/** Copy slide XML, master/theme/media and relationships; only bound text and table rows change. */
export async function renderTemplate(bytes: Buffer, raw: TemplateProfile, report: ReportSnapshot): Promise<Buffer> {
  const inspection = await inspectTemplate(bytes), { profile } = checkTemplate(inspection,raw), zip = await load(bytes), { presentation, rels, paths } = await orderedSlides(zip);
  assertTemplateCoverage(inspection,profile,report);
  const contentTypes = xml(await zip.file('[Content_Types].xml')!.async('text'));
  const list = all(presentation,P,'sldIdLst')[0]; if (!list) fail('Нет списка слайдов');
  while (list.firstChild) list.removeChild(list.firstChild);
  for (const rel of all(rels,R,'Relationship').filter(r => r.getAttribute('Type')?.endsWith('/slide'))) rel.parentNode!.removeChild(rel);
  let count = 0, outputExpanded = validateZipEnvelope(bytes);
  const generatedPaths = new Map<string,string>();
  for (const [slideIndex, originalPath] of paths.entries()) {
    const number = slideIndex + 1, original = await zip.file(originalPath)!.async('text'), slide = inspection.slides[slideIndex];
    const bindings = profile.bindings.filter(b => b.slide === number), repeat = profile.repeats.find(r => r.slide === number), table = bindings.find(b => b.kind === 'table');
    const contexts: { row?: ReportRow; tableRows?: { row: ReportRow; part: number; parts: number }[] }[] = [];
    if (repeat) contexts.push(...collection(report,repeat.collection).map(row => ({ row })));
    else if (table?.kind === 'table') {
      const records = collection(report,table.collection).flatMap(row => { const max = table.maxChars ?? 120, parts = Math.max(1,...table.columns.map(f => chunks(value(f,report,row), max).length)); return Array.from({ length: parts },(_,part) => ({ row,part,parts })); });
      for (let i=0; i<records.length; i+=table.rowsPerSlide) contexts.push({ tableRows: records.slice(i,i+table.rowsPerSlide) });
      if (!contexts.length) contexts.push({ tableRows: [] });
    } else contexts.push({});
    // Empty scopes produce an explicit empty page instead of deleting the section silently.
    if (!contexts.length) contexts.push({ row: undefined });
    for (const context of contexts) {
      const values = new Map<string,string[]>();
      for (const shape of slide.shapes.filter(s => s.kind === 'text')) {
        const binding = bindings.find(b => b.shapeId === shape.id && b.kind === 'text');
        if (binding?.kind === 'text') values.set(shape.id,chunks(context.row || !binding.field.startsWith('row.') ? value(binding.field,report,context.row) : 'Нет строк выбранного состава', Math.min(binding.maxChars ?? shape.capacity, shape.capacity)));
        else if (shape.tokens.length) {
          const result = shape.text.replace(/\{\{([^{}]+)\}\}/g,(_,f:string) => f.trim().startsWith('row.') && !context.row ? 'Нет строк выбранного состава' : value(templateFieldSchema.parse(f.trim()),report,context.row));
          values.set(shape.id,chunks(result,shape.capacity));
        }
      }
      const pages = Math.max(1,...[...values.values()].map(v => v.length));
      for (let part=0; part<pages; part++) {
        const doc = xml(original);
        for (const node of shapeNodes(doc)) {
          const id = shapeId(node), pieces = values.get(id);
          if (!pieces) continue;
          const explicit = bindings.some(b => b.shapeId === id && b.kind === 'text');
          if (!explicit && pieces.length === 1) replaceTokens(node,f => f.startsWith('row.') && !context.row ? 'Нет строк выбранного состава' : value(templateFieldSchema.parse(f),report,context.row));
          else setText(node,pieces[part] ?? '');
        }
        if (table?.kind === 'table') {
          const node = shapeNodes(doc).find(n => shapeId(n) === table.shapeId)!, tbl = all(node,A,'tbl')[0], rows = all(tbl,A,'tr'), sample = rows[table.headerRows];
          for (const row of rows.slice(table.headerRows)) row.parentNode!.removeChild(row);
          for (const item of context.tableRows ?? []) {
            const newRow = sample.cloneNode(true) as Element, cells = all(newRow,A,'tc');
            cells.forEach((cell,index) => setText(cell, chunks(value(table.columns[index],report,item.row),table.maxChars ?? 120)[item.part] ?? ''));
            tbl.appendChild(newRow);
          }
          if (!(context.tableRows?.length)) { const empty = sample.cloneNode(true) as Element; all(empty,A,'tc').forEach((c,i) => setText(c,i === 0 ? 'Нет строк выбранного состава' : '')); tbl.appendChild(empty); }
        }
        count++; if (count > TEMPLATE_LIMITS.outputSlides) fail('Отчёт превышает 2000 слайдов; уменьшите состав');
        const newName = `uor-generated-${count}.xml`, newPath = `ppt/slides/${newName}`;
        const generated = serialize(doc);
        outputExpanded += Buffer.byteLength(generated);
        if (outputExpanded > TEMPLATE_LIMITS.expanded) fail('Сгенерированный отчёт превышает 64 МБ; уменьшите состав');
        if (!generatedPaths.has(originalPath)) generatedPaths.set(originalPath,newPath);
        zip.file(newPath,generated);
        const originalRels = zip.file(originalPath.replace(/\/([^/]+)$/, '/_rels/$1.rels'));
        if (originalRels) { const slideRels = xml(await originalRels.async('text')); for (const n of all(slideRels,R,'Relationship').filter(n => n.getAttribute('Type')?.endsWith('/notesSlide'))) n.parentNode!.removeChild(n); zip.file(`ppt/slides/_rels/${newName}.rels`,serialize(slideRels)); }
        const id = `rIdUorGenerated${count}`, relationship = rels.createElementNS(R,'Relationship'); relationship.setAttribute('Id',id); relationship.setAttribute('Type','http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide'); relationship.setAttribute('Target',`slides/${newName}`); rels.documentElement!.appendChild(relationship);
        const sld = presentation.createElementNS(P,'p:sldId'); sld.setAttribute('id',String(255+count)); sld.setAttribute('r:id',id); list.appendChild(sld);
        const override = contentTypes.createElementNS('http://schemas.openxmlformats.org/package/2006/content-types','Override'); override.setAttribute('PartName',`/${newPath}`); override.setAttribute('ContentType','application/vnd.openxmlformats-officedocument.presentationml.slide+xml'); contentTypes.documentElement!.appendChild(override);
      }
    }
  }
  for (const file of Object.values(zip.files).filter(file => /^ppt\/slides\/_rels\/uor-generated-\d+\.xml\.rels$/.test(file.name))) {
    const doc = xml(await file.async('text'));
    for (const rel of all(doc,R,'Relationship').filter(rel => rel.getAttribute('Type')?.endsWith('/slide') && rel.getAttribute('TargetMode') !== 'External')) {
      const target = rel.getAttribute('Target') ?? '', originalTarget = target.startsWith('/') ? target.slice(1) : path.posix.normalize(`ppt/slides/${target}`);
      const generatedTarget = generatedPaths.get(originalTarget);
      if (!generatedTarget) fail('Внутренний переход ведёт на отсутствующий слайд');
      rel.setAttribute('Target',path.posix.relative('ppt/slides',generatedTarget));
    }
    zip.file(file.name,serialize(doc));
  }
  for (const originalPath of paths) {
    zip.remove(originalPath); zip.remove(originalPath.replace(/\/([^/]+)$/, '/_rels/$1.rels'));
    for (const entry of Array.from(contentTypes.getElementsByTagName('Override')).filter(e => e.getAttribute('PartName') === `/${originalPath}`)) entry.parentNode!.removeChild(entry);
  }
  zip.file('ppt/presentation.xml',serialize(presentation)); zip.file('ppt/_rels/presentation.xml.rels',serialize(rels)); zip.file('[Content_Types].xml',serialize(contentTypes));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
