import { businessTimeSchema, uuidSchema } from '../../domain/workbench/primitives';
import { globalContextSchema, type GlobalContext } from '../../server/workbench/protocol';

export type WorkbenchRouteState = { pathname: string; context: GlobalContext | null; warnings: string[] };
export type ContextPatch = Omit<Partial<GlobalContext>, 'scopePath'> & { scopePath?: Partial<GlobalContext['scopePath']> };
function goalIdFromPath(pathname: string): string | null {
  const match = new URL(pathname, 'http://localhost').pathname.match(/^\/goals\/([^/]+)$/);
  const goal = uuidSchema.safeParse(match?.[1]);
  return goal.success ? goal.data : null;
}
export function goalContextForPath(pathname: string, context: GlobalContext | null): GlobalContext | null {
  const goalId = goalIdFromPath(pathname);
  return context && goalId ? { ...context, goalId } : context;
}
export function businessTimeFromRange(range: { at: string } | { from: string; to: string }): GlobalContext['time'] {
  const value = 'at' in range ? { kind: 'as_of', date: range.at } : { kind: 'period', startInclusive: range.from, endExclusive: range.to };
  const parsed = businessTimeSchema.parse(value);
  if (parsed.kind === 'unknown') throw Error('A navigation time is required');
  return parsed;
}
/** Parent selection invalidates descendant selections, including a previously selected snapshot. */
export function updateGlobalContext(current: GlobalContext, patch: ContextPatch): GlobalContext {
  const scopePath = { ...current.scopePath, ...patch.scopePath };
  if (patch.scopePath?.ditId !== undefined && patch.scopePath.ditId !== current.scopePath.ditId) { scopePath.clusterId = null; scopePath.productId = null; scopePath.teamId = null; }
  else if (patch.scopePath?.clusterId !== undefined && patch.scopePath.clusterId !== current.scopePath.clusterId) { scopePath.productId = null; scopePath.teamId = null; }
  else if (patch.scopePath?.productId !== undefined && patch.scopePath.productId !== current.scopePath.productId) scopePath.teamId = null;
  if (!scopePath.clusterId) { scopePath.productId = null; scopePath.teamId = null; }
  if (!scopePath.productId && (!scopePath.rootKind || scopePath.rootKind === 'dit')) scopePath.teamId = null;
  const changedSelection = JSON.stringify(scopePath) !== JSON.stringify(current.scopePath) || patch.goalId !== undefined && patch.goalId !== current.goalId || patch.time !== undefined && JSON.stringify(patch.time) !== JSON.stringify(current.time);
  const next = { ...current, ...patch, scopePath };
  if (next.resultMode === 'current' || changedSelection && patch.snapshotId === undefined) next.snapshotId = null;
  return globalContextSchema.parse(next);
}
export function readRouteState(input: string | URL, defaultContext: GlobalContext | null): WorkbenchRouteState {
  const url = new URL(String(input), 'http://localhost');
  const params = url.searchParams, warnings: string[] = [];
  const id = (key: string, fallback: string | null) => {
    if (!params.has(key)) return fallback;
    const parsed = uuidSchema.safeParse(params.get(key));
    if (!parsed.success) { warnings.push('Некорректный параметр: ' + key); return null; }
    return parsed.data;
  };
  // No catalog means no invented DIT or date, even if an untrusted URL suggests one.
  if (!defaultContext) return { pathname: url.pathname, context: null, warnings };
  const rootText=params.get('rootKind');
  const rootKind = rootText && ['dit','block','tribe'].includes(rootText) ? rootText as 'dit'|'block'|'tribe' : params.has('dit') ? undefined : defaultContext.scopePath.rootKind;
  if(rootText&&!['dit','block','tribe'].includes(rootText))warnings.push('Некорректный тип корневой области');
  const ditId = id('dit', defaultContext.scopePath.ditId) ?? defaultContext.scopePath.ditId;
  const ditChanged = ditId !== defaultContext.scopePath.ditId;
  const explicitScope = params.has('dit');
  const clusterId = id('cluster', explicitScope || ditChanged ? null : defaultContext.scopePath.clusterId);
  const clusterChanged = ditChanged || clusterId !== defaultContext.scopePath.clusterId;
  const productId = clusterId ? id('product', explicitScope || clusterChanged ? null : defaultContext.scopePath.productId) : null;
  const productChanged = clusterChanged || productId !== defaultContext.scopePath.productId;
  const teamId = productId || clusterId && rootKind && rootKind !== 'dit' ? id('team', explicitScope || productChanged ? null : defaultContext.scopePath.teamId) : null;
  let time = defaultContext.time;
  try {
    if (params.has('at') && (params.has('from') || params.has('to'))) throw Error('Ambiguous time');
    if (params.has('at')) time = businessTimeFromRange({ at: params.get('at')! });
    else if (params.has('from') || params.has('to')) time = businessTimeFromRange({ from: params.get('from') ?? '', to: params.get('to') ?? '' });
  } catch { warnings.push('Некорректный период'); }
  const mode = params.get('mode');
  if (mode && !['current', 'agreed'].includes(mode)) warnings.push('Некорректный вид результата');
  const resultMode = mode === 'agreed' ? 'agreed' : mode === 'current' ? 'current' : defaultContext.resultMode;
  const goalId = goalIdFromPath(url.pathname) ?? id('goal', explicitScope ? null : defaultContext.goalId);
  const selectionChanged = ditChanged || clusterChanged || productChanged || teamId !== defaultContext.scopePath.teamId || goalId !== defaultContext.goalId || JSON.stringify(time) !== JSON.stringify(defaultContext.time);
  const snapshotId = resultMode === 'current' ? null : id('snapshot', explicitScope || selectionChanged ? null : defaultContext.snapshotId);
  return { pathname: url.pathname, context: globalContextSchema.parse({ scopePath: { ...(rootKind?{rootKind}:{}), ditId, clusterId, productId, teamId }, goalId, time, resultMode, snapshotId }), warnings };
}
/** Only the canonical execution types/one UUID selector can select a read-only card. */
export function executionTargetFromUrl(input:string|URL):{entityType:'work'|'decision';id:string}|null {
  const url=new URL(String(input),'http://localhost');
  if(url.pathname!=='/execution'||url.searchParams.getAll('ref').length!==1)return null;
  const parts=url.searchParams.get('ref')!.split('/');
  const id=uuidSchema.safeParse(parts[1]);
  return parts.length===2&&(parts[0]==='work'||parts[0]==='decision')&&id.success?{entityType:parts[0],id:id.data}:null;
}
export function reportTargetFromUrl(input:string|URL):{id:string;revision:number}|null {
  const url=new URL(String(input),'http://localhost');
  if(url.pathname!=='/reports'||url.searchParams.getAll('report').length!==1||url.searchParams.getAll('reportRevision').length!==1)return null;
  const id=uuidSchema.safeParse(url.searchParams.get('report')),text=url.searchParams.get('reportRevision')!,revision=Number(text);
  return id.success&&/^[1-9]\d*$/.test(text)&&Number.isSafeInteger(revision)?{id:id.data,revision}:null;
}
export function knowledgeTargetFromUrl(input:string|URL):string|null {
  const url=new URL(String(input),'http://localhost');
  if(url.pathname!=='/knowledge'||url.searchParams.getAll('object').length!==1)return null;
  const id=uuidSchema.safeParse(url.searchParams.get('object'));
  return id.success?id.data:null;
}
/** Page selectors are separate from personal global context and survive startup canonicalization. */
export function canonicalPageTarget(input: string | URL): string {
  const url = new URL(String(input), 'http://localhost');
  const target = new URL(url.pathname, 'http://localhost');
  if (url.pathname === '/data' && !(url.searchParams.has('fact') && url.searchParams.has('result'))) {
    const kind = url.searchParams.has('result') ? 'result' : 'fact';
    const id = uuidSchema.safeParse(url.searchParams.get(kind));
    const revisionText = url.searchParams.get(kind + 'Revision') ?? '';
    const revision = Number(revisionText);
    if (id.success && /^[1-9]\d*$/.test(revisionText) && Number.isSafeInteger(revision)) {
      target.searchParams.set(kind, id.data);
      target.searchParams.set(kind + 'Revision', String(revision));
    }
  }
  if (url.pathname === '/data') { const file = uuidSchema.safeParse(url.searchParams.get('file')); if (file.success) target.searchParams.set('file', file.data); }
  const executionTarget = executionTargetFromUrl(url);
  if (executionTarget) target.searchParams.set('ref', executionTarget.entityType + '/' + executionTarget.id);
  const report = reportTargetFromUrl(url);
  if (report) { target.searchParams.set('report', report.id); target.searchParams.set('reportRevision', String(report.revision)); }
  const knowledge = knowledgeTargetFromUrl(url);
  if (knowledge) target.searchParams.set('object', knowledge);
  target.hash = url.hash;
  return target.pathname + target.search + target.hash;
}
export function routeUrl(pathname: string, context: GlobalContext | null): string {
  const url = new URL(pathname, 'http://localhost');
  for (const key of ['rootKind','dit','cluster','product','team','goal','mode','snapshot','at','from','to']) url.searchParams.delete(key);
  if (context) {
    const p = url.searchParams;
    if(context.scopePath.rootKind)p.set('rootKind',context.scopePath.rootKind);
    for (const [key, value] of Object.entries({ dit: context.scopePath.ditId, cluster: context.scopePath.clusterId, product: context.scopePath.productId, team: context.scopePath.teamId, goal: context.goalId, mode: context.resultMode, snapshot: context.resultMode === 'agreed' ? context.snapshotId : null })) if (value !== null) p.set(key, value);
    if (context.time.kind === 'as_of') p.set('at', context.time.date);
    else { p.set('from', context.time.startInclusive); p.set('to', context.time.endExclusive); }
  }
  return url.pathname + url.search + url.hash;
}
