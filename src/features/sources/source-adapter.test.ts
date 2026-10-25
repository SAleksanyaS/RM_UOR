import { describe, expect, it } from 'vitest';
import demoCatalog from '../../../catalog/demo.json';
import demoSnapshots from '../../../catalog/demo-snapshots.json';
import type { LocalSnapshot, SourceDefinition } from '../../domain/contracts';
import { DemoAdapter } from './demo-adapter';
import { UnconfiguredSourceAdapter } from './source-adapter';

const source = demoCatalog.sources[0] as SourceDefinition;
const snapshot = demoSnapshots[0] as LocalSnapshot;
const request = { source, classification: 'demo' as const, period: snapshot.period, requestedAt: '2026-10-24T09:00:00.000Z' };
const signal = () => new AbortController().signal;

async function collect<T>(items: AsyncIterable<T>) { const result: T[] = []; for await (const item of items) result.push(item); return result; }

describe('honest first-stage source adapters', () => {
  it('marks every demo snapshot as demo and personal without carrying curator approval', async () => {
    const adapter = new DemoAdapter(source, { ...snapshot, status: 'validated', curatorId: 'someone', curatorName: 'Someone', validatedAt: '2026-10-01T00:00:00Z' });
    expect((await adapter.check()).status).toBe('ready');
    const events = await collect(adapter.collect(request, signal()));
    const event = events.find(item => item.type === 'snapshot');
    expect(event?.type).toBe('snapshot');
    if (event?.type === 'snapshot') expect(event.snapshot).toMatchObject({ classification: 'demo', origin: 'demo', status: 'personal', curatorId: null, curatorName: null, validatedAt: null, period: snapshot.period });
    expect(snapshot.collectedAt).toBe('2026-10-01T09:00:00.000Z');
  });

  it('never emits synthetic demo data into a corporate dataset', async () => {
    const events = await collect(new DemoAdapter(source, snapshot).collect({ ...request, classification: 'corporate' }, signal()));
    expect(events.some(event => event.type === 'snapshot')).toBe(false);
    expect(events.find(event => event.type === 'error')).toMatchObject({ code: 'classification_mismatch' });
  });

  it('explicitly reports an unconnected dashboard and demo denial without a snapshot', async () => {
    const dashboard = { ...source, id: 'real-source', kind: 'dashboard' as const, mode: 'stub' as const, accessUrl: 'https://example.invalid/access' };
    const stub = new UnconfiguredSourceAdapter(dashboard);
    expect(await stub.check()).toMatchObject({ status: 'configuration_required' });
    const events = await collect(stub.collect({ ...request, source: dashboard, classification: 'corporate' }, signal()));
    expect(events).toEqual([expect.objectContaining({ type: 'error', code: 'configuration_required' })]);
    const denied = new DemoAdapter(source, snapshot, 'access_denied');
    expect((await denied.check()).message).toMatch(/демонстрац/i);
    expect(await collect(denied.collect(request, signal()))).toEqual([expect.objectContaining({ type: 'error', code: 'access_denied' })]);
  });

  it('honors cancellation before yielding any source data', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(collect(new DemoAdapter(source, snapshot).collect(request, controller.signal))).rejects.toMatchObject({ name: 'AbortError' });
  });
});
