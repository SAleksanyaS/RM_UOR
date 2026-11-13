const kpiObjective = 'КПЭ Блока Т';
const supplementaryObjective = 'КПЭ Блока Т (вне скоупа целей А.Венкова)';
const processDirection = '#Техландшафт #Производственный_процесс';
const dataDirection = '#Техландшафт #Данные';
const architectureDirection = '#Техландшафт #Архитектура';
const securityDirection = '#Техландшафт #Кибербезопасность';
const technologyDirection = '#Техландшафт';

// A complete KR heading in its workbook context. Optional plan checks protect numerical aliases
// with an established threshold. A match suggests a relationship, independently of achievement.
const groups = [
  [kpiObjective, processDirection, [
    ['OB26', 'Проведена сертификация и подтвержден целевой уровень AI-навыков у 90% всей целевой аудитории (разработчики, аналитики и тестировщики)', 'quarter'],
    ['OB26', 'Доля разработчиков, аналитиков и тестировщиков достигли целевого уровня AI-навыков', 'year'],
    ['SW26', 'Доля команд мигрировали на Dream Jenkins', undefined, 100],
    ['SW26.2', 'Доля команд ДИТ достигли индивидуальных значений плотности дефектов ИФТ+ПСИ+ПРОМ приоритетов "Высокий+" согласно методике', 'year', 90],
    ['SW26.3', 'Доля команд ДИТ достигли индивидуальных значений по снижению длительности проведения тестирования на интеграционных полигонах согласно методике', 'year', 90],
    ['SW26.8', 'Рост количества story всех уровней сложности на сотрудника', undefined, 50],
    ['SW26.11', 'Доля ИИ кода, дошедшего до ПРОМ', undefined, 50],
    ['SW26.12', '% команд перешли на SDD подход'],
    ['LOCAL_100D', 'За 100 дней любая команда может вывести новую функциональность в ПРОМ', undefined, 100],
  ]],
  [kpiObjective, dataDirection, [
    ['SD02.19', 'Заключено 100% контрактов, опубликовано 100% оферт', undefined, 100],
    ['SD34.12', 'Обеспечена длительность подготовки источников к подключению к КАП р.д.', undefined, 20],
    ['SD37.10', 'Обеспечена T2Data загрузки данных в КАП (создание реплики) р.д.', undefined, 26],
    ['SD08.12', 'Исполнение планов RUN по загрузке источников и архивов: 100%. Доля загрузок Блоками 50%', undefined, 100],
  ]],
  [supplementaryObjective, dataDirection, [
    ['SD03.19', 'В 100% фронтальных контрактах указан бизнес-процесс', 'year', 100],
    ['SD04.19', 'Выполняется цель 98% по исполнению оферт', 'quarter', 98],
    ['SD23.16', '% оферт с контрактами имеют заполненный раздел по базовым проверкам качества данных для выявленных критичных данных (CDE)', undefined, 50],
    ['SD25.15', 'Назначено 100% владельцев данных в АС (кроме КАП)', undefined, 100],
    ['SD26.15', 'Назначено 100% владельцев данных для всех объектов КАП', undefined, 100],
    ['SD31.15', 'Раздел Change Management заполнен в 100% оферт', undefined, 100],
    ['SD39.17', 'В 100% оферт указаны питающие контракты', undefined, 100],
  ]],
  [kpiObjective, architectureDirection, [
    ['AR26.1', 'Цифровой двойник ИТ-ландшафта Банка и Группы как основа для авт-ции ИТ-пр. 90% API для интеграции ИТ-услуг описаны, 90% HTTP-API АС BC и выше поставлены на мониторинг Health-Check. 41% API прикладные доступы выдаются по процессу П3963', 'quarter'],
    ['AR26.1', 'Цифровой двойник ИТ-ландшафта Банка и Группы как основа для авт-ции ИТ-пр .45% ➛ 90% API для интеграции ИТ-услуг описаны,10% ➛ 90% HTTP-API АС BC и выше поставлены на мониторинг Health-Check.27% ➛ 41% API прикладные доступы выдаются по процессу П3963', 'year'],
    ['AR26.4', 'Достигнут % по GenAI-native score ИТ-ландшафта по Подразделению'],
  ]],
  [kpiObjective, securityDirection, [
    ['MT26', 'Задачи инициативы "Метла" выполнены в соответствии с планом', undefined, 100],
  ]],
  [kpiObjective, technologyDirection, [
    ['ITZ26', 'Достигнуто целевое значение ИТЗ'],
    ['IZT26', 'ИЗТР. Достигнуто целевое значение индикатора зрелости рисков технологий по подразделению (в части АС, Владельцем которой является ДИТ Ops) в режиме мониторинга', 'year'],
    ['LOCAL_LT35', 'Снижение LeadTime вывода агента', undefined, 35],
  ]],
];

function normalized(value) {
  return typeof value === 'string'
    ? value.normalize('NFKC').toLowerCase().replace(/ё/gu, 'е').replace(/["«»“”]/gu, '')
      .replace(/[‐‑–—−]/gu, '-').replace(/\s+/gu, ' ').trim()
    : '';
}

function aliasKey(objective, direction, keyResult) {
  const tags = normalized(direction).split(' ').sort().join(' ');
  return JSON.stringify([normalized(objective), tags, normalized(keyResult)]);
}

const aliases = new Map();
for (const [objective, direction, rules] of groups) {
  for (const [goalId, keyResult, period, plan] of rules) {
    const key = aliasKey(objective, direction, keyResult);
    if (!aliases.has(key)) aliases.set(key, []);
    aliases.get(key).push({ goalId, period, plan });
  }
}

export function statusGoalAlias({ objective, direction, keyResult, period, plan }) {
  const kind = /^Q[1-4]\s+20\d{2}$/iu.test(period) ? 'quarter' : /^Y\d{2}$/iu.test(period) ? 'year' : null;
  if (!kind) return null;
  const candidates = aliases.get(aliasKey(objective, direction, keyResult)) ?? [];
  const matches = new Set(candidates.filter(rule =>
    (!rule.period || rule.period === kind) && (rule.plan === undefined || plan === rule.plan)).map(rule => rule.goalId));
  return matches.size === 1 ? matches.values().next().value : null;
}
