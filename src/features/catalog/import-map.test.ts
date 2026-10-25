import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { importGoalMap } from './import-map';

const html = readFileSync(new URL('../../../tests/fixtures/goal-map-demo.html', import.meta.url), 'utf8');
const at = '2026-10-24T09:00:00.000Z';

describe('importGoalMap', () => {
  it('reads the JSON data and preserves the map, goals, assignments and links without executing HTML', () => {
    const catalog = importGoalMap(html, { classification: 'demo', importedAt: at });
    expect(catalog.name).toBe('Карта · демонстрационные цели');
    expect(catalog.importedAt).toBe(at);
    expect(catalog.goals).toHaveLength(2);
    expect(catalog.leaders).toEqual([{ id: 'leader_a', name: 'Лидер А.', teams: ['Продукт А'] }]);
    expect(catalog.goals[0]).toMatchObject({ id: 'GOAL_A', officialTarget: 80, unit: '%', summary: 'Описание из карты.', actions: ['Проверить состав'], ownerId: null, curatorId: null, internalTarget: null, weight: null, priority: null, dueDate: null });
    expect(catalog.assignments[0]).toMatchObject({ goalId: 'GOAL_A', leaderId: 'leader_a', target: '90% команд', metric: '90% команд', summary: 'Локальное уточнение', actions: ['Сверить локально'], active: false, allProducts: true, agents: ['Агент А'], participantType: 'agents' });
    expect(catalog.sources[0]).toMatchObject({ kind: 'dashboard', mode: 'stub', url: 'https://example.invalid/board', goalIds: ['GOAL_A'] });
    expect(catalog.sources[1]).toMatchObject({ kind: 'manual', url: null, goalIds: ['GOAL_B'] });
  });

  it('leaves compound and unspecified numeric thresholds unknown', () => {
    const catalog = importGoalMap(html);
    expect(catalog.goals[1].officialTarget).toBeNull();
    expect(catalog.goals[1].metric).toBe('90% описаний · 40% автоматизации');
    expect(catalog.classification).toBe('corporate');
  });

  it('rejects missing, duplicated, malformed and structurally invalid portal data', () => {
    expect(() => importGoalMap('<html></html>')).toThrow(/portal-data/);
    expect(() => importGoalMap(html + html)).toThrow(/один|несколько|единственный/i);
    expect(() => importGoalMap('<script id="portal-data">not JSON</script>')).toThrow(/JSON/);
    expect(() => importGoalMap('<script id="portal-data">{"goals":[],"leaders":{}}</script>')).toThrow(/цел/);
    expect(() => importGoalMap(html.replace('"goalId":"GOAL_A"', '"goalId":"UNKNOWN"'))).toThrow(/UNKNOWN/);
  });

  it('rejects unsafe link schemes while preserving legitimate HTTPS links', () => {
    expect(() => importGoalMap(html.replace('https://example.invalid/board', 'javascript:alert(1)'))).toThrow(/ссылк/i);
  });

  it('does not mistake a data-id attribute for the portal-data script ID', () => {
    expect(() => importGoalMap(html.replace('id="portal-data"', 'data-id="portal-data"'))).toThrow(/portal-data/);
  });
});
