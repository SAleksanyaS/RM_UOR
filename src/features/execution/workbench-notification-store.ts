import { newUuid, utcInstantSchema, uuidSchema, type UtcInstant, type UUIDv4 } from '../../domain/workbench/primitives';
import type { PersonalOwner } from '../../domain/workbench/entities';
import type { WorkbenchRepository } from '../../server/storage/workbench-repository';
import { WorkbenchHttpError, type Sort } from '../../server/workbench/protocol';
import type { NotificationCause } from './workbench-reminders';

export type LocalNotification = { id: UUIDv4; cause: NotificationCause; category: 'new' | 'reminder' | 'error'; createdAt: UtcInstant; emittedAt: UtcInstant; readAt: UtcInstant | null };
type EventRow = { id: string; payload: string; read_at: string | null };
const ownerKey = (owner: PersonalOwner): string => JSON.stringify([uuidSchema.parse(owner.installationId), owner.profilePersonId === null ? null : uuidSchema.parse(owner.profilePersonId)]);
const decode = (row: EventRow): LocalNotification => ({ ...JSON.parse(row.payload), readAt: row.read_at });

/** Personal technical tables on K01's connection; no shared entity or cause is modified. */
export function createNotificationStore(options: { repository: WorkbenchRepository }) {
  const { repository } = options;
  const sql = repository.sqlForModule('notifications');
  sql.execMigration('001', `
    CREATE TABLE wb_notifications_events (owner_key TEXT NOT NULL,id TEXT NOT NULL,dedup_key TEXT NOT NULL,payload TEXT NOT NULL,read_at TEXT,emitted_at TEXT NOT NULL,PRIMARY KEY(owner_key,id),UNIQUE(owner_key,dedup_key));
    CREATE INDEX wb_notifications_events_owner ON wb_notifications_events(owner_key,emitted_at);
    CREATE TABLE wb_notifications_subscriptions (owner_key TEXT NOT NULL,goal_id TEXT NOT NULL,enabled INTEGER NOT NULL,PRIMARY KEY(owner_key,goal_id));
    CREATE TABLE wb_notifications_occurrences (id TEXT PRIMARY KEY,event_id TEXT NOT NULL,owner_key TEXT NOT NULL,emitted_at TEXT NOT NULL,category TEXT NOT NULL);
  `);
  return {
    find(owner: PersonalOwner, dedupKey: string): LocalNotification | null {
      const row = sql.get<EventRow>('SELECT id,payload,read_at FROM wb_notifications_events WHERE owner_key=? AND dedup_key=?', [ownerKey(owner), dedupKey]);
      return row ? decode(row) : null;
    },
    list(owner: PersonalOwner): LocalNotification[] {
      return sql.all<EventRow>('SELECT id,payload,read_at FROM wb_notifications_events WHERE owner_key=? ORDER BY emitted_at DESC,id LIMIT 200', [ownerKey(owner)]).map(decode);
    },
    readPage(owner:PersonalOwner,input:{unreadOnly:boolean;offset:number;limit:number;sort?:Sort[]}):LocalNotification[] {
      if(!Number.isSafeInteger(input.offset) || input.offset<0 || !Number.isInteger(input.limit) || input.limit<1 || input.limit>201) throw new WorkbenchHttpError(422,'VALIDATION_FAILED','Invalid page');
      const columns:Record<string,string>={emittedAt:'emitted_at',category:"json_extract(payload,'$.category')",readAt:'read_at'};
      const sorts=input.sort?.length?input.sort:[{field:'emittedAt',direction:'desc' as const}];
      if(sorts.some(s=>!Object.hasOwn(columns,s.field)||!['asc','desc'].includes(s.direction))) throw new WorkbenchHttpError(422,'VALIDATION_FAILED','Invalid sort');
      const order=sorts.map(s=>columns[s.field]+' '+s.direction.toUpperCase()).join(',');
      return sql.all<EventRow>('SELECT id,payload,read_at FROM wb_notifications_events WHERE owner_key=?'+(input.unreadOnly?' AND read_at IS NULL':'')+' ORDER BY '+order+',id LIMIT ? OFFSET ?',[ownerKey(owner),input.limit,input.offset]).map(decode);
    },
    record(owner: PersonalOwner, dedupKey: string, cause: NotificationCause, category: LocalNotification['category'], now: UtcInstant): void {
      utcInstantSchema.parse(now);
      repository.transaction(() => {
        const key = ownerKey(owner);
        const previous = sql.get<EventRow>('SELECT id,payload,read_at FROM wb_notifications_events WHERE owner_key=? AND dedup_key=?', [key, dedupKey]);
        const old = previous ? decode(previous) : null;
        const event: LocalNotification = { id: old?.id ?? newUuid(), cause, category, createdAt: old?.createdAt ?? now, emittedAt: now, readAt: null };
        if (previous) sql.run('UPDATE wb_notifications_events SET payload=?,read_at=NULL,emitted_at=? WHERE owner_key=? AND id=?', [JSON.stringify(event), now, key, event.id]);
        else sql.run('INSERT INTO wb_notifications_events(owner_key,id,dedup_key,payload,read_at,emitted_at) VALUES(?,?,?,?,NULL,?)', [key, event.id, dedupKey, JSON.stringify(event), now]);
        sql.run('INSERT INTO wb_notifications_occurrences(id,event_id,owner_key,emitted_at,category) VALUES(?,?,?,?,?)', [newUuid(), event.id, key, now, category]);
      });
    },
    markRead(owner: PersonalOwner, ids: UUIDv4[], now: UtcInstant): void {
      const key = ownerKey(owner); utcInstantSchema.parse(now);
      repository.transaction(() => {
        for (const id of ids) if (!sql.get('SELECT id FROM wb_notifications_events WHERE owner_key=? AND id=?', [key, uuidSchema.parse(id)])) throw new WorkbenchHttpError(403, 'ACCESS_DENIED', 'Notification does not belong to this local owner');
        for (const id of new Set(ids)) sql.run('UPDATE wb_notifications_events SET read_at=? WHERE owner_key=? AND id=? AND read_at IS NULL', [now, key, id]);
      });
    },
    subscribe(owner: PersonalOwner, goalId: UUIDv4, enabled: boolean): void {
      const key = ownerKey(owner); uuidSchema.parse(goalId);
      repository.transaction(() => {
        sql.run('INSERT OR IGNORE INTO wb_notifications_subscriptions(owner_key,goal_id,enabled) VALUES(?,?,?)', [key, goalId, Number(enabled)]);
        sql.run('UPDATE wb_notifications_subscriptions SET enabled=? WHERE owner_key=? AND goal_id=? AND enabled<>?', [Number(enabled), key, goalId, Number(enabled)]);
      });
    },
    isSubscribed(owner: PersonalOwner, goalId: UUIDv4): boolean {
      return sql.get<{ enabled: number }>('SELECT enabled FROM wb_notifications_subscriptions WHERE owner_key=? AND goal_id=?', [ownerKey(owner), uuidSchema.parse(goalId)])?.enabled === 1;
    },
  };
}
