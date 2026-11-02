import ExcelJS from 'exceljs';
import PptxGenJS from 'pptxgenjs';
import type { ReportSnapshot } from './contracts';
import { reportSections } from './presentation';
export { reportRows, reportSections } from './presentation';
const h = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
export function reportHtml(s: ReportSnapshot) { return `<!doctype html><html lang="ru"><meta charset="utf-8"><title>${h(s.definition.title)}</title><style>@page{size:A4 landscape;margin:12mm}body{font:11px Arial,sans-serif;color:#24283a;line-height:1.4}h1{font-size:25px}h2{font-size:19px;color:#6741bd}table{border-collapse:collapse;width:100%;table-layout:fixed}th,td{border:1px solid #dce0e9;padding:6px;overflow-wrap:anywhere;vertical-align:top}th{background:#f1ecfa}thead{display:table-header-group}tr{break-inside:avoid}section{break-before:page}footer{font-size:8px;overflow-wrap:anywhere}p{white-space:pre-wrap}</style><h1>${h(s.definition.title)}</h1><p>${h(s.definition.period)} · Редакция ${s.revision}</p><p>${h(s.definition.comment)}</p><p>${s.maturity ? 'Источник не является принятым фактом или подтверждением УОР.' : 'Значения и подтверждения зафиксированы из выбранного результата цели.'}</p>${reportSections(s).map(v => `<section><h2>${h(v.title)}</h2><p>${h(v.comment)}</p><table><thead><tr>${v.rows[0].map(c => `<th>${h(c)}</th>`).join('')}</tr></thead><tbody>${v.rows.slice(1).map(row => `<tr>${row.map(c => `<td>${h(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></section>`).join('')}<footer>${h(s.id)} · SHA-256 ${s.digest} · Шаблон ${s.template.id} / ${s.template.version} / ${s.template.sha256}</footer></html>`; }
export async function reportXlsx(s: ReportSnapshot) { const book = new ExcelJS.Workbook(); book.creator = 'УОР'; book.created = new Date(s.createdAt); for (const [i, v] of reportSections(s).entries()) {
    const sheet = book.addWorksheet(`${i + 1} ${v.title}`.replace(/[\\/*?:\[\]]/g, ' ').slice(0, 31));
    sheet.addRow([s.definition.title, s.definition.period]);
    sheet.addRow([s.definition.comment]);
    sheet.addRow([v.comment]);
    for (const row of v.rows)
        sheet.addRow(row);
    sheet.views = [{ state: 'frozen', ySplit: 4 }];
    sheet.columns = v.rows[0].map((_, n) => ({ width: n === 0 ? 40 : 28 }));
    sheet.eachRow(row => { row.alignment = { wrapText: true, vertical: 'top' }; });
    sheet.getRow(4).font = { bold: true, color: { argb: 'FF6741BD' } };
} const metadata = book.addWorksheet('Снимок'); metadata.addRows([['ID', s.id], ['Редакция', s.revision], ['Отпечаток', s.digest], ['Шаблон', s.template.id], ['SHA-256 шаблона', s.template.sha256], ...JSON.stringify({ ...s, template: { ...s.template, bytesBase64: undefined } }).match(/[\s\S]{1,30000}/g)!.map((part, i) => ['Снимок JSON · часть ' + (i + 1), part])]); return Buffer.from(await book.xlsx.writeBuffer()); }
export async function reportPptx(s: ReportSnapshot) { const deck = new PptxGenJS(); deck.layout = 'LAYOUT_WIDE'; deck.title = s.definition.title; deck.author = 'УОР'; deck.subject = s.digest; deck.theme = { headFontFace: 'Arial', bodyFontFace: 'Arial' }; let n = 0; const page = (title: string, subtitle: string) => { const slide = deck.addSlide(); slide.background = { color: 'F6F7FB' }; slide.addText(title, { x: .5, y: .4, w: 12.3, h: .7, fontSize: 24, bold: true, color: '24283A', fit: 'shrink' }); slide.addText(subtitle, { x: .5, y: 1.15, w: 12.3, h: .7, fontSize: 12, color: '606980', fit: 'shrink' }); slide.addText(`${s.definition.period} · v${s.revision} · ${++n} · ${s.digest}`, { x: .5, y: 7.05, w: 12.3, h: .2, fontSize: 7, color: '606980' }); return slide; }; const cover = page(s.definition.title, s.definition.comment); cover.addText(s.maturity ? 'Выбранные материалы · источник не является принятым фактом\nПодтверждение УОР отсутствует' : 'Результат выбранной цели и историческая основа\nПодтверждения УОР показаны отдельно', { x: .5, y: 2.4, w: 12.2, h: 1, fontSize: 20, color: '6741BD' }); for (const section of reportSections(s)) {
    const header = section.rows[0];
    const rows = section.rows.slice(1);
    for (let start = 0; start < Math.max(rows.length, 1); start += 7) {
        const slide = page(section.title, section.comment);
        slide.addTable([header, ...rows.slice(start, start + 7)].map(row => row.map(text => ({ text }))), { x: .5, y: 2, w: 12.3, fontSize: header.length > 5 ? 9 : 12, fontFace: 'Arial', color: '24283A', border: { color: 'DCE0E9', pt: .5 }, fill: { color: 'FFFFFF' }, margin: .05, rowH: .5, autoPage: true, autoPageRepeatHeader: true, autoPageSlideStartY: 1 });
    }
} return Buffer.from(await deck.write({ outputType: 'nodebuffer' }) as Buffer); }
