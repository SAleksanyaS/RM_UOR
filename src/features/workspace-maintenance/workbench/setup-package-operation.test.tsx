// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { useSetupOperation } from './setup-package-operation';
const fixture = vi.hoisted(() => ({ context: null as any }));
vi.mock('../../../app/workbench/context', () => ({ useWorkbench: () => fixture.context }));
afterEach(() => { cleanup(); sessionStorage.clear(); });
function make() { const requests: any[] = []; const client = { async command(input: any) { requests.push(structuredClone(input)); throw Error('Lost response'); }, async reconcileCommand() { return { data: { name: null, status: 'not_found', job: null, result: null } }; }, async query() { return { data: {} }; } }; fixture.context = { client, session: { personId: '00000000-0000-4000-8000-000000000001' } }; return { client, requests }; }
it('retains exact request through unknown and not_found then retries only after an explicit action', async () => {
    const f = make(), view = renderHook(() => useSetupOperation('test', async () => { }));
    await act(() => view.result.current.run('setup.apply', { package: { immutable: 'bytes' }, previewDigest: 'digest' }));
    expect(f.requests).toHaveLength(1);
    const original = f.requests[0];
    await act(() => view.result.current.recover());
    expect(view.result.current.operation?.status).toBe('not_found');
    expect(f.requests).toHaveLength(1);
    await act(() => view.result.current.recover(true));
    expect(f.requests).toHaveLength(2);
    expect(f.requests[1]).toEqual(original);
});
it('drops late completion from an unmounted owner and keeps a different client isolated', async () => {
    const f = make();
    let finish!: (value: any) => void;
    f.client.command = async (input: any) => { f.requests.push(input); return new Promise(resolve => finish = resolve); };
    const first = renderHook(() => useSetupOperation('test', async () => { }));
    let result: Promise<any>;
    act(() => { result = first.result.current.run('updates.check', {}); });
    first.unmount();
    const secondFixture = make();
    const second = renderHook(() => useSetupOperation('test', async () => { }));
    await act(async () => { finish({ data: { result: { oldOwner: true } } }); expect(await result!).toBeNull(); });
    expect(second.result.current.operation).toBeNull();
    expect(secondFixture.requests).toEqual([]);
});
it('reads back an interrupted operation before releasing the recovery lock', async () => {
    const f = make();
    f.client.reconcileCommand = async () => ({ data: { name: null, status: 'interrupted', job: null, result: null } } as any);
    let read = 0;
    const view = renderHook(() => useSetupOperation('test', async () => { read++; }));
    await act(() => view.result.current.run('setup.apply', { value: 1 }));
    await act(() => view.result.current.recover());
    expect(read).toBe(1);
    expect(view.result.current.operation).toBeNull();
    expect(view.result.current.error).toContain('прервана');
});
