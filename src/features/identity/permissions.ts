import type { Session } from '../../domain/contracts';
export type WorkspaceRole=Session['role'];
const readerPages=new Set(['overview','director','weekly','reports','plans','execution','leaders','directions','matrix','knowledge','evidence','changes','guide','system']);
const curatorPages=new Set([...readerPages,'setup','catalog','sources','connectors','inbox','release']);
/** One policy for navigation and page guards. Server authorization is enforced separately for every API request. */
export function canManageWorkspace(role:WorkspaceRole):boolean{return role==='curator';}
export function canViewWorkspacePage(role:WorkspaceRole,page:string):boolean{return (canManageWorkspace(role)?curatorPages:readerPages).has(page);}
export type Capability='view'|'refresh'|'reports'|'personal_preferences'|'update_program'|'manage_goals'|'manage_sources'|'manage_knowledge'|'confirm_results'|'publish'|'manage_backups';
const readerCapabilities:Capability[]=['view','refresh','reports','personal_preferences','update_program'];
const curatorCapabilities:Capability[]=[...readerCapabilities,'manage_goals','manage_sources','manage_knowledge','confirm_results','publish','manage_backups'];
export function capabilitiesForRole(role:WorkspaceRole):Capability[]{return [...(canManageWorkspace(role)?curatorCapabilities:readerCapabilities)];}
export function hasCapability(role:WorkspaceRole,capability:Capability):boolean{return capabilitiesForRole(role).includes(capability);}
/** Reader actions are deliberately enumerated. New mutation endpoints default to curator access. */
export function requiresCuratorForApi(method:string,route:string):boolean{
 const path=route.split('?')[0];if(!path.startsWith('/api/'))return false;
 if(['GET','HEAD','OPTIONS'].includes(method.toUpperCase()))return path==='/api/system'||path==='/api/connectors'||path.startsWith('/api/connectors/')||/^\/api\/report-templates\/[^/]+\/original$/.test(path);
 if(method.toUpperCase()!=='POST')return true;
 if(['/api/login','/api/update','/api/updates/check','/api/reports','/api/system/code-update','/api/system/preferences','/api/connectors/login/finish'].includes(path))return false;
 if(/^\/api\/operations\/[^/]+\/cancel$/.test(path)||/^\/api\/connectors\/[^/]+\/login$/.test(path))return false;
 return true;
}
