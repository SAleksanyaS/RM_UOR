import { expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createWorkbenchRepository } from '../../../server/storage/workbench-repository';
import { UpdateChannelService, createUpdateNotificationProvider } from './update-channel';
import { createNotificationService, type NotificationProvider } from '../../execution/workbench-notifications';

it.each([
    { action: 'read', business: false },
    { action: 'snooze', business: false },
    { action: 'read', business: true },
    { action: 'snooze', business: true },
] as const)('honors $action after cause preparation, with business provider=$business', async ({ action, business }) => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'task7-notification-commit-'));
    const repository = createWorkbenchRepository({ filename: path.join(root, 'db.sqlite'), artifactRoot: path.join(root, 'files') });
    try {
        const owner = { installationId: '00000000-0000-4000-8000-000000000001', personId: '00000000-0000-4000-8000-000000000002' };
        const now = '2026-11-02T10:00:00.000Z';
        const ownAccess = { personId: owner.personId, role: 'viewer' as const, displayName: null, policyState: 'verified' as const, checkedAt: null };
        const context = { installationId: owner.installationId, clock: { now: () => now }, ownAccess };
        const channel = new UpdateChannelService({ repository, now: () => now, provider: {
            async check() { return { channel: 'code', expectedCommit: 'a'.repeat(40), targetCommit: 'b'.repeat(40), available: true, launcherAvailable: true }; },
        } });
        let release!: () => void, entered!: () => void;
        const suspended = new Promise<void>(resolve => release = resolve);
        const ready = new Promise<void>(resolve => entered = resolve);
        const businessProvider: NotificationProvider | undefined = business ? {
            async current() {
                return {
                    calendar: null, settings: null,
                    causes: ['allowed', 'blocked'].map(kind => ({ provider: 'business', kind,
                        objectRef: { entityType: 'core_goal_definition', id: owner.personId },
                        sourceVersion: kind, recipientPersonIds: [owner.personId], route: '/goals', recurring: false,
                    })),
                    canEmit: cause => cause.kind === 'allowed',
                };
            },
        } : undefined;
        const notifications = createNotificationService({ repository,
            // Match production's dynamic wrapper: the snapshot must carry its commit predicate.
            provider: { async current(c, signal) { return createUpdateNotificationProvider(channel, businessProvider).current(c, signal); } },
            preferences: () => ({ notificationPersonId: null }),
            resolveOwnAccess: async () => { entered(); await suspended; return ownAccess; },
        });
        const pumping = notifications.pump(context);
        await ready; // Causes are prepared, but access revalidation has not returned.
        const notice = channel.list(owner)[0];
        channel.action(owner, { release: notice.release, revision: notice.revision, action });
        release();
        await pumping;
        if (action === 'read') expect(channel.list(owner)[0].readAt).toBe(now);
        else expect(channel.list(owner)[0].snoozedUntil).not.toBeNull();
        expect(notifications.list(context).map(event => event.cause.kind)).toEqual(business ? ['allowed'] : []);
        await notifications.pump(context);
        expect(notifications.list(context).map(event => event.cause.kind)).toEqual(business ? ['allowed'] : []);
    } finally {
        repository.close();
        rmSync(root, { recursive: true, force: true });
    }
});
