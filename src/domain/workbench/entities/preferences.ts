import type { BusinessTime, UUIDv4 } from '../primitives';

/** Local UI choices never carry an access profile or alter shared methodology. */
export type PersonalPreferences = {
  context: { scopePath:{ditId:UUIDv4;clusterId:UUIDv4|null;productId:UUIDv4|null;teamId:UUIDv4|null};goalId:UUIDv4|null;time:Exclude<BusinessTime,{kind:'unknown'}>;resultMode:'current'|'agreed';snapshotId:UUIDv4|null } | null;
  sorts: Record<string,Array<{field:string;direction:'asc'|'desc'}>>;
  visual:{theme:'system'|'light'|'dark';density:'comfortable'|'compact'};
  notificationPersonId?:UUIDv4|null;
};
