import type { Header, UUIDv4 } from '../../src/domain/workbench/primitives';
import type { DirectoryEntity, DirectoryLink, Work, Decision, WorkbenchEntity, WorkbenchEntityType } from '../../src/domain/workbench/entities';
import type { WorkbenchRepository } from '../../src/server/storage/workbench-repository';
import { fixtureId, makeEntityGraph, makeHeader, makeNumericFixture, makePublicationAnchor } from '../../tests/fixtures/workbench/factories';

/** Synthetic reference data only. Call explicitly on a disposable, empty core. */
export function seedGoalReference(repository: WorkbenchRepository): { ditId: UUIDv4; goalIds: UUIDv4[] } {
  if (repository.exportWorkspaceCore().length !== 0) {
    throw new Error('Design reference requires an empty disposable workbench; existing data was not changed');
  }

  const ditId = fixtureId(900_001);
  const clusterIds = [fixtureId(900_002), fixtureId(900_003)] as const;
  const directorId = fixtureId(900_011);
  const leaderIds = [fixtureId(900_012), fixtureId(900_013)] as const;
  const anchorId = fixtureId(900_100);
  const observedAt = '2026-11-01T06:30:00Z';
  const actor = { hostname: 'synthetic-design-reference', installationId: fixtureId(900_101), profilePersonId: directorId };
  const anchor = makePublicationAnchor({
    id: anchorId, packageId: anchorId, repositoryId: 'synthetic-design-reference',
    pullRequestId: 'synthetic-reference-1', mergedAt: '2026-11-01T08:00:00Z',
    verifiedAt: '2026-11-01T08:01:00Z', reason: 'Синтетические данные визуального эталона; не банковская публикация.',
  });
  const header = (seed: number): Header => makeHeader(seed, { actor, recordedAt: observedAt, publicationAnchorId: anchorId });
  const entries: Array<{ entityType: WorkbenchEntityType; value: WorkbenchEntity }> = [];
  const add = (entityType: WorkbenchEntityType, value: WorkbenchEntity) => entries.push({ entityType, value });

  const directory: Array<{ seed: number; kind: DirectoryEntity['kind']; name: string }> = [
    { seed: 900_001, kind: 'dit', name: 'Демонстрационный ДИТ' },
    { seed: 900_002, kind: 'cluster', name: 'Клиентские сервисы' },
    { seed: 900_003, kind: 'cluster', name: 'Надёжность платформы' },
    { seed: 900_011, kind: 'person', name: 'Елена Морозова' },
    { seed: 900_012, kind: 'person', name: 'Анна Соколова' },
    { seed: 900_013, kind: 'person', name: 'Михаил Орлов' },
  ];
  for (const value of directory) add('directory_entity', { ...header(value.seed), kind: value.kind, name: value.name, externalKeys: [] });
  const links: DirectoryLink[] = [
    ...clusterIds.map((id, index): DirectoryLink => ({ ...header(900_021 + index), kind: 'dit_cluster', from: { entityType: 'directory_entity', id: ditId }, to: { entityType: 'directory_entity', id } })),
    { ...header(900_023), kind: 'leader', scope: { kind: 'dit', id: ditId }, personId: directorId },
    ...clusterIds.map((id, index): DirectoryLink => ({ ...header(900_024 + index), kind: 'leader', scope: { kind: 'cluster', id }, personId: leaderIds[index] })),
  ];
  links.forEach(value => add('directory_link', value));

  const goals = [
    { title: 'Обращения решены в срок', description: 'Не менее 95% обращений закрываются в установленный срок.', metric: 'Доля обращений, решённых в срок', value: '87', target: '95', unit: 'percent', unitLabel: '%', cluster: 0, decrease: false },
    { title: 'Новые команды подключены к сервису', description: 'Подключить к сервису не менее 200 команд.', metric: 'Подключённые команды', value: '250', target: '200', unit: 'count', unitLabel: 'команд', cluster: 0, decrease: false },
    { title: 'Регламентные задания выполнены успешно', description: 'Не менее 98% заданий завершаются успешно. Значение ожидается из источника.', metric: 'Доля успешно выполненных заданий', value: null, target: '98', unit: 'percent', unitLabel: '%', cluster: 1, decrease: false },
    { title: 'Критические инциденты под контролем', description: 'Не более пяти критических инцидентов за отчётную дату.', metric: 'Критические инциденты', value: '3', target: '5', unit: 'count', unitLabel: 'инцидентов', cluster: 1, decrease: true },
  ] as const;
  const goalIds: UUIDv4[] = [];
  for (const [index, goal] of goals.entries()) {
    const input = makeNumericFixture({
      seedBase: (index + 1) * 100_000,
      scope: { kind: 'cluster', id: clusterIds[goal.cluster] },
      values: [goal.value], targets: [goal.target], mandatory: [true],
      context: { evaluatedAt: '2026-11-01T09:00:00Z', businessTime: { kind: 'as_of', date: '2026-11-01' } },
    });
    input.goal.title = goal.title;
    input.goal.description = goal.description + ' Синтетический пример для визуального эталона.';
    input.goal.primaryCuratorPersonId = leaderIds[goal.cluster];
    input.assignment.officialDueOn = '2026-11-06';
    input.metrics[0].name = goal.metric;
    input.metrics[0].unit = { code: goal.unit, label: goal.unitLabel };
    input.metrics[0].domain = goal.unit === 'count' ? 'nonnegative_integer' : 'nonnegative_decimal';
    if (input.method.mode !== 'numeric') throw new Error('Numeric fixture returned a nonnumeric method');
    if (goal.decrease) {
      input.method.rules[0].condition = { op: 'lte', target: goal.target };
      input.method.rules[0].normalization = { kind: 'decrease_ratio_capped_v1', maxPercent: '200' };
    }
    for (const capture of input.captures) {
      capture.capturedAt = observedAt;
      capture.sourceUpdatedAt = observedAt;
      capture.canonicalRows.forEach(row => { row.unitCode = goal.unit; });
    }
    for (const fact of input.facts) {
      fact.sourceUpdatedAt = observedAt;
      fact.unitCode = goal.unit;
      if (fact.state === 'missing') fact.missingReason = 'Источник ещё не передал значение за 1 ноября';
    }
    input.resolution.actor = actor;
    input.resolution.publicationAnchors = [anchor];
    const graph = makeEntityGraph(input);
    for (const entry of graph.entries) {
      // Shared directory and leaders above replace the factory's generated names.
      if (entry.entityType === 'directory_entity') continue;
      entry.value.actor = actor;
      entry.value.recordedAt = observedAt;
      entry.value.publicationAnchorId = anchorId;
      if (entry.entityType === 'source_field_mapping') {
        const mapping = entry.value as Extract<WorkbenchEntity, { metricFields: unknown }>;
        mapping.fixedUnitCode = goal.unit;
      }
      if (entry.entityType === 'source_definition') {
        const source = entry.value as Extract<WorkbenchEntity, { publicLocator: unknown }>;
        source.publicLocator = `https://example.invalid/design-reference/goal-${index + 1}`;
      }
      add(entry.entityType, entry.value);
    }
    goalIds.push(input.goal.id);
  }

  const works: Work[] = [
    {
      ...header(900_201), title: 'Сократить очередь просроченных обращений', goalIds: [goalIds[0]],
      responsibility: [{ scope: { kind: 'cluster', id: clusterIds[0] }, personId: leaderIds[0] }],
      state: 'in_progress', dueOn: '2026-11-03', forecastOn: '2026-11-05',
      nextAction: 'Согласовать усиление смены поддержки до 2 ноября', reason: null, resultDescription: null, evidenceIds: [],
      risk: { reason: 'Текущей смены недостаточно для разбора очереди в срок', helpNeeded: 'Выделить двух специалистов поддержки на три дня' },
      blocker: null,
    },
    {
      ...header(900_202), title: 'Подтвердить данные регламентных заданий', goalIds: [goalIds[2]],
      responsibility: [{ scope: { kind: 'cluster', id: clusterIds[1] }, personId: leaderIds[1] }],
      state: 'in_progress', dueOn: '2026-11-02', forecastOn: '2026-11-02',
      nextAction: 'Получить выгрузку и проверить полноту строк за 1 ноября', reason: null, resultDescription: null, evidenceIds: [],
      risk: null, blocker: 'Источник ещё не передал значение показателя',
    },
  ];
  works.forEach(value => add('work', value));
  const decision: Decision = {
    ...header(900_211), workId: works[0].id,
    request: 'Выделить двух специалистов для разбора просроченных обращений на три дня',
    requestedFromPersonId: directorId, dueOn: '2026-11-02', answer: null, answeredAt: null,
  };
  add('decision', decision);

  // Atomic seeding preserves an empty core if any current schema/reference rejects the fixture.
  repository.transaction(() => {
    repository.appendPublicationAnchor(anchor, null);
    for (const { entityType, value } of entries) repository.append(entityType, value, null);
  });
  return { ditId, goalIds };
}
