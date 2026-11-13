import { createHash } from 'node:crypto';

const nonRiskStatuses = new Set(['в плане', 'выполнено']);
const comparedFields = [
  'status', 'plan', 'fact', 'progress', 'forecast', 'curator', 'curatorComment',
  'leaderComment', 'artifact', 'artifactStatus',
];

function normalize(value) {
  return typeof value === 'string'
    ? value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase()
    : '';
}

export function registerKey(entry) {
  const identity = [entry?.objective, entry?.keyResult, entry?.leader].map(normalize);
  if (identity.some(part => part === '')) return null;
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

function datedSnapshot(snapshot) {
  const asOf = snapshot?.asOf;
  if (typeof asOf !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(asOf)) {
    throw new Error('Для сравнения укажите дату каждого среза.');
  }
  const date = new Date(asOf);
  if (!Number.isFinite(date.valueOf()) || date.toISOString().slice(0, 10) !== asOf) {
    throw new Error('Дата среза указана неверно.');
  }
  if (!Array.isArray(snapshot.entries)) throw new Error('В срезе отсутствует список ключевых результатов.');
  return { source: snapshot.source ?? null, asOf };
}

function buildIndex(rows, side, withoutIdentity) {
  const index = new Map();
  for (const entry of rows) {
    const key = registerKey(entry);
    if (key === null) {
      withoutIdentity.push({ side, entry });
      continue;
    }
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(entry);
  }
  return index;
}

function riskState(entry) {
  const status = normalize(entry?.status);
  if (status === 'есть риски' || status === 'под риском') return 'risk';
  return nonRiskStatuses.has(status) ? 'clear' : 'unknown';
}

function comparableField(value, name) {
  if (name === 'status') return normalize(value);
  return typeof value === 'string' ? value.normalize('NFKC').trim() : value ?? null;
}

function changedFields(previous, current) {
  const fields = [];
  for (const name of comparedFields) {
    const before = previous[name] ?? null;
    const after = current[name] ?? null;
    if (comparableField(before, name) !== comparableField(after, name)) {
      fields.push({ name, previous: before, current: after });
    }
  }
  return fields;
}

function comparePair(pair, diff) {
  const { previous, current } = pair;
  const before = riskState(previous);
  const after = riskState(current);
  if (previous === null) {
    diff.counts.unmatchedCurrent++;
    if (after === 'risk') diff.unverifiedRisks.push({ ...pair, reason: 'missingPrevious' });
    return;
  }
  if (current === null) {
    diff.counts.unmatchedPrevious++;
    if (before === 'risk') diff.missingRisks.push(pair);
    return;
  }

  diff.counts.matched++;
  const fields = changedFields(previous, current);
  if (fields.length) diff.changed.push({ ...pair, fields });
  if (before === 'risk') {
    if (after === 'risk') diff.persistingRisks.push(pair);
    if (after === 'clear') diff.closedRisks.push(pair);
    if (after === 'unknown') diff.unresolvedRisks.push({ ...pair, reason: 'unknownCurrentStatus' });
  }
  if (after === 'risk' && before === 'clear') diff.newRisks.push(pair);
  if (after === 'risk' && before === 'unknown') diff.unverifiedRisks.push({ ...pair, reason: 'unknownPreviousStatus' });
}

export function compareStatusSnapshots(previous, current, { period } = {}) {
  if (typeof period !== 'string' || !period.trim()) throw new Error('Выберите период для сравнения срезов.');
  const earlier = datedSnapshot(previous);
  const later = datedSnapshot(current);
  if (earlier.asOf >= later.asOf) throw new Error('Дата текущего среза должна быть позже даты предыдущего.');

  const before = previous.entries.filter(entry => entry?.period === period);
  const after = current.entries.filter(entry => entry?.period === period);
  const diff = {
    period,
    previous: earlier,
    current: later,
    newRisks: [],
    closedRisks: [],
    persistingRisks: [],
    missingRisks: [],
    unverifiedRisks: [],
    unresolvedRisks: [],
    changed: [],
    ambiguous: [],
    withoutIdentity: [],
    counts: {
      previousRows: before.length,
      currentRows: after.length,
      previousRiskRows: before.filter(entry => riskState(entry) === 'risk').length,
      currentRiskRows: after.filter(entry => riskState(entry) === 'risk').length,
      matched: 0,
      unmatchedPrevious: 0,
      unmatchedCurrent: 0,
      ambiguous: 0,
      withoutIdentity: 0,
    },
  };

  const beforeIndex = buildIndex(before, 'previous', diff.withoutIdentity);
  const afterIndex = buildIndex(after, 'current', diff.withoutIdentity);
  for (const key of new Set([...beforeIndex.keys(), ...afterIndex.keys()])) {
    const earlierRows = beforeIndex.get(key) ?? [];
    const laterRows = afterIndex.get(key) ?? [];
    if (earlierRows.length > 1 || laterRows.length > 1) {
      diff.ambiguous.push({ key, previous: earlierRows, current: laterRows });
      continue;
    }
    comparePair({ key, previous: earlierRows[0] ?? null, current: laterRows[0] ?? null }, diff);
  }
  diff.counts.ambiguous = diff.ambiguous.length;
  diff.counts.withoutIdentity = diff.withoutIdentity.length;
  return diff;
}
