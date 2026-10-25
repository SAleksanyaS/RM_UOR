import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { CatalogSnapshot, LocalSnapshot, Observation, Session, SourceDefinition } from '../../domain/contracts';
import type { ApplicationContext } from '../../server/workspace/context';
import { safeArtifactPath } from '../../server/workspace/paths';
import { canonicalJson } from '../publishing/merge-object';
import { validateSnapshot } from '../publishing/validate-version';
import { parseTable } from '../tabular-import/parser';
import { parseMaturityWorkbook } from '../importing/maturity-parser';
import { captureEvaluationBasis } from '../reporting/evaluation-basis';
import { collectionSchema, ConnectorError, connectorError } from './contracts';
import { download, loadProfile } from './transport';
import { executeBrowser, readScenario } from './browser';
import { collectQlik } from './qlik';

const id = z.string().min(1).max(500), finite = z.number().finite();
const inputObservation = z.object({ goalId: id, leaderId: id.nullable(), participantId: id, participantName: z.string().max(1000), metricId: id, metricName: z.string().max(1000),
  value: finite.nullable(), target: finite.nullable(), unit: z.string().max(100), state: z.enum(['numeric','missing','exception','no_events']), reason: z.string().max(2000).nullable(), period: z.iso.date(), sourceUpdatedAt: z.iso.datetime({ offset: true }).nullable() }).strict();
export function factsHash(rows: Observation[]) { return createHash('sha256').update(canonicalJson(rows.map(({ id: _id, downloadedAt: _at, ...fact }) => canonicalJson(fact)).sort())).digest('hex'); }
export function canReadSnapshot(snapshot: LocalSnapshot & {ownerSessionId?:string;ownerInstallationId?:string}, session: Session, installationId?:string) { return snapshot.ownerInstallationId ? snapshot.ownerInstallationId===installationId : !snapshot.ownerSessionId || snapshot.ownerSessionId === session.id; }
export function parseObservationsJson(bytes: Buffer, source: SourceDefinition, now: string): Observation[] {
  let input: unknown; try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw new ConnectorError('format', 'Ожидается UTF-8 JSON с observations'); }
  const parsed = z.object({ schemaVersion: z.literal(1), observations: z.array(inputObservation).min(1).max(20000) }).strict().safeParse(input);
  if (!parsed.success) throw new ConnectorError('format', 'JSON не соответствует observations-v1 (обязательные измерения, период и числовые значения)');
  return parsed.data.observations.map(row => ({ ...row, id: randomUUID(), sourceId: source.id, downloadedAt: now }));
}
function number(value: string): number | null {
  if (!value.trim()) return null; if (!/^[+-]?\d+(?:[.,]\d+)?\s*%?$/.test(value.trim())) throw new ConnectorError('format', 'В таблице ожидается число без разделителей тысяч');
  const n = Number(value.trim().replace('%','').replace(',','.')); if (!Number.isFinite(n)) throw new ConnectorError('format', 'Число вне допустимого диапазона'); return n;
}
export async function mapSavedTable(bytes: Buffer, source: SourceDefinition, catalog: CatalogSnapshot, now: string): Promise<Observation[]> {
  const profile = source.importProfile;
  if(profile?.parser==='maturity-xlsx-v1'){
    if(source.collection?.format!=='xlsx')throw new ConnectorError('configuration_required','Профиль зрелости принимает только XLSX');
    const goalId=source.collection.goalId??(source.goalIds.length===1?source.goalIds[0]:undefined),goal=catalog.goals.find(g=>g.id===goalId);
    const period=source.collection.parameters?.period,sourceUpdatedAt=source.collection.parameters?.sourceUpdatedAt??null;
    if(!goal||!period||!z.iso.date().safeParse(period).success)throw new ConnectorError('configuration_required','Для книги зрелости явно задайте goalId и parameters.period');
    const parsed=await parseMaturityWorkbook(bytes);if(parsed.issues.some(i=>i.severity==='error')||parsed.ignoredRows)throw new ConnectorError('incomplete','Книга содержит ошибочные или неполные строки; очистите выгрузку');
    const metricIds=goal.measurement?.metrics.map(m=>m.id)??goal.requiredMetricIds??[];
    return parsed.rows.map(row=>{
      const key=row.teamCode??row.teamName,teamId=profile.teamMapping[key]??row.teamCode;
      const teams=teamId?catalog.entities.filter(e=>e.id===teamId):catalog.entities.filter(e=>e.name===row.teamName);
      const metricId=profile.metricMapping[row.metricName]??(metricIds.includes(row.metricName)?row.metricName:undefined),metric=goal.measurement?.metrics.find(m=>m.id===metricId);
      if(teams.length!==1||!metricId||!metricIds.includes(metricId))throw new ConnectorError('format','Неизвестное/неоднозначное сопоставление команды или метрики книги зрелости');
      const team=teams[0],assignments=catalog.assignments.filter(a=>a.goalId===goal.id&&a.active!==false&&(a.participantIds?a.participantIds.includes(team.id):a.leaderId===team.leaderId));
      if(assignments.length!==1)throw new ConnectorError('format','Команда книги не входит в однозначный состав цели');
      return {id:randomUUID(),goalId:goal.id,leaderId:assignments[0].leaderId,participantId:team.id,participantName:team.name,metricId,metricName:metric?.name??row.metricName,value:row.value,target:row.target,unit:metric?.unit??goal.unit,state:row.state,reason:row.reason,period,sourceId:source.id,sourceUpdatedAt,downloadedAt:now};
    });
  }
  if (!profile || profile.parser !== 'tabular-v1') throw new ConnectorError('configuration_required', 'Для CSV/XLSX сохраните профиль сопоставления tabular-v1 в настройках источника');
  const goalId = source.collection?.goalId ?? (source.goalIds.length === 1 ? source.goalIds[0] : undefined), goal = catalog.goals.find(g => g.id === goalId);
  if (!goal) throw new ConnectorError('configuration_required', 'Для табличной выгрузки выберите goalId источника');
  const table = await parseTable(`data.${source.collection!.format}`, bytes);
  for (const column of Object.values(profile.columns)) if (column && !table.columns.includes(column)) throw new ConnectorError('format', `Выгрузка не содержит сохранённую колонку «${column}»`);
  const metrics = goal.measurement?.metrics ?? (goal.requiredMetricIds?.length ? goal.requiredMetricIds.map(metricId => ({ id: metricId, name: metricId, unit: goal.unit, target: goal.officialTarget })) : [{ id: goal.id, name: goal.metric || goal.title, unit: goal.unit, target: goal.officialTarget }]);
  const normalize = (v: string) => v.normalize('NFKC').trim().toLocaleLowerCase('ru');
  const resolve = (value: string, mapping: Record<string,string>, options: { id: string; name: string }[]) => {
    const candidates = mapping[value] !== undefined ? options.filter(o => o.id === mapping[value]) : options.filter(o => normalize(o.id) === normalize(value) || normalize(o.name) === normalize(value));
    if (candidates.length !== 1) throw new ConnectorError('format', `Неоднозначное/неизвестное сопоставление «${value}»`); return candidates[0];
  };
  const participants = [...catalog.entities.map(e => ({ id:e.id, name:e.name })), ...catalog.leaders.filter(l => !catalog.entities.some(e => e.id === l.id)).map(l => ({id:l.id,name:l.name})), {id:'global-dit',name:'ДИТ в целом'}];
  const states: Record<string,Observation['state']> = { numeric:'numeric',число:'numeric',missing:'missing','нет данных':'missing',exception:'exception',исключение:'exception',no_events:'no_events','нет событий':'no_events' };
  return table.rows.map(row => {
    const get = (role: keyof typeof profile.columns) => { const column = profile.columns[role]; return column ? row.cells[table.columns.indexOf(column)]?.trim() ?? '' : ''; };
    const leaderId = get('leader') ? resolve(get('leader'),profile.leaderMapping,catalog.leaders).id : profile.defaults.leaderId ?? null;
    const participant = resolve(get('participant') || profile.defaults.participantId || '',profile.participantMapping,participants);
    const metric = resolve(get('metric') || profile.defaults.metricId || '',profile.metricMapping,metrics);
    const m = metrics.find(m => m.id === metric.id)!, period = get('period') || profile.defaults.period, sourceUpdatedAt = get('sourceUpdatedAt') || null;
    const state = get('state') ? states[normalize(get('state'))] : get('value') ? 'numeric' : 'missing';
    if (!state) throw new ConnectorError('format', `Строка ${row.rowNumber}: неизвестное состояние`);
    return { id:randomUUID(), goalId:goal.id, leaderId, participantId:participant.id,participantName:participant.name,metricId:m.id,metricName:m.name,unit:m.unit,target:profile.columns.target ? number(get('target')) : m.target,
      value:state==='numeric'?number(get('value')):null,state,reason:get('reason')||null,period,sourceId:source.id,sourceUpdatedAt,downloadedAt:now };
  });
}
function validateRows(rows: Observation[], source: SourceDefinition, catalog: CatalogSnapshot) {
  if (!rows.length) throw new ConnectorError('incomplete','Источник не вернул фактов');
  const keys = new Set<string>();
  for (const row of rows) {
    const parsed = inputObservation.safeParse(Object.fromEntries(Object.entries(row).filter(([key]) => !['id','sourceId','downloadedAt'].includes(key))));
    if (!parsed.success) throw new ConnectorError('format','Факт содержит недопустимые поля/дату/значение');
    const goal = catalog.goals.find(g => g.id === row.goalId); if (!goal || !source.goalIds.includes(row.goalId)) throw new ConnectorError('format','Факт относится к чужой цели');
    if (row.state === 'numeric' && row.value === null || row.state !== 'numeric' && (!row.reason || row.value !== null)) throw new ConnectorError('incomplete','Отсутствует числовое значение либо причина нечислового состояния');
    const assignments = catalog.assignments.filter(a => a.goalId === goal.id && a.active !== false);
    if (row.leaderId !== null && !assignments.some(a => a.leaderId === row.leaderId)) throw new ConnectorError('format','ИТ-лидер не входит в состав цели');
    if (assignments.some(a=>a.participantIds?.length) && !assignments.some(a=>a.leaderId === row.leaderId && a.participantIds?.includes(row.participantId))) throw new ConnectorError('format','Участник не входит в заявленный состав');
    if (goal.measurement) {
      const metric = goal.measurement.metrics.find(m=>m.id===row.metricId); if (!metric || metric.target!==row.target || metric.unit!==row.unit) throw new ConnectorError('format','Показатель/порог/единица отличается от методики цели');
      if (['binary','milestones'].includes(goal.measurement.kind) && row.state==='numeric' && row.value!==0 && row.value!==1) throw new ConnectorError('format','Дискретный показатель должен содержать 0 или 1');
    } else if (!(goal.requiredMetricIds ?? [goal.id]).includes(row.metricId)) throw new ConnectorError('format','Неизвестный показатель цели');
    const key = canonicalJson([row.goalId,row.period,row.leaderId,row.participantId,row.metricId]); if (keys.has(key)) throw new ConnectorError('format','В выгрузке повторяются измерения одного факта'); keys.add(key);
  }
}
export async function collectConfiguredSource(context: ApplicationContext, session: Session, sourceId: string, signal: AbortSignal, onStage?: (stage: { key: string; label: string }) => void): Promise<{ snapshots: LocalSnapshot[]; duplicate: boolean }> {
  const diagnosticKey = `${session.id}:${sourceId}`;
  let unacceptedArtifact:string|undefined;
  try {
    signal.throwIfAborted(); const catalog = await context.catalogs.readForSession(session), source = catalog.sources.find(s=>s.id===sourceId);
    if (!source) throw new ConnectorError('configuration_required','Источник не найден');
    if (source.kind==='manual' || source.kind==='file' && !source.collection) throw new ConnectorError('manual_required','Загрузите файл или внесите факт вручную');
    const parsed = collectionSchema.safeParse(source.collection); if (!parsed.success) throw new ConnectorError('configuration_required','Настройте способ получения и личный профиль доступа в разделе «Получение данных»');
    const config = parsed.data, profile = await loadProfile(context.paths.runtimeRoot, config.authProfileId);
    const basisSignature=canonicalJson(source.goalIds.map(goalId=>captureEvaluationBasis(catalog,goalId)));
    onStage?.({key:'connect',label:'Получение реальной выгрузки'});
    let artifact;
    if (config.adapter==='browser') { if (!config.scenarioId && !config.scenario) throw new ConnectorError('configuration_required','Выберите записанный сценарий'); artifact = await executeBrowser(context.paths.runtimeRoot,profile,config.scenario ?? await readScenario(context.paths.runtimeRoot,config.scenarioId!),config.parameters??{},signal); }
    else if (config.adapter==='qlik') artifact = await collectQlik(config,profile,signal);
    else { const endpoint = config.adapter==='confluence'?config.confluence?.downloadUrl:config.endpoint; if(!endpoint)throw new ConnectorError('configuration_required','Укажите точный endpoint/download URL источника'); artifact = await download(endpoint,profile,signal); }
    signal.throwIfAborted(); onStage?.({key:'verify',label:'Проверка выгрузки и сохранённого сопоставления'});
    const newest=Math.max(0,...context.db.list<LocalSnapshot & {ownerInstallationId?:string}>('snapshots').filter(s=>s.sourceId===sourceId&&s.ownerInstallationId===context.installationId).map(s=>Date.parse(s.collectedAt)).filter(Number.isFinite));
    const now = new Date(Math.max(Date.now(),newest+1)).toISOString();
    let rows:Observation[];
    try{rows=config.format==='observations-json'?parseObservationsJson(artifact.bytes,source,now):await mapSavedTable(artifact.bytes,source,catalog,now);}catch(error){if(error instanceof ConnectorError)throw error;throw new ConnectorError('format','Выгрузка не соответствует сохранённому формату таблицы');}
    validateRows(rows,source,catalog);
    if (canonicalJson(source) !== canonicalJson((await context.catalogs.readForSession(session)).sources.find(s=>s.id===sourceId))) throw new ConnectorError('configuration_required','Настройки источника изменились во время получения; повторите сбор');
    const groups = new Map<string,Observation[]>(); for(const row of rows){ const key=canonicalJson([row.goalId,row.period]);groups.set(key,[...(groups.get(key)??[]),row]); }
    const candidates: (LocalSnapshot & {ownerSessionId:string;ownerInstallationId:string})[] = [];
    for(const observations of groups.values()) {
      const goal=catalog.goals.find(g=>g.id===observations[0].goalId)!, dates=observations.map(o=>o.sourceUpdatedAt);
      const snapshot = {id:randomUUID(),classification:catalog.classification,sourceId,period:observations[0].period,observations,collectedAt:now,sourceUpdatedAt:dates.every(Boolean)?(dates as string[]).sort()[0]:null,origin:'dashboard' as const,dataHash:factsHash(observations),status:'personal' as const,curatorId:session.curatorId,curatorName:session.name,validatedAt:null,
        limitations:dates.every(Boolean)?[]:['Дата обновления источника неизвестна; время загрузки её не заменяет'],evidenceIds:[],evaluationBasis:captureEvaluationBasis(catalog,goal.id),ownerSessionId:session.id,ownerInstallationId:context.installationId};
      validateSnapshot(snapshot,catalog); candidates.push(snapshot);
    }
    signal.throwIfAborted();
    const artifactId=randomUUID(), directory=await safeArtifactPath(context.paths.runtimeRoot,`source-artifacts/connectors/${session.id}`);await mkdir(directory,{recursive:true});
    const artifactPath=path.join(directory,`${artifactId}.${config.format==='observations-json'?'json':config.format}`);unacceptedArtifact=artifactPath;await writeFile(artifactPath,artifact.bytes,{flag:'wx'});
    signal.throwIfAborted();
    const acceptedCatalog=await context.catalogs.readForSession(session),acceptedSource=acceptedCatalog.sources.find(s=>s.id===sourceId);
    if(canonicalJson(acceptedSource)!==canonicalJson(source)||canonicalJson(source.goalIds.map(goalId=>captureEvaluationBasis(acceptedCatalog,goalId)))!==basisSignature)throw new ConnectorError('configuration_required','Методика, состав или настройки изменились во время получения; повторите сбор');
    const result=context.db.transaction(()=>{
      const existing=context.db.list<LocalSnapshot & {ownerSessionId?:string;ownerInstallationId?:string}>('snapshots');let duplicate=true;
      const snapshots=candidates.map(candidate=>{const old=existing.filter(s=>(s.ownerInstallationId===context.installationId||!s.ownerInstallationId&&s.ownerSessionId===session.id)&&s.sourceId===sourceId&&s.period===candidate.period&&s.observations[0]?.goalId===candidate.observations[0].goalId).sort((a,b)=>b.collectedAt.localeCompare(a.collectedAt))[0];
        if(old&&factsHash(old.observations)===candidate.dataHash)return old;duplicate=false;context.db.set('snapshots',candidate.id,candidate);return candidate;});
      context.db.set('connector-artifacts',artifactId,{id:artifactId,ownerSessionId:session.id,sourceId,relativePath:path.relative(context.paths.runtimeRoot,artifactPath),sha256:createHash('sha256').update(artifact.bytes).digest('hex'),snapshotIds:snapshots.map(s=>s.id)});
      context.db.set('connector-diagnostics',diagnosticKey,{ownerSessionId:session.id,sourceId,at:now,status:'accepted',message:duplicate?'Идентичные факты уже сохранены':'Личные факты получены и проверены',facts:rows.length});return {snapshots,duplicate};
    });
    unacceptedArtifact=undefined;
    onStage?.({key:'accepted',label:result.duplicate?'Идентичный срез уже сохранён':'Личный срез сохранён'});return result;
  } catch(error){if(unacceptedArtifact)await rm(unacceptedArtifact,{force:true}).catch(()=>{});const e=connectorError(error);context.db.set('connector-diagnostics',diagnosticKey,{ownerSessionId:session.id,sourceId,at:new Date().toISOString(),status:e.code,message:e.message});throw e;}
}
