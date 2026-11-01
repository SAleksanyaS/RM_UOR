import type { ReactNode } from 'react';
import type { PackageChange } from './contracts';
import type { DraftEntry } from '../../catalog/workbench-drafts';
import type { EntityRef, VersionRef } from '../../../domain/workbench/primitives';
import { workStateLabels } from '../../execution/workbench/execution-ui';

export const packageEntityLabels: Record<string, string> = {
  core_goal_definition: 'Цель', goal_assignment: 'Назначение', method_version: 'Методика', metric_definition: 'Показатель', source_definition: 'Источник', source_field_mapping: 'Соответствие полей', work: 'Работа', decision: 'Решение', commentary: 'Комментарий', attestation: 'Подтверждение УОР', agreed_snapshot: 'Согласованный срез', directory_entity: 'Организация или сотрудник', directory_link: 'Организационная связь', manual_correction: 'Официальное исправление', evidence: 'Доказательство', dashboard_def: 'Общий дашборд', custom_field_def: 'Описание поля', custom_field_value: 'Значение описательного поля', work_dependency: 'Зависимость работ', manual_status_event: 'Ручной статус', applicability: 'Применимость',
};
const fields: Record<string, string> = {
  title: 'Название', description: 'Описание', name: 'Название', state: 'Состояние', scope: 'Область', scopeRef: 'Область', goalId: 'Цель', goalIds: 'Связанные цели', methodRef: 'Методика', metricRef: 'Показатель', metricId: 'Показатель', rules: 'Правила расчёта', condition: 'Условие', target: 'Порог', text: 'Текст', comment: 'Комментарий', dueDate: 'Срок', dueOn: 'Плановый срок', forecastOn: 'Прогноз', nextAction: 'Следующий шаг', responsibility: 'Ответственность', personId: 'Ответственный', risk: 'Риск', reason: 'Причина', helpNeeded: 'Требуемая помощь', blocker: 'Блокировка', resultDescription: 'Результат работы', request: 'Запрос', answer: 'Ответ', requestedFromPersonId: 'Адресат решения', officialDueOn: 'Официальный срок', sourceId: 'Источник', mappingRef: 'Соответствие полей', workId: 'Работа', primaryCuratorPersonId: 'Основной куратор', coCuratorPersonIds: 'Со-кураторы', kind: 'Вид', mode: 'Способ оценки', lifecycle: 'Состояние цели', valueType: 'Тип значения', weight: 'Вес', mandatory: 'Обязательное условие', reducer: 'Обработка строк', normalization: 'Нормирование', formula: 'Итоговая формула', min: 'Нижняя граница', max: 'Верхняя граница', active: 'Действует', changeReason: 'Причина изменения', value: 'Значение', fieldRef: 'Описание поля', objectRef: 'Объект',
};
const enumLabels: Record<string, Record<string, string>> = {
  state: workStateLabels, kind: { qlik: 'ОКО', file: 'Файл', manual_status: 'Ручной статус' }, mode: { numeric: 'Числовой', manual_status: 'Ручной статус' }, lifecycle: { draft: 'Черновик', active: 'Действует', archived: 'В архиве' }, valueType: { text: 'Текст', long_text: 'Длинный текст', decimal: 'Число (Decimal)', date: 'Дата', boolean: 'Да / нет', enum: 'Один вариант', multi_enum: 'Несколько вариантов' },
};
const idFields: Record<string, string> = { goalId: 'core_goal_definition', goalIds: 'core_goal_definition', sourceId: 'source_definition', workId: 'work', predecessorWorkId: 'work', successorWorkId: 'work', personId: 'directory_entity', requestedFromPersonId: 'directory_entity', primaryCuratorPersonId: 'directory_entity', coCuratorPersonIds: 'directory_entity', metricId: 'metric_definition' };
export type PackageDiffLabels = Readonly<Record<string, string>>;
const referenceKey = (reference: EntityRef | VersionRef) => `${reference.entityType}/${reference.id}${'revision' in reference ? '/' + reference.revision : ''}`;

/** These names describe proposed draft values only; they are never historical labels. */
export function packageDraftLabels(entries: ReadonlyArray<Pick<DraftEntry, 'entityRef' | 'versionRef' | 'definition'>>): PackageDiffLabels {
  const labels: Record<string, string> = {};
  for (const entry of entries) {
    const title = [entry.definition.title, entry.definition.name, entry.definition.request].find(value => typeof value === 'string' && value.trim());
    if (typeof title !== 'string') continue;
    labels[referenceKey(entry.entityRef)] = title;
    labels[referenceKey(entry.versionRef)] = title;
  }
  return labels;
}
function referencedValue(value: unknown, field: string): (EntityRef | VersionRef) | null {
  if (typeof value === 'string' && idFields[field] && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value)) return { entityType: idFields[field], id: value };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (typeof item.id !== 'string') return null;
  const entityType = typeof item.entityType === 'string' ? item.entityType : ['scope', 'scopeRef'].includes(field) && typeof item.kind === 'string' ? 'directory_entity' : null;
  if (!entityType) return null;
  const referenceFields = typeof item.entityType === 'string' ? ['entityType', 'id', 'revision'] : ['kind', 'id'];
  if (Object.keys(item).some(key => !referenceFields.includes(key))) return null;
  if ('revision' in item && (!Number.isSafeInteger(item.revision) || Number(item.revision) < 1)) return null;
  return { entityType, id: item.id, ...(Number.isSafeInteger(item.revision) && Number(item.revision) > 0 ? { revision: Number(item.revision) } : {}) };
}
function DiffValue({ value, field, entityType, labels }: { value: unknown; field: string; entityType?: string; labels?: PackageDiffLabels }): ReactNode {
  if (value === undefined || value === null) return 'Не задано';
  if (value === '') return 'Пустое значение';
  if (typeof value === 'boolean') return value ? 'Да' : 'Нет';
  const reference = referencedValue(value, field);
  if (reference) return <div className="wb-diff-reference"><span className="wb-diff-reference-name">{labels?.[referenceKey(reference)] ?? 'Название не включено в пакет'}</span><span className="wb-cell-label">{packageEntityLabels[reference.entityType] ?? `Неизвестный тип: ${reference.entityType}`}</span><details className="wb-technical-details"><summary>Точная ссылка</summary><p>Тип: {reference.entityType}</p><p>Идентификатор: <code>{reference.id}</code></p>{'revision' in reference && <p>Редакция: {reference.revision}</p>}{typeof value === 'object' && value !== null && 'kind' in value && <p>Область: {String(value.kind)}</p>}</details></div>;
  if (typeof value === 'string') {
    const known = field === 'state' && entityType === 'work' || field === 'kind' && entityType === 'source_definition' || ['mode', 'lifecycle'].includes(field) && entityType === 'core_goal_definition' || field === 'valueType' && entityType === 'custom_field_def';
    return known ? enumLabels[field][value] ?? `Неизвестное значение: ${value}` : value;
  }
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.length ? <ul className="wb-diff-values">{value.map((item, index) => <li key={index}><DiffValue value={item} field={field} labels={labels} /></li>)}</ul> : 'Пустой список';
  const entries = Object.entries(value as Record<string, unknown>);
  return entries.length ? <dl className="wb-diff-object">{entries.map(([key, item]) => <div key={key}><dt>{fields[key] ?? key}</dt><dd><DiffValue value={item} field={key} labels={labels} /></dd></div>)}</dl> : 'Пустой объект';
}
function impact(type: string) {
  if (type === 'core_goal_definition') return 'Описание цели; новые общие значения появятся после принятия пакета.';
  if (['method_version', 'metric_definition', 'goal_assignment'].includes(type)) return 'Методика и будущие расчёты. Исторические основания сохраняются.';
  if (['source_definition', 'source_field_mapping'].includes(type)) return 'Будущее получение данных. Сохранённые наблюдения не заменяются.';
  if (type === 'attestation') return 'Подтверждение привязано к точному расчёту и основанию.';
  return 'Общая запись изменится после принятия пакета.';
}
/** labels contains proposed names from this exact package, not contemporary directory names. */
export function PackageDiff({ changes, labels }: { changes: PackageChange[]; labels?: PackageDiffLabels }) {
  return <section aria-label="Сравнение изменений"><h3>Было · main · станет</h3>{changes.length === 0 ? <p>Изменений полей нет</p> : changes.map((change, index) => <article className="wb-package-change" key={index}>
    <h4>{change.objectRef.entityType === 'core_goal_definition' && change.field === 'title' ? 'Название цели' : `${packageEntityLabels[change.objectRef.entityType] ?? `Неизвестный объект: ${change.objectRef.entityType}`} · ${fields[change.field] ?? change.field}`}</h4>
    <dl className="wb-diff-columns"><div><dt>В исходной редакции</dt><dd><DiffValue value={change.before} field={change.field} entityType={change.objectRef.entityType} /></dd></div><div><dt>В текущем main</dt><dd><DiffValue value={change.main} field={change.field} entityType={change.objectRef.entityType} /></dd></div><div><dt>Предлагается</dt><dd><DiffValue value={change.proposed} field={change.field} entityType={change.objectRef.entityType} labels={labels} /></dd></div></dl>
    {change.conflict && <p role="alert">Конфликт: выберите итоговое значение в редакторе объекта и заново проверьте пакет.</p>}
    <p className="wb-change-impact"><strong>Влияние: </strong>{impact(change.objectRef.entityType)}</p>
  </article>)}</section>;
}
