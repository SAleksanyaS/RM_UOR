import type { BusinessTime, UUIDv4 } from '../primitives';

export const personalDestinations = ['/overview','/data','/knowledge','/goals','/execution','/reports','/uor','/settings','/updates'] as const;
export type PersonalDestination = typeof personalDestinations[number];
/** Object favorites contain identifiers only; names and availability come from authorized reads. */
export type PersonalObjectFavorite = { kind:'goal'|'team'; id:UUIDv4 } | { kind:'report'; id:UUIDv4; revision:number };
export type PersonalFavorite = PersonalDestination | PersonalObjectFavorite;
export const personalFavoriteKey = (favorite:PersonalFavorite):string => typeof favorite === 'string' ? favorite : favorite.kind + ':' + favorite.id + (favorite.kind === 'report' ? ':' + favorite.revision : '');
export type PersonalNavigation = { favorites:PersonalFavorite[]; recent:PersonalDestination[]; startPage:PersonalDestination; showFavorites?:boolean };
export const defaultNavigation = ():PersonalNavigation => ({favorites:[],recent:[],startPage:'/overview'});

/** Local UI choices never carry an access profile or alter shared methodology. */
export type PersonalPreferences = {
  context: { scopePath:{rootKind?:'dit'|'block'|'tribe';ditId:UUIDv4;clusterId:UUIDv4|null;productId:UUIDv4|null;teamId:UUIDv4|null};goalId:UUIDv4|null;time:Exclude<BusinessTime,{kind:'unknown'}>;resultMode:'current'|'agreed';snapshotId:UUIDv4|null } | null;
  sorts: Record<string,Array<{field:string;direction:'asc'|'desc'}>>;
  visual:{theme:'system'|'light'|'dark';density:'comfortable'|'compact';sidebar?:'expanded'|'compact'};
  navigation?:PersonalNavigation;
  rawTableColumns?:Record<string,string[]>;
  notificationPersonId?:UUIDv4|null;
};
