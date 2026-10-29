import type { Clock, UUIDv4 } from '../../domain/workbench/primitives';
import type { WorkbenchRepository } from '../../server/storage/workbench-repository';
import type { CommandRegistry } from '../../server/workbench/command-registry';
import type { AccessPolicyService } from '../identity/workbench-access-policy';
import type { DraftService } from '../catalog/workbench-drafts';
import { createNotificationService, registerNotificationCommands, startNotificationPolling, type NotificationProvider } from './workbench-notifications';

export function createNotificationRuntime(options: {
  repository: WorkbenchRepository; clock: Clock; installationId: UUIDv4; accessPolicy: AccessPolicyService; commands: CommandRegistry;
  provider: NotificationProvider; preferences: (installationId: UUIDv4) => { notificationPersonId: UUIDv4 | null }; drafts?: DraftService;
  pollIntervalMs?: number; maxBackoffMs?: number; onError?: (error: unknown) => void;
}) {
  const service = createNotificationService({ repository: options.repository, provider: options.provider, preferences: options.preferences, resolveOwnAccess: () => options.accessPolicy.resolveOwnAccess() });
  registerNotificationCommands(options.commands, service, { drafts: options.drafts });
  let polling: ReturnType<typeof startNotificationPolling> | null = null;
  let stopped = false;
  return {
    service,
    start() {
      if (polling || stopped) return;
      polling = startNotificationPolling({ service, context: async () => ({ installationId: options.installationId, clock: options.clock, ownAccess: await options.accessPolicy.resolveOwnAccess() }), pollIntervalMs: options.pollIntervalMs, maxBackoffMs: options.maxBackoffMs, onError: options.onError });
    },
    async stop() { stopped = true; polling?.stop(); await polling?.finished; },
  };
}
export type NotificationRuntime = ReturnType<typeof createNotificationRuntime>;
