const dayMs = 86_400_000;
const sectionAliases = {
  achievements: [
    'достижения', 'достижения за неделю', 'достижения недели', 'что сделали', 'что сделано', 'сделано',
    'сделано за неделю', 'главные выполненные задачи уор', 'главные выполненные задачи',
    'выполненные задачи', 'основные результаты недели', 'результаты недели',
  ],
  attention: [
    'внимание', 'внимания', 'требует внимания', 'требуют внимания', 'что требует внимания', 'на что обратить внимание',
    'зоны внимания', 'риски', 'риски и блокеры', 'риски и проблемы', 'проблема в фокусе ит-лидера',
  ],
  plans: [
    'планы', 'план', 'плана', 'задачи', 'планы следующей недели', 'планы на следующую неделю', 'план на следующую неделю',
    'задачи на следующую неделю', 'задачи следующей недели', 'что планируем', 'следующие шаги',
  ],
  insights: [
    'инсайты', 'инсайта', 'инсайты недели', 'инсайты за неделю', 'выводы', 'наблюдения и выводы',
    'выводы и инсайты', 'инсайты и выводы',
  ],
};
const sectionByLabel = new Map(Object.entries(sectionAliases).flatMap(([key, labels]) => labels.map(label => [label, key])));
const marker = /^\s*(?:\d{1,2}[.)]\s+|[-–—*+]\s+|[•●◦▪‣✓✔☑]\s*)(?:\[[ xX]\]\s*)?/u;
const numberedMarker = /^\s*\d{1,2}[.)]\s+/u;
const fullDate = String.raw`(?:\d{4}-\d{2}-\d{2}|\d{1,2}\.\d{1,2}\.\d{4})`;
const rangePattern = new RegExp('(?<![\\d.])(' + fullDate + ')\\s*(?:[-–—−]|по|\\.\\.)\\s*(' + fullDate + ')(?!\\d)', 'iu');
const datePattern = new RegExp('(?<![\\d.])(' + fullDate + ')(?!\\d)', 'u');
const isoWeekPattern = /(?<![\p{L}\d])(\d{4})-W(\d{2})(?![\p{L}\d])/iu;
const periodPrefix = /^(?:неделя|отчетная неделя|отчетный период|период|начало недели|(?:еженедельный |недельный )?отчет|направление)(?=$|[\s:№|·])/u;
const datedStartPrefix = /^(?:начало недели|(?:отчетная )?неделя|(?:еженедельный )?отчет за неделю)\s*[:\-–—]?\s*(?:с|от)?$/u;

function cleanHeading(value) {
  return value.trim().replace(/^#{1,6}\s+/u, '').replace(/\s+#{1,6}$/u, '')
    .replace(/^\*\*([\s\S]*)\*\*$/u, '$1').replace(/^__([\s\S]*)__$/u, '$1').trim();
}

function normalize(value) {
  return value.normalize('NFKC').toLowerCase().replace(/ё/gu, 'е').replace(/\s+/gu, ' ').trim();
}

function dateValue(value) {
  const dotted = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/u.exec(value);
  const iso = dotted ? [dotted[3], dotted[2].padStart(2, '0'), dotted[1].padStart(2, '0')].join('-') : value;
  const date = new Date(iso + 'T00:00:00.000Z');
  return Number.isFinite(date.valueOf()) && isoDay(date) === iso ? date : null;
}

function isoDay(date) {
  return date.toISOString().slice(0, 10);
}

function monday(date) {
  return new Date(date.valueOf() - ((date.getUTCDay() + 6) % 7) * dayMs);
}

function weekFromIso(year, number) {
  const index = Number(number);
  if (index < 1 || index > 53) return null;
  const first = dateValue(year + '-01-04');
  if (!first) return null;
  const date = new Date(monday(first).valueOf() + (index - 1) * 7 * dayMs);
  const thursday = new Date(date.valueOf() + 3 * dayMs);
  return thursday.getUTCFullYear() === Number(year) ? isoDay(date) : null;
}

function headingHasPeriod(raw, prefix, suffix) {
  const start = normalize(prefix);
  return !start || start === 'с' || periodPrefix.test(start) || /^#{1,6}\s+/u.test(raw.trim()) ||
    /[|·]\s*$/u.test(prefix) || (/\(\s*$/u.test(prefix) && /^\s*\)/u.test(suffix));
}

// undefined is ordinary text. null marks an explicit but unsupported or invalid period boundary.
function weekHeading(raw, followedBySection) {
  if (marker.test(raw)) return undefined;
  const text = cleanHeading(raw);
  const range = rangePattern.exec(text);
  const prefix = range ? text.slice(0, range.index) : '';
  const suffix = range ? text.slice(range.index + range[0].length) : '';
  if (range && (headingHasPeriod(raw, prefix, suffix) || (followedBySection && !suffix.trim() && prefix.length <= 100))) {
    const start = dateValue(range[1]);
    const end = dateValue(range[2]);
    if (!start || !end) return null;
    const days = (end.valueOf() - start.valueOf()) / dayMs;
    if (days < 1 || days > 7) return null;
    return {
      week: isoDay(monday(end)),
      range: { start: isoDay(start), end: isoDay(end) },
    };
  }
  const iso = isoWeekPattern.exec(text);
  if (iso && headingHasPeriod(raw, text.slice(0, iso.index), text.slice(iso.index + iso[0].length))) {
    const week = weekFromIso(iso[1], iso[2]);
    return week ? { week } : null;
  }
  const date = datePattern.exec(text);
  if (date && datedStartPrefix.test(normalize(text.slice(0, date.index)))) {
    const start = dateValue(date[1]);
    return start?.getUTCDay() === 1 ? { week: isoDay(start) } : null;
  }
  return undefined;
}

function sectionHeading(raw) {
  const bullet = marker.exec(raw);
  if (bullet && !numberedMarker.test(raw)) return null;
  const text = cleanHeading(bullet ? raw.slice(bullet[0].length) : raw);
  const separator = text.indexOf(':');
  const name = separator < 0 ? text : text.slice(0, separator);
  const inline = separator < 0 ? '' : text.slice(separator + 1).trim();
  const label = normalize(cleanHeading(name)).replace(/^топ\s*[-–—]?\s*3\s+/u, '');
  const key = sectionByLabel.get(label);
  return key && (!bullet || !inline) ? { key, inline } : null;
}

function items(lines) {
  const hasMarkers = lines.some(line => marker.test(line));
  const values = [];
  for (const raw of lines) {
    const bullet = marker.exec(raw);
    const value = (bullet ? raw.slice(bullet[0].length) : raw).trim();
    if (!value || /^(?:[-–—]+|нет данных|нет записей|н\/д)\.?$/iu.test(value)) continue;
    if (bullet || !values.length || (!hasMarkers && !/^\s/u.test(raw))) {
      values.push(value);
    } else {
      values[values.length - 1] += '\n' + value;
    }
  }
  return values;
}

function saveBlock(block, reports) {
  if (!block || !block.groups.size || reports.get(block.period.week) === null) return;
  const sections = {};
  for (const key of Object.keys(sectionAliases)) {
    const lists = (block.groups.get(key) ?? []).map(items).filter(list => list.length);
    if (new Set(lists.map(list => JSON.stringify(list))).size > 1) {
      reports.set(block.period.week, null);
      return;
    }
    sections[key] = lists[0] ?? [];
  }
  if (!Object.values(sections).some(list => list.length)) return;
  const week = block.period.week;
  const current = { ...block.period, sections };
  const prior = reports.get(week);
  const conflict = prior && (JSON.stringify(prior.sections) !== JSON.stringify(sections) ||
    (prior.range && current.range && JSON.stringify(prior.range) !== JSON.stringify(current.range)));
  reports.set(week, conflict ? null : prior?.range ? prior : current);
}

export function parseCuratorWeeks(text) {
  if (typeof text !== 'string' || !text.trim() || text.length > 100_000) return [];
  const lines = text.split(/\r\n?|\n|\u2028|\u2029/u);
  const reports = new Map();
  let block = null;
  let activeLines = null;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const next = lines[index + 1] ?? '';
    const period = weekHeading(line, Boolean(sectionHeading(next)));
    if (period !== undefined) {
      saveBlock(block, reports);
      block = period && { period, groups: new Map() };
      activeLines = null;
      continue;
    }
    if (!block) continue;
    let heading = sectionHeading(line);
    if (!heading && next?.trim() && line.trim() && !marker.test(line) && !marker.test(next)) {
      heading = sectionHeading(cleanHeading(line) + ' ' + cleanHeading(next));
      if (heading) index++;
    }
    if (heading) {
      activeLines = heading.inline ? [heading.inline] : [];
      if (!block.groups.has(heading.key)) block.groups.set(heading.key, []);
      block.groups.get(heading.key).push(activeLines);
    } else if (/^\s*#{1,6}\s+/u.test(line)) {
      activeLines = null;
    } else {
      activeLines?.push(line);
    }
  }
  saveBlock(block, reports);
  return [...reports.values()].filter(Boolean).map(report => ({
    ...report,
    sections: Object.fromEntries(Object.entries(report.sections).map(([key, list]) => [key, list.slice(0, 3)])),
  }));
}
