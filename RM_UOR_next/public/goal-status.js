const excludedGoals = new Set(['monitor', 'removed', 'outOfScope']);
const completedStatuses = new Set(['выполнено', 'выполнена', 'достигнуто', 'достигнута', 'завершено']);
const riskStatuses = new Set(['есть риск', 'есть риски', 'под риском', 'риск принят', 'риски приняты']);
const plannedStatuses = new Set(['в плане', 'в работе']);
const incompleteStatuses = new Set(['не выполнено', 'не выполнена', 'частично выполнено', 'просрочено']);
const noMethodStatuses = new Set(['нет методики', 'нет методики для оценки статуса исполнения']);

function canonicalStatus(status) {
  const key = String(status ?? '').normalize('NFKC').toLocaleLowerCase('ru-RU').replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
  if (completedStatuses.has(key)) return 'Выполнено';
  if (riskStatuses.has(key)) return 'Под риском';
  if (plannedStatuses.has(key)) return 'В плане';
  if (incompleteStatuses.has(key)) return 'Не выполнено';
  return noMethodStatuses.has(key) ? 'Нет методики' : '';
}

const assignmentKey = (goalId, scopeId, period) => JSON.stringify([goalId, scopeId, period]);

function reportIndex(entries, periods) {
  const index = new Map();
  for (const entry of entries) {
    if (!periods.has(entry.period) || !entry.goalId || !entry.scopeId) continue;
    if (entry.linkState !== 'confirmed' && entry.linkState !== 'suggested') continue;
    const key = assignmentKey(entry.goalId, entry.scopeId, entry.period);
    if (!index.has(key)) index.set(key, { confirmed: [], suggested: [] });
    index.get(key)[entry.linkState].push(entry);
  }
  return index;
}

function reportResult(candidates) {
  const confirmed = candidates?.confirmed ?? [];
  const suggested = candidates?.suggested ?? [];
  const preliminary = !confirmed.length && suggested.length === 1;
  const rows = preliminary ? suggested : confirmed;
  return { status: combinedStatus(rows.map(row => canonicalStatus(row.status))), rows, preliminary };
}

function combinedStatus(statuses) {
  if (!statuses.length) return '';
  if (statuses.includes('Под риском')) return 'Под риском';
  if (statuses.every(value => value === 'Выполнено')) return 'Выполнено';
  if (statuses.includes('Не выполнено')) return 'Не выполнено';
  if (statuses.includes('В плане')) return 'В плане';
  return statuses.every(Boolean) ? 'Нет методики' : '';
}

export function projectGoalStatuses(goals, directory, register, periods = register?.periods ?? []) {
  const periodSet = new Set(periods.filter(period => typeof period === 'string' && period.trim()));
  const leaders = new Map(directory.filter(entry => entry.type === 'leader').map(entry => [entry.id, entry.name]));
  const reports = reportIndex(register?.entries ?? [], periodSet);
  const result = [];
  for (const goal of goals) {
    if (excludedGoals.has(goal.status)) continue;
    const assigned = new Set((goal.assignments ?? []).filter(item => item.active !== false).map(item => item.leaderId));
    for (const scopeId of assigned) {
      if (!leaders.has(scopeId)) continue;
      for (const period of periodSet) {
        const evidence = reportResult(reports.get(assignmentKey(goal.id, scopeId, period)));
        result.push({ id: [goal.id, scopeId, period].map(encodeURIComponent).join(':'), goalId: goal.id,
          scopeId, leader: leaders.get(scopeId), objective: goal.title, period, ...evidence });
      }
    }
  }
  return result;
}

function hasValue(value) {
  return value != null && value !== '';
}

function leaderEvidence(assignments) {
  const rows = assignments.flatMap(entry => entry.rows);
  const measured = assignments.filter(entry => entry.rows.some(row => hasValue(row.fact))).length;
  const sameMetric = new Set(rows.map(row => row.keyResult)).size === 1 && assignments.every(entry => entry.rows.length <= 1);
  const plans = new Set(rows.map(row => row.plan));
  const commonPlan = sameMetric && rows.length === assignments.length && plans.size === 1 ? rows[0]?.plan : null;
  const facts = rows.filter(row => hasValue(row.fact)).map(row => row.fact);
  const comparable = sameMetric && facts.length && facts.every(Number.isFinite);
  const number = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 3 });
  const range = comparable ? [...new Set([Math.min(...facts), Math.max(...facts)])].map(value => number.format(value)).join('–') : '';
  const statuses = assignments.map(entry => entry.status);
  const reported = statuses.filter(Boolean).length;
  return { rows, commonPlan, status: combinedStatus(statuses),
    statusBasis: reported ? `Статусы лидеров · ${reported} из ${assignments.length}` : '',
    factBasis: measured ? `Факты лидеров · ${measured} из ${assignments.length}${range ? ` · ${range}` : ''}` : '' };
}

export function projectDitGoalStatuses(goals, directory, register, periods = register?.periods ?? [], manual = []) {
  const periodSet = new Set(periods.filter(period => typeof period === 'string' && period.trim()));
  const reports = reportIndex(register?.entries ?? [], periodSet);
  const overrides = new Map(manual.filter(entry => entry.status).map(entry => [assignmentKey(entry.goalId, 'dit', entry.period), entry.status]));
  const assignments = new Map();
  for (const entry of projectGoalStatuses(goals, directory, register, [...periodSet])) {
    const key = assignmentKey(entry.goalId, 'dit', entry.period);
    if (!assignments.has(key)) assignments.set(key, []);
    assignments.get(key).push(entry);
  }
  const leader = directory.find(item => item.id === 'dit')?.name || 'ДИТ OPS';
  return goals.filter(goal => !excludedGoals.has(goal.status)).flatMap(goal => [...periodSet].map(period => {
    const key = assignmentKey(goal.id, 'dit', period);
    const direct = reportResult(reports.get(key));
    const evidence = direct.rows.length ? direct : leaderEvidence(assignments.get(key) ?? []);
    const single = direct.rows.length === 1 ? direct.rows[0] : null;
    const plan = single?.plan ?? evidence.commonPlan ?? (hasValue(goal.target) ? goal.target : goal.metric) ?? null;
    const fact = single?.fact ?? null;
    const override = overrides.get(key);
    const basis = [override ? 'Ручной статус ДИТ' : evidence.statusBasis,
      direct.rows.length ? 'Итоговая строка ДИТ из Excel' : evidence.factBasis,
      !hasValue(single?.plan) && !hasValue(evidence.commonPlan) && hasValue(plan) ? 'Цель из карты' : ''].filter(Boolean).join('. ');
    return { id: [goal.id, 'dit', period].map(encodeURIComponent).join(':'), goalId: goal.id, scopeId: 'dit', leader,
      objective: goal.title, period, plan, fact, basis, status: override ?? evidence.status, rows: evidence.rows };
  }));
}
