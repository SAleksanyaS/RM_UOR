import { afterEach, describe, expect, it } from 'vitest';
import demoCatalog from '../../catalog/demo.json';
import type { CatalogSnapshot } from '../../src/domain/contracts';
import { LocalDatabase } from '../../src/server/storage/database';
import { OperationStore } from '../../src/server/operations/operation-store';
import { planUpdate } from '../../src/features/sources/update-planner';
import { runUpdate } from '../../src/features/sources/update-runner';

const databases: LocalDatabase[] = [];
afterEach(() => databases.splice(0).forEach(db => db.close()));
function store() { const db = new LocalDatabase(':memory:'); databases.push(db); return new OperationStore(db); }
const catalog = demoCatalog as CatalogSnapshot;

describe('selected update orchestration', () => {
  it('finishes published data sync before collecting each deduplicated source and recalculating', async () => {
    const calls: string[] = [];
    const plan = planUpdate({ syncPublished: true, sourceIds: ['demo-values', 'demo-values', 'demo-manual'], recalculate: true }, catalog);
    const op = await runUpdate(plan, { operations: store(), syncPublished: async () => { calls.push('sync'); }, collectSource: async id => { calls.push(id); }, recalculate: async () => { calls.push('calculate'); } });
    expect(calls).toEqual(['sync', 'demo-values', 'demo-manual', 'calculate']);
    expect(op.status).toBe('completed');
    expect(op.events.map(event => event.stage.key)).toContain('recalculate');
  });

  it('does not synchronize published data for a sources-only update', async () => {
    const calls: string[] = [];
    const op = await runUpdate(planUpdate({ syncPublished: false, sourceIds: ['demo-values'], recalculate: false }, catalog), { operations: store(), syncPublished: async () => { calls.push('sync'); }, collectSource: async id => { calls.push(id); }, recalculate: async () => { calls.push('calculate'); } });
    expect(calls).toEqual(['demo-values']);
    expect(op.status).toBe('completed');
  });

  it('stops without collecting or replacing prior facts when published-data synchronization fails', async () => {
    const previous = { source: 'old validated facts' };
    let facts = previous;
    const op = await runUpdate(planUpdate({ syncPublished: true, sourceIds: ['demo-values'], recalculate: true }, catalog), { operations: store(), syncPublished: async () => { throw new Error('network unavailable'); }, collectSource: async () => { facts = { source: 'replacement' }; }, recalculate: async () => { throw new Error('must not run'); } });
    expect(op.status).toBe('failed');
    expect(facts).toBe(previous);
    expect(op.result?.message).toMatch(/общие данные/);
  });

  it('continues independent sources and reports partial while leaving a failed source unchanged', async () => {
    const facts = { 'demo-values': 'old facts', 'demo-manual': 'old manual' };
    let calculated = false;
    const op = await runUpdate(planUpdate({ syncPublished: false, sourceIds: ['demo-values', 'demo-manual'], recalculate: true }, catalog), { operations: store(), syncPublished: async () => {}, collectSource: async id => { if (id === 'demo-values') throw new Error('access denied'); facts['demo-manual'] = 'new manual'; }, recalculate: async () => { calculated = true; } });
    expect(op.status).toBe('partial');
    expect(facts).toEqual({ 'demo-values': 'old facts', 'demo-manual': 'new manual' });
    expect(calculated).toBe(true);
    expect(op.result?.details?.join(' ')).toContain('access denied');
  });

  it('reports failure if every selected source fails', async () => {
    const op = await runUpdate(planUpdate({ syncPublished: false, sourceIds: ['demo-values'], recalculate: true }, catalog), { operations: store(), syncPublished: async () => {}, collectSource: async () => { throw new Error('stub not connected'); }, recalculate: async () => {} });
    expect(op.status).toBe('failed');
  });

  it('persists cancellation and skips subsequent work when the signal is aborted', async () => {
    const controller = new AbortController(); const calls: string[] = [];
    const operations = store();
    const startOperation = await operations.start('update', 'Проверка отмены');
    const op = await runUpdate(planUpdate({ syncPublished: false, sourceIds: ['demo-values', 'demo-manual'], recalculate: true }, catalog), { operations, startOperation, signal: controller.signal, syncPublished: async () => {}, collectSource: async id => { calls.push(id); controller.abort(); }, recalculate: async () => { calls.push('calculate'); } });
    expect(op.id).toBe(startOperation.id);
    expect(op.status).toBe('cancelled');
    expect(calls).toEqual(['demo-values']);
    expect((await operations.get(op.id)).status).toBe('cancelled');
  });

  it('rejects unknown sources and empty work without silently selecting all sources', () => {
    expect(() => planUpdate({ syncPublished: false, sourceIds: ['unknown'], recalculate: true }, catalog)).toThrow(/unknown/);
    expect(() => planUpdate({ syncPublished: false, sourceIds: [], recalculate: false }, catalog)).toThrow(/выберите/i);
  });
});
