import PptxGenJS from 'pptxgenjs';
import { reportNumber, reportOfficialTarget, reportStatus, type ReportRow, type ReportSnapshot } from './report-contracts';

export const escapeHtml = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
export function paginate<T>(rows: T[], size = 6): T[][] {
  if (!Number.isInteger(size) || size < 1) throw new Error('Размер страницы должен быть положительным');
  return Array.from({ length: Math.ceil(rows.length / size) }, (_, index) => rows.slice(index * size, (index + 1) * size));
}
export const rowValue = (row: ReportRow) => `${reportNumber(row.evaluation.actual)}${row.evaluation.actual === null ? '' : ` ${row.unit}`}`;
export const rowDetails = (row: ReportRow) => [
  `Историческая основа: ${row.historicalBasis ?? 'не указана'}. Организация сохранена: ${row.organizationCaptured ? 'да' : 'нет'}`,
  `Официальный порог: ${reportOfficialTarget(row)}. Внутренний ориентир: ${reportNumber(row.evaluation.internalTarget)}`,
  `Официальный срок: ${row.officialDueDate || 'не задан'}`,
  `Обязательство: ${row.plan?.targetDate || 'не задано'}. Прогноз: ${row.plan?.forecastDate || 'не задан'}`,
  row.plan?.nextAction && `Следующий шаг: ${row.plan.nextAction}`, row.plan?.blocker && `Препятствие: ${row.plan.blocker}`,
  row.plan?.decisionNeeded && `Требуется решение: ${row.plan.decisionNeeded}`,
  ...row.comments.map(comment => `${comment.author} (${comment.createdAt}): ${comment.text}`),
  `Источники: ${row.sources.map(source => `${source.sourceName} (${source.sourceId}), ${source.sourceUrl || 'ссылка не задана'}, ${source.origin}, ${source.status}, получен ${source.collectedAt}, актуальность ${source.sourceUpdatedAt || 'неизвестна'}, проверил ${source.curatorName || 'не указан'}, проверка ${source.validatedAt || 'не выполнялась'}, снимок ${source.id}, хеш ${source.dataHash}`).join('; ') || 'нет снимка выбранного периода'}`,
  `Подтверждение: ${row.confirmation ? `${row.confirmation.curatorName}, ${row.confirmation.confirmedAt}, ${row.confirmation.comment || 'артефакты: ' + row.confirmation.evidenceIds.join(', ')}` : 'нет действующего подтверждения'}`,
  `Ограничения расчёта: ${row.evaluation.qualityFlags.join(', ') || 'не выявлены'}`,
  `Имеющиеся периоды: ${row.availablePeriods.join(', ') || 'нет'}`,
  `Отпечаток оценки: ${row.evaluation.fingerprint}`,
].filter((value): value is string => !!value);

export function weeklyText(report: ReportSnapshot): string[] {
  if (!report.comparison) return [];
  return [`Сравнение ${report.comparison.baselinePeriod} → ${report.selection.period}`,
    ...report.comparison.rows.flatMap(item => [`${item.current.goalTitle}. ${item.current.leaderName}`,
      `Факт: ${item.baseline ? rowValue(item.baseline) : 'нет снимка'} → ${rowValue(item.current)}. Разница: ${item.comparable ? reportNumber(item.actualDelta) : 'несопоставимо'}. ${item.reason}`,
      `Статус: ${item.baseline ? reportStatus(item.baseline) : 'нет снимка'} → ${reportStatus(item.current)}`,
      `Источники базового периода: ${item.baseline?.sources.map(s => `${s.sourceName}, ${s.id}, ${s.dataHash}`).join('; ') || 'нет'}`,
      `Источники отчётного периода: ${item.current.sources.map(s => `${s.sourceName}, ${s.id}, ${s.dataHash}`).join('; ') || 'нет'}`,
      ...item.changes.map(change => `${change.field}: ${change.before ?? 'не задано'} → ${change.after ?? 'не задано'}`)]),
    'Действия с датами', ...report.comparison.dueActions.map(action => `${action.dueDate}. ${action.owner}: ${action.action}`)];
}

export function reportHtml(report: ReportSnapshot) {
  const h = escapeHtml;
  return `<!doctype html><html lang="ru"><meta charset="utf-8"><title>Отчёт по целям ${h(report.selection.period)}</title><style>body{font:14px Arial,sans-serif;color:#17353a;margin:32px;line-height:1.5}h1{font-size:27px}h2{font-size:20px}table{width:100%;border-collapse:collapse;table-layout:fixed}th,td{padding:10px;border:1px solid #bfcdd0;text-align:left;vertical-align:top;overflow-wrap:anywhere}th{background:#edf4f3}.page{break-after:page}.page:last-child{break-after:auto}article{break-inside:avoid}p,li{overflow-wrap:anywhere}.meta{font-size:11px;color:#51686c}button{padding:10px}@media print{button{display:none}body{margin:0}@page{size:A4 landscape;margin:16mm}}</style><button onclick="window.print()">Печать / сохранить PDF</button><section class="page"><h1>Статус целей и ИТ-лидеров</h1><p>Период фактов: ${h(report.selection.period)}. Сформирован: ${h(report.createdAt)}.</p><p>${h(report.catalogName)}</p><p>Целей: ${report.summary.goals}. Подтверждено УОР: ${report.summary.confirmed}. Ожидает подтверждения: ${report.summary.pending}. Не выполнено: ${report.summary.notMet}. Нет данных: ${report.summary.unknown}.</p><h2>Ограничения</h2><ul>${report.limitations.map(item => `<li>${h(item)}</li>`).join('')}</ul><div class="meta">Снимок: ${h(report.id)}<br>Шаблон: ${h(report.template.name)} (${h(report.template.id)}, ${h(report.template.version)})<br>Версия приложения: ${h(report.versions.application)}<br>Каталог: ${h(report.versions.catalog)}<br>Факты: ${h(report.versions.facts)}<br>Подтверждения: ${h(report.versions.confirmations)}</div></section>${paginate(report.rows).map((page, index) => `<section class="page"><h2>Результаты ${index + 1}</h2><table><thead><tr><th style="width:35%">Цель</th><th style="width:25%">ИТ-лидер / ДИТ</th><th>Факт / порог</th><th>Статус</th></tr></thead><tbody>${page.map(row => `<tr><td>${h(row.goalTitle)}</td><td>${h(row.leaderName)}</td><td>${h(rowValue(row))}<br>Порог: ${h(reportOfficialTarget(row))}</td><td>${h(reportStatus(row))}</td></tr>`).join('')}</tbody></table></section>`).join('')}${report.comparison ? `<section class="page"><h2>Недельные изменения и действия</h2>${weeklyText(report).map(line => `<p>${h(line)}</p>`).join('')}</section>` : ''}${report.rows.map(row => `<section class="page"><h2>${h(row.goalTitle)}</h2><h3>${h(row.leaderName)}</h3><p>${h(rowValue(row))}. ${h(reportStatus(row))}.</p>${rowDetails(row).map(item => `<p>${h(item)}</p>`).join('')}</section>`).join('')}</html>`;
}

/** Text is split without dropping long Russian titles, names or comments. */
export function textPages(text: string, maxChars = 1100): string[] {
  const pages: string[] = [], lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let remaining = paragraph;
    while (remaining.length > 95) {
      const space = remaining.lastIndexOf(' ', 95), split = space > 40 ? space : 95;
      lines.push(remaining.slice(0, split)); remaining = remaining.slice(split).trimStart();
    }
    lines.push(remaining);
  }
  let page: string[] = [];
  for (const line of lines) {
    if (page.length && (page.length >= 17 || page.join('\n').length + line.length + 1 > maxChars)) { pages.push(page.join('\n')); page = []; }
    page.push(line);
  }
  if (page.length) pages.push(page.join('\n'));
  return pages;
}
export async function reportPptx(report: ReportSnapshot): Promise<Buffer> {
  const deck = new PptxGenJS(); deck.layout = 'LAYOUT_WIDE'; deck.author = report.createdBy; deck.subject = `Снимок ${report.id}`; deck.title = 'Статус целей и ИТ-лидеров';
  deck.theme = { headFontFace: 'Arial', bodyFontFace: 'Arial' };
  let number = 0;
  function page(title: string, body: string, fontSize = 18) {
    const slide = deck.addSlide(); number++;
    slide.background = { color: 'FFFFFF' };
    slide.addText(title, { x: 0.55, y: 0.35, w: 12.2, h: 0.7, fontSize: 27, bold: true, color: '154B50', breakLine: false });
    slide.addText(body, { x: 0.55, y: 1.25, w: 12.2, h: 5.3, fontSize, color: '203D42', valign: 'top', paraSpaceAfter: 10, margin: 0 });
    slide.addText(`${report.selection.period}  ·  ${report.template.id} / ${report.template.version}  ·  ${number}`, { x: 0.55, y: 7, w: 12.2, h: 0.25, fontSize: 10, color: '536D73' });
    slide.addNotes(`Снимок ${report.id}. Каталог ${report.versions.catalog}. Факты ${report.versions.facts}. Подтверждения ${report.versions.confirmations}.`);
    return slide;
  }
  page('Статус целей и ИТ-лидеров', `${report.catalogName}\nПериод фактов: ${report.selection.period}\nСформирован: ${report.createdAt}\n\nЦелей: ${report.summary.goals}\nПодтверждено УОР: ${report.summary.confirmed}\nОжидает подтверждения: ${report.summary.pending}\nНе выполнено: ${report.summary.notMet}\nНет данных: ${report.summary.unknown}`);
  for (const body of textPages(report.limitations.join('\n\n'))) page('Ограничения отчёта', body);
  for (const body of report.comparison ? textPages(weeklyText(report).join('\n\n')) : []) page('Недельные изменения и действия', body, 17);
  // Short logical tables. pptxgenjs repeats headers and adds slides if wrapped cells need more space.
  for (const group of paginate(report.rows, 4)) {
    const slide = page('Результаты по целям и ИТ-лидерам', '');
    slide.addTable([['Цель', 'ИТ-лидер / ДИТ', 'Факт / порог', 'Статус'], ...group.map(row => [row.goalTitle, row.leaderName, `${rowValue(row)} / ${reportOfficialTarget(row)}`, reportStatus(row)])].map(row => row.map(text => ({ text }))), {
      x: 0.55, y: 1.3, w: 12.2, colW: [4.3, 3, 2, 2.9], fontFace: 'Arial', fontSize: 16, color: '203D42', border: { pt: 0.5, color: 'C4D5D6' }, margin: 0.12,
      autoPage: true, autoPageRepeatHeader: true, autoPageSlideStartY: 0.6, rowH: 0.6,
    });
  }
  for (const row of report.rows) {
    const text = `${row.goalTitle}\n${row.leaderName}\n${rowValue(row)}. ${reportStatus(row)}.\n\n${rowDetails(row).join('\n\n')}`;
    for (const [index, body] of textPages(text).entries()) page(`Подробности${index ? ' (продолжение)' : ''}`, body, 17);
  }
  for (const body of textPages(`Снимок: ${report.id}\nШаблон: ${report.template.name}, ${report.template.version}\nПриложение: ${report.versions.application}\nКаталог: ${report.versions.catalog}\nФакты: ${report.versions.facts}\nПодтверждения: ${report.versions.confirmations}`)) page('Происхождение и версии', body, 16);
  return Buffer.from(await deck.write({ outputType: 'nodebuffer' }) as Buffer);
}
