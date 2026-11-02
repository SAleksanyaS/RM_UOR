import { createHash } from 'node:crypto';
import { z } from 'zod';
import { utcInstantSchema, uuidSchema } from '../../../domain/workbench/primitives';
import type { WorkbenchRepository } from '../../../server/storage/workbench-repository';
import type { CommandRegistry } from '../../../server/workbench/command-registry';
import type { QueryRegistry } from '../../../server/workbench/query-registry';
import { commitCommandEffect } from '../../../server/workbench/command-store';
import { WorkbenchHttpError, ownQueryRequestSchema } from '../../../server/workbench/protocol';
import type { NotificationProvider, NotificationContext } from '../../execution/workbench-notifications';
import type { NotificationCauseSource } from '../../execution/workbench-notification-causes';
import type { NotificationCause } from '../../execution/workbench-reminders';
import { createNotificationStore } from '../../execution/workbench-notification-store';
import { subjectTableOwner } from '../../workspace-maintenance/workbench/subject-archive-owners';
import type { ProductionArchiveOwner, ProductionArchiveEnvironment } from '../../workspace-maintenance/workbench/production-archive-contracts';
import type { UpdateProvider } from './update-provider';
const oid = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const ownerSchema = z.strictObject({ installationId: uuidSchema, personId: uuidSchema.nullable() });
export type UpdateOwner = z.infer<typeof ownerSchema>;
export const updateCandidateSchema = z.strictObject({ channel: z.literal('code'), expectedCommit: oid, targetCommit: oid, available: z.boolean(), launcherAvailable: z.boolean() });
export const updateNoticeSchema = z.strictObject({ schemaVersion: z.literal(1), owner: ownerSchema, channel: z.literal('code'), release: oid, candidate: updateCandidateSchema, revision: z.number().int().positive(), state: z.enum(['available', 'applying', 'applied', 'error']), readAt: utcInstantSchema.nullable(), snoozedUntil: utcInstantSchema.nullable(), createdAt: utcInstantSchema, updatedAt: utcInstantSchema, error: z.string().nullable() });
export type UpdateNotice = z.infer<typeof updateNoticeSchema>;
const statusSchema = z.strictObject({ owner: ownerSchema, checkedAt: utcInstantSchema.nullable(), nextCheckAt: utcInstantSchema.nullable(), failures: z.number().int().nonnegative(), error: z.string().nullable() });
const actionSchema = z.strictObject({ release: oid, revision: z.number().int().positive(), action: z.enum(['read', 'snooze', 'unsnooze']) });
const ownerKey = (o: UpdateOwner) => JSON.stringify([o.installationId, o.personId]);
const contextOwner = (c: NotificationContext) => ({ installationId: c.installationId, personId: c.ownAccess.personId });
const noticeId = (release: string) => { const h = createHash('sha256').update('code/' + release).digest('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`; };
export function initializeUpdateStore(repository: WorkbenchRepository) { repository.sqlForModule('updates').execMigration('v1', 'CREATE TABLE wb_updates_notices(owner_key TEXT NOT NULL,release_oid TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(owner_key,release_oid)); CREATE TABLE wb_updates_status(owner_key TEXT PRIMARY KEY,payload TEXT NOT NULL)'); }
export class UpdateChannelService {
    private inFlight = new Map<string, Promise<void>>();
    private now: () => string;
    private random: () => number;
    constructor(readonly options: {
        repository: WorkbenchRepository;
        provider: UpdateProvider;
        now?: () => string;
        random?: () => number;
        pollIntervalMs?: number;
        maxBackoffMs?: number;
        jitterRatio?: number;
    }) { if (![options.pollIntervalMs??60000,options.maxBackoffMs??3600000,options.jitterRatio??0.2].every(Number.isFinite)||!Number.isInteger(options.pollIntervalMs??60000)||!Number.isInteger(options.maxBackoffMs??3600000))throw Error('Invalid update polling bounds'); if ((options.pollIntervalMs ?? 60000) < 1000 || (options.pollIntervalMs ?? 60000) > 3600000 || (options.maxBackoffMs ?? 3600000) < (options.pollIntervalMs ?? 60000) || (options.maxBackoffMs ?? 3600000) > 86400000 || (options.jitterRatio ?? 0.2) < 0 || (options.jitterRatio ?? 0.2) > 0.5)
        throw Error('Invalid update polling bounds'); this.now = options.now ?? (() => new Date().toISOString()); this.random = options.random ?? Math.random; initializeUpdateStore(options.repository); }
    list(owner: UpdateOwner): UpdateNotice[] { ownerSchema.parse(owner); return this.options.repository.sqlForModule('updates').all<{
        payload: string;
    }>('SELECT payload FROM wb_updates_notices WHERE owner_key=? ORDER BY release_oid', [ownerKey(owner)]).map(r => updateNoticeSchema.parse(JSON.parse(r.payload))); }
    status(owner: UpdateOwner): z.infer<typeof statusSchema> { ownerSchema.parse(owner); const row = this.options.repository.sqlForModule('updates').get<{
        payload: string;
    }>('SELECT payload FROM wb_updates_status WHERE owner_key=?', [ownerKey(owner)]); return row ? statusSchema.parse(JSON.parse(row.payload)) : { owner, checkedAt: null, nextCheckAt: null, failures: 0, error: null }; }
    async poll(owner: UpdateOwner, _reason: 'startup' | 'resume' | 'online' | 'periodic' | 'manual' = 'periodic', force = false, signal?: AbortSignal): Promise<void> {
        ownerSchema.parse(owner);
        // Admission loss must not create installation-owned personal history.
        if (owner.personId === null) return;
        const key = ownerKey(owner), pending = this.inFlight.get(key);
        if (pending)
            return pending;
        if (signal?.aborted)
            return;
        const before = this.status(owner);
        if (!force && before.nextCheckAt && Date.parse(before.nextCheckAt) > Date.parse(this.now()))
            return;
        const action = (async () => {
            try {
                const candidate = updateCandidateSchema.parse(await this.options.provider.check(signal));
                if (signal?.aborted)
                    return;
                const now = this.now();
                this.options.repository.transaction(() => {
                    for (const existing of this.list(owner))
                        if (existing.release === candidate.expectedCommit && existing.state !== 'applied')
                            this.write({ ...existing, state: 'applied', error: null, snoozedUntil: null, revision: existing.revision + 1, updatedAt: now });
                    if (candidate.available) {
                        const old = this.list(owner).find(v => v.release === candidate.targetCommit);
                        if (!old)
                            this.write({ schemaVersion: 1, owner, channel: 'code', release: candidate.targetCommit, candidate, revision: 1, state: 'available', readAt: null, snoozedUntil: null, createdAt: now, updatedAt: now, error: null });
                        else if (JSON.stringify(old.candidate) !== JSON.stringify(candidate) || old.state === 'error')
                            this.write({ ...old, candidate, state: old.state === 'error' ? 'available' : old.state, error: null, revision: old.revision + 1, updatedAt: now });
                    }
                    this.writeStatus({ owner, checkedAt: now, nextCheckAt: new Date(Date.parse(now) + this.delay(0)).toISOString(), failures: 0, error: null });
                });
            }
            catch (error) {
                if (signal?.aborted)
                    return;
                const now = this.now(), failures = before.failures + 1;
                this.writeStatus({ owner, checkedAt: now, nextCheckAt: new Date(Date.parse(now) + this.delay(failures)).toISOString(), failures, error: typeof (error as any)?.code === 'string' ? (error as any).code : 'UPDATE_CHECK_UNAVAILABLE' });
            }
        })();
        this.inFlight.set(key, action);
        try {
            await action;
        }
        finally {
            this.inFlight.delete(key);
        }
    }
    private delay(failures: number) { return Math.min(this.options.maxBackoffMs??3600000,Math.round(Math.min(this.options.maxBackoffMs ?? 3600000, (this.options.pollIntervalMs ?? 60000) * 2 ** Math.min(failures, 16)) * (1 - (this.options.jitterRatio ?? 0.2) + Math.min(1, Math.max(0, this.random())) * 2 * (this.options.jitterRatio ?? 0.2)))); }
    action(owner: UpdateOwner, input: z.infer<typeof actionSchema>): UpdateNotice { input = actionSchema.parse(input); return this.options.repository.transaction(() => { const old = this.list(owner).find(v => v.release === input.release); if (!old)
        throw new WorkbenchHttpError(404, 'UPDATE_NOT_FOUND', 'Update is unavailable for this owner'); if (old.revision !== input.revision)
        throw new WorkbenchHttpError(409, 'PREVIEW_STALE', 'Refresh update state'); const now = this.now(); const next = { ...old, revision: old.revision + 1, updatedAt: now, ...(input.action === 'read' ? { readAt: now } : { snoozedUntil: input.action === 'snooze' ? new Date(Date.parse(now) + 24 * 60 * 60000).toISOString() : null }) }; this.write(next); if (input.action === 'read') {
        const notifications = createNotificationStore({ repository: this.options.repository }), personal = { installationId: owner.installationId, profilePersonId: owner.personId };
        const ids = notifications.list(personal).filter(n => n.cause.provider === 'updates' && n.cause.sourceVersion === 'code/' + input.release).map(n => n.id);
        notifications.markRead(personal, ids, now);
    } return next; }); }
    async activationInput(owner: UpdateOwner, release: string, policyState: string) { if (policyState === 'local_preview' || !['verified', 'offline_cached'].includes(policyState))
        throw new WorkbenchHttpError(403, 'ACCESS_DENIED', 'Проверенный допуск нужен для применения main'); const notice = this.list(owner).find(v => v.release === release); if (!notice)
        throw new WorkbenchHttpError(404, 'UPDATE_NOT_FOUND', 'Update is unavailable'); const current = await this.options.provider.check(); if (current.targetCommit !== release || current.expectedCommit !== notice.candidate.expectedCommit)
        throw new WorkbenchHttpError(409, 'PREVIEW_STALE', 'Принятая ветка изменилась. Повторите проверку'); return { expectedCommit: current.expectedCommit, targetCommit: current.targetCommit }; }
    recordOutcome(owner: UpdateOwner, release: string, outcome: 'applying' | 'applied' | 'error', error: string | null = null) { const old = this.list(owner).find(v => v.release === release); if (old)
        this.write({ ...old, state: outcome, error, revision: old.revision + 1, updatedAt: this.now(), ...(outcome === 'applied' ? { snoozedUntil: null } : {}) }); }
    /** Re-read durable eligibility in the notification transaction, never from the prepared snapshot. */
    canEmit(context: NotificationContext, cause: NotificationCause): boolean {
        const owner = contextOwner(context);
        if (owner.personId === null || cause.provider !== 'updates' || cause.kind !== 'code_update_available'
            || cause.localOwner?.installationId !== owner.installationId || cause.localOwner.personId !== owner.personId)
            return false;
        const notice = this.list(owner).find(n => cause.sourceVersion === 'code/' + n.release
            && cause.objectRef.entityType === 'code_update' && cause.objectRef.id === noticeId(n.release));
        return !!notice && this.notifiable(notice);
    }
    private notifiable(notice: UpdateNotice): boolean {
        return notice.readAt === null && notice.state === 'available'
            && (!notice.snoozedUntil || notice.snoozedUntil <= this.now());
    }
    async causes(context: NotificationContext, signal?: AbortSignal): Promise<NotificationCause[]> { const owner = contextOwner(context); await this.poll(owner, 'periodic', false, signal); if (signal?.aborted || owner.personId === null)
        return []; return this.list(owner).filter(n => this.notifiable(n)).map(n => ({ provider: 'updates', objectRef: { entityType: 'code_update', id: noticeId(n.release) }, sourceVersion: 'code/' + n.release, kind: 'code_update_available', recipientPersonIds: owner.personId ? [owner.personId] : [], localOwner: owner, route: '/updates', recurring: false })); }
    private write(n: UpdateNotice) { updateNoticeSchema.parse(n); this.options.repository.sqlForModule('updates').run('INSERT OR REPLACE INTO wb_updates_notices(owner_key,release_oid,payload) VALUES(?,?,?)', [ownerKey(n.owner), n.release, JSON.stringify(n)]); }
    private writeStatus(s: z.infer<typeof statusSchema>) { statusSchema.parse(s); this.options.repository.sqlForModule('updates').run('INSERT OR REPLACE INTO wb_updates_status(owner_key,payload) VALUES(?,?)', [ownerKey(s.owner), JSON.stringify(s)]); }
}
export function createUpdateNotificationSource(service: UpdateChannelService): NotificationCauseSource { return { id: 'updates', current: (c, s) => service.causes(c, s) }; }
/** With no business reminder configuration, only explicit non-recurring update events are emitted. */
export function createUpdateNotificationProvider(service: UpdateChannelService, business?: NotificationProvider): NotificationProvider {
    return {
        async current(context, signal) {
            const updates = await service.causes(context, signal);
            const snapshot = business ? await business.current(context, signal) : { causes: [], calendar: null, settings: null };
            return {
                ...snapshot,
                causes: [...snapshot.causes, ...updates],
                canEmit: cause => cause.provider === 'updates'
                    ? service.canEmit(context, cause)
                    : snapshot.canEmit ? snapshot.canEmit(cause) : true,
            };
        },
    };
}
export function registerUpdateChannelFeature({ service, commands, queries }: {
    service: UpdateChannelService;
    commands: CommandRegistry;
    queries: QueryRegistry;
}) {
    queries.register({ name: 'updates.list', inputSchema: ownQueryRequestSchema, outputSchema: z.strictObject({ notices: z.array(updateNoticeSchema), status: statusSchema }), async handler(c) { const owner = contextOwner(c); return { notices: service.list(owner), status: service.status(owner) }; } });
    commands.register({ name: 'updates.check', inputSchema: z.strictObject({ reason: z.enum(['startup', 'resume', 'online', 'periodic', 'manual']).default('manual') }), outputSchema: statusSchema, capability: 'personal.write', ownership: 'person-if-present', effect: 'local', execution: 'sync', async handler(c, input) { const owner = contextOwner(c); await service.poll(owner, input.reason, true); return commitCommandEffect(c, () => ({ result: service.status(owner), changedRefs: [], editToken: null })); } });
    commands.register({ name: 'updates.action', inputSchema: actionSchema, outputSchema: updateNoticeSchema, capability: 'personal.write', ownership: 'person-if-present', effect: 'local', execution: 'sync', async handler(c, input) { return commitCommandEffect(c, () => ({ result: service.action(contextOwner(c), input), changedRefs: [], editToken: null })); } });
}
export function createUpdateArchiveOwner(repository: WorkbenchRepository, env: ProductionArchiveEnvironment): ProductionArchiveOwner {
    initializeUpdateStore(repository);
    const portableOwner=z.strictObject({personId:uuidSchema.nullable(),installationId:uuidSchema.optional()}).refine(v=>v.personId!==null?v.installationId===undefined:!!v.installationId);
    const noticeArchive=updateNoticeSchema.omit({owner:true}).extend({owner:portableOwner});
    const statusArchive=statusSchema.omit({owner:true}).extend({owner:portableOwner});
    const decode=(row:{payload:string})=>{const v=JSON.parse(row.payload);return{...v,owner:v.owner.personId?{personId:v.owner.personId}:{personId:null,installationId:v.owner.installationId}};};
    const key=(v:any)=>JSON.stringify([v.owner,v.release??'status']);
    const materialize=(v:any,c:any)=>({...v,owner:{installationId:c?.installationId??env.installationId,personId:v.owner.personId}});
    return subjectTableOwner('updates',{
      'updates.notice':{schema:noticeArchive,key,read:r=>r.sqlForModule('updates').all<{payload:string}>('SELECT payload FROM wb_updates_notices ORDER BY owner_key,release_oid').map(decode),write:(r,v,c)=>{const value=materialize(v,c);r.sqlForModule('updates').run('INSERT INTO wb_updates_notices(owner_key,release_oid,payload) VALUES(?,?,?)',[ownerKey(value.owner),value.release,JSON.stringify(value)]);}},
      'updates.status':{schema:statusArchive,key,read:r=>r.sqlForModule('updates').all<{payload:string}>('SELECT payload FROM wb_updates_status ORDER BY owner_key').map(decode),write:(r,v,c)=>{const value=materialize(v,c);r.sqlForModule('updates').run('INSERT INTO wb_updates_status(owner_key,payload) VALUES(?,?)',[ownerKey(value.owner),JSON.stringify(value)]);}},
    },env,(records,p,i)=>{for(const record of records){const o=portableOwner.parse((record.value as any).owner);if(o.personId===null?o.installationId!==i:o.personId!==p)throw new WorkbenchHttpError(403,'ACCESS_DENIED','Update history belongs to another owner');}});
}
