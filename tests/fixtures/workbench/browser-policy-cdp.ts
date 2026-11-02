import { EventEmitter } from 'node:events';
import type { CDPSession } from 'playwright';

/** Contract fixture for non-browser unit tests. Real worker enforcement is
 * covered separately by native browser/production-loader regression tests. */
export function browserPolicyCdpFixture(): CDPSession {
  const events = new EventEmitter();
  return Object.assign(events, {
    async send(method: string) {
      if (method === 'ServiceWorker.enable') {
        // Native enable returns before BOTH snapshots, even when they are empty.
        setImmediate(() => { events.emit('ServiceWorker.workerRegistrationUpdated', { registrations: [] }); events.emit('ServiceWorker.workerVersionUpdated', { versions: [] }); });
        return {};
      }
      if (method === 'Target.getTargetInfo') return { targetInfo: { targetId: 'unit-page', type: 'page', browserContextId: 'unit-owned-context' } };
      if (method === 'Target.getTargets') return { targetInfos: [] };
      if (['Network.enable', 'Network.setBypassServiceWorker', 'Fetch.enable', 'Browser.setDownloadBehavior', 'Browser.cancelDownload', 'ServiceWorker.stopAllWorkers', 'Target.setDiscoverTargets'].includes(method)) return {};
      throw Error(`Unexpected policy fixture CDP method: ${method}`);
    },
    async detach() { events.removeAllListeners(); },
  }) as unknown as CDPSession;
}

export function browserPolicyPageFixture<T extends object>(page: T) {
  return Object.assign(new EventEmitter(), { isClosed: () => false }, page);
}
