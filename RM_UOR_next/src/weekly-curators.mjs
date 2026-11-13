import { parseCuratorWeeks } from './weekly-curator-parser.mjs';

const sectionNames = ['achievements', 'attention', 'plans', 'insights'];

function asDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value ? date : null;
}

export function isReportWeek(value) {
  return asDate(value)?.getUTCDay() === 1;
}

function rowKey({ connectorId, curator, url, week }) {
  return JSON.stringify([connectorId, curator, url, week]);
}

export function validateCuratorWeeks(value, ids) {
  if (!Array.isArray(value)) throw new TypeError('Invalid curator archive');
  const keys = new Set();
  for (const entry of value) {
    if (!entry || !ids.has(entry.connectorId) || typeof entry.curator !== 'string' || !entry.curator
        || typeof entry.url !== 'string' || !isReportWeek(entry.week)
        || !sectionNames.every(name => Array.isArray(entry.sections?.[name]) && entry.sections[name].length <= 3
          && entry.sections[name].every(item => typeof item === 'string' && item.trim()))
        || (entry.range && (!asDate(entry.range.start) || !asDate(entry.range.end) || entry.range.start > entry.range.end))) {
      throw new TypeError('Invalid curator week');
    }
    const key = rowKey(entry);
    if (keys.has(key)) throw new TypeError('Duplicate curator week');
    keys.add(key);
  }
  return value;
}

export function captureCuratorWeeks(archive, connector, text, curatorKey) {
  if (!connector.curator) return { archive, captured: 0 };
  const pages = parseCuratorWeeks(text);
  if (!pages.length) return { archive, captured: 0 };
  const rows = new Map(archive.map(row => [rowKey(row), row]));
  for (const page of pages) {
    const row = { ...page, connectorId: connector.id, curator: curatorKey(connector.curator), url: connector.url };
    rows.set(rowKey(row), row);
  }
  return { archive: [...rows.values()], captured: pages.length };
}

export function curatorWeekView(week, connectors, archive, curatorKey) {
  const availableWeeks = new Set();
  const curators = connectors.filter(connector => connector.curator).map(connector => {
    const reports = archive.filter(row => row.connectorId === connector.id
      && row.curator === curatorKey(connector.curator) && row.url === connector.url);
    for (const report of reports) availableWeeks.add(report.week);
    const report = reports.find(row => row.week === week);
    return { name: connector.curator, url: connector.url, sections: report?.sections ?? null,
      ...(report?.range ? { range: report.range } : {}) };
  });

  const summary = Object.fromEntries(sectionNames.map(name => {
    const items = [];
    const seen = new Set();
    for (let rank = 0; rank < 3 && items.length < 3; rank++) {
      for (const card of curators) {
        const text = card.sections?.[name][rank];
        if (!text) continue;
        const key = text.normalize('NFKC').toLocaleLowerCase('ru').replace(/\s+/gu, ' ').trim();
        if (seen.has(key)) continue;
        seen.add(key);
        items.push({ text, curator: card.name });
        if (items.length === 3) break;
      }
    }
    return [name, items];
  }));
  return { week, weeks: [...availableWeeks].sort().reverse(), summary, curators };
}
