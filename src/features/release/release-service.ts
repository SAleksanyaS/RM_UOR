import { randomUUID,createHash } from 'node:crypto';
import type { CatalogSnapshot,CuratorSession,Draft,LocalSnapshot,Attestation } from '../../domain/contracts';
import type { ApplicationContext } from '../../server/workspace/context';
import { createGitProvider,publicationFolder,publicationId,catalogItem } from '../publishing/application-publishing';
import { canonicalJson,inspectMerge,refreshObjectRevision } from '../publishing/merge-object';
import { applyDraft } from '../catalog/catalog-store';
import { validateCatalog } from '../publishing/validate-version';
import { ActionError } from '../identity/role-service';
import type { ReleasePreview,ReleaseDraft,ReleaseField,ResolveConflictInput } from './release-contracts';
import type { RepositoryVersion } from '../publishing/git-cli-provider';
import { canReadSnapshot } from '../connectors/service';
import type { StoredReportTemplate } from '../report-templates/contracts';
const TTL=15*60000;
const fingerprint=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex');
const fieldLabels:Record<string,string>={title:'Название',summary:'Описание',weight:'Вес',officialTarget:'Официальная цель',internalTarget:'Внутренняя цель',priority:'Приоритет',ownerId:'Владелец',curatorId:'Куратор УОР',measurement:'Методика',plan:'План работ',dueDate:'Срок',targetDate:'Обязательство',forecastDate:'Прогноз',name:'Название',text:'Комментарий',teams:'Объекты карты',participantIds:'Участники',active:'Применимость',links:'Ссылки',body:'Содержание',collection:'Автосбор',importProfile:'Профиль загрузки'};
const withoutRevision=(item:Record<string,unknown>|null)=>{if(!item)return null;const value=structuredClone(item);delete value.revision;return value;};
interface StoredPreview {preview:ReleasePreview;curatorId:string;catalogSignature:string;drafts:Draft[];remoteObjects:Record<string,Record<string,unknown>|null>}
function signature(context:ApplicationContext,session:CuratorSession){
 return fingerprint({catalog:context.db.get('catalog','active'),drafts:context.db.list<Draft>('drafts').filter(d=>d.curatorId===session.curatorId),
 snapshots:context.db.list<LocalSnapshot>('snapshots').filter(s=>s.status==='validated'&&s.curatorId===session.curatorId&&canReadSnapshot(s,session,context.installationId)&&!context.db.get('published-items',`snapshot:${s.id}`)),
 attestations:context.db.list<Attestation>('attestations').filter(a=>a.curatorId===session.curatorId&&!a.invalidatedAt&&!context.db.get('published-items',`attestation:${a.id}`)),
 evidence:context.db.list<{curatorId?:string}>('evidence').filter(e=>!e.curatorId||e.curatorId===session.curatorId),
 templates:context.db.list<StoredReportTemplate>('report-templates').filter(t=>t.ownerId===session.curatorId||t.ownerId===session.id)});
}
async function releaseVersion(context:ApplicationContext){const git=await createGitProvider(context);try{return await git.readVersion(context.config.releaseBranch);}catch(e){if(!(e as Error).message.includes('нет ветки'))throw e;return git.readVersion(context.config.publishedBranch);}}
function embedded(version:RepositoryVersion){const content=version.files['catalog/catalog.json']??version.files['catalog/demo.json'];return content?JSON.parse(content) as CatalogSnapshot:null;}
function remoteItem(version:RepositoryVersion,base:CatalogSnapshot|null,draft:Draft){const folder=publicationFolder(draft.change.kind);
 for(const[file,content]of Object.entries(version.files)){if(!file.startsWith(`catalog/${folder}/`)||!file.endsWith('.json'))continue;const item=JSON.parse(content) as Record<string,unknown>;if(item.id===draft.change.id)return{item,path:file};}
 return{item:catalogItem(base,folder,draft.change.id),path:`catalog/${folder}/${publicationId(draft.change.id)}.json`};}
function describe(draft:Draft,catalog:CatalogSnapshot){const id=draft.change.id;return draft.change.kind==='goal'?catalog.goals.find(g=>g.id===id)?.title??'Цель':draft.change.kind==='source'?catalog.sources.find(s=>s.id===id)?.name??'Источник':draft.change.kind==='leader'?catalog.leaders.find(l=>l.id===id)?.name??'ИТ-лидер':String(draft.change.patch.name??draft.change.patch.text??catalog.goals.find(g=>g.id===draft.change.patch.goalId)?.title??'Общая запись');}
function draftPreview(draft:Draft,remote:Record<string,unknown>|null,path:string,catalog:CatalogSnapshot):ReleaseDraft{
 const local={...draft.base,...draft.change.patch,id:draft.change.id},base=withoutRevision(draft.base),proposed=withoutRevision(local),latest=withoutRevision(remote);
 const inspected=inspectMerge(base,proposed,latest),conflicts=inspected.conflicts.map(c=>c.path);
 const fields:ReleaseField[]=[...new Set([...Object.keys(base??{}),...Object.keys(proposed??{}),...Object.keys(latest??{})])].filter(key=>!['id','revision','updatedAt','updatedBy'].includes(key)&&canonicalJson(base?.[key])!==canonicalJson(proposed?.[key])).map(key=>({path:`/${key.replace(/~/g,'~0').replace(/\//g,'~1')}`,label:fieldLabels[key]??key,before:base?.[key]??null,local:proposed?.[key]??null,remote:latest?.[key]??null,conflict:conflicts.some(p=>p==='$'||p===`/${key}`||p.startsWith(`/${key}/`))}));
 for(const c of inspected.conflicts)if(!fields.some(f=>f.path===c.path))fields.push({path:c.path,label:c.path==='$'?'Вся запись':c.labelPath.split('.').map(p=>fieldLabels[p]??p).join(' / '),before:c.base,local:c.local,remote:c.remote,conflict:true});
 return{id:draft.id,kind:draft.change.kind,objectId:draft.change.id,label:describe(draft,catalog),path,fields,conflicts};
}
export async function previewRelease(context:ApplicationContext,session:CuratorSession):Promise<ReleasePreview>{
 if(session.role!=='curator')throw new ActionError('Подготовка выпуска доступна куратору УОР',403);
 const state=await context.state(session),initial=signature(context,session),catalog=state.catalog,drafts=await context.catalogs.listDrafts(session),remote=await releaseVersion(context),git=await createGitProvider(context),main=await git.readVersion(context.config.publishedBranch),base=embedded(remote);
 if(initial!==signature(context,session))throw new ActionError('Черновики изменились во время проверки. Повторите предпросмотр.',409);
 const remoteObjects:StoredPreview['remoteObjects']={},items=drafts.map(d=>{const found=remoteItem(remote,base?.classification===catalog.classification?base:null,d);remoteObjects[d.id]=found.item;return draftPreview(d,found.item,found.path,catalog);});
 const snapshots=context.db.list<LocalSnapshot>('snapshots').filter(s=>s.status==='validated'&&s.curatorId===session.curatorId&&canReadSnapshot(s,session,context.installationId)&&!context.db.get('published-items',`snapshot:${s.id}`));
 const attestations=context.db.list<Attestation>('attestations').filter(a=>a.curatorId===session.curatorId&&!a.invalidatedAt&&!context.db.get('published-items',`attestation:${a.id}`));
 const evidence=context.db.list<{id:string;name:string;size:number;curatorId?:string}>('evidence').filter(e=>!e.curatorId||e.curatorId===session.curatorId);
 const templates=context.db.list<StoredReportTemplate>('report-templates').filter(t=>t.ownerId===session.curatorId||t.ownerId===session.id);
 const releaseChanges=Object.entries(remote.files).filter(([file,value])=>main.files[file]!==value&&!file.startsWith('changes/')).map(([file,value])=>({id:file,label:file,detail:`${Buffer.byteLength(value)} байт`}));
 const allowed=!(catalog.classification==='corporate'&&context.config.publicationMode==='demo-only');
 const preview:ReleasePreview={id:randomUUID(),expiresAt:new Date(Date.now()+TTL).toISOString(),remoteCommit:remote.commit,publishedCommit:main.commit,publicationAllowed:allowed,message:allowed?'Проверьте состав и отправьте выбранные записи в готовящийся выпуск.':'Корпоративная рабочая карта остаётся локально. Настройте разрешённый внутренний репозиторий для публикации данных.',drafts:items,
 snapshots:snapshots.map(s=>({id:s.id,label:catalog.sources.find(x=>x.id===s.sourceId)?.name??'Источник',detail:`${s.period} · ${s.observations.length} фактов · ${s.curatorName??'УОР'}`})),
 attestations:attestations.map(a=>({id:a.id,label:catalog.goals.find(g=>g.id===a.goalId)?.title??'Цель',detail:`${a.period} · ${a.leaderId?catalog.leaders.find(l=>l.id===a.leaderId)?.name??a.leaderId:'ДИТ'}`,evidenceIds:a.evidenceIds})),
 evidence:evidence.map(e=>({id:e.id,label:e.name,detail:`${e.size} байт`,bytes:e.size})),templates:templates.map(t=>({id:t.id,label:t.profile.name,detail:`${t.inspection.slides.length} слайдов · ${t.updatedAt}`,bytes:t.inspection.size})),releaseChanges};
 context.db.set('release-previews',preview.id,{preview,curatorId:session.curatorId,catalogSignature:initial,drafts,remoteObjects} satisfies StoredPreview);
 return preview;
}
/** Check both local review basis and exact remote head. Call again immediately before provider push. */
export async function validateReleasePreview(context:ApplicationContext,session:CuratorSession,previewId:string):Promise<ReleasePreview>{
 if(session.role!=='curator'||!session.curatorId)throw new ActionError('Публикация доступна куратору УОР',403);
 const stored=context.db.get<StoredPreview>('release-previews',previewId);
 if(!stored||stored.curatorId!==session.curatorId||Date.parse(stored.preview.expiresAt)<=Date.now())throw new ActionError('Предпросмотр устарел или принадлежит другому профилю. Получите новый состав.',409);
 if(!stored.preview.publicationAllowed)throw new ActionError(stored.preview.message,403);
 if(signature(context,session)!==stored.catalogSignature)throw new ActionError('Локальный состав изменился после предпросмотра. Обновите состав; выбранные записи и черновики сохранены.',409);
 const remote=await releaseVersion(context);
 if(remote.commit!==stored.preview.remoteCommit)throw new ActionError('Готовящийся выпуск изменился после предпросмотра. Обновите состав перед отправкой.',409);
 if(signature(context,session)!==stored.catalogSignature)throw new ActionError('Локальные данные изменились во время проверки выпуска. Обновите предпросмотр.',409);
 return stored.preview;
}
export async function resolveReleaseConflict(context:ApplicationContext,session:CuratorSession,input:ResolveConflictInput){
 const stored=context.db.get<StoredPreview>('release-previews',input.previewId);if(!stored||stored.curatorId!==session.curatorId||Date.parse(stored.preview.expiresAt)<Date.now())throw new ActionError('Предпросмотр устарел. Получите новую версию.',409);
 const draft=stored.drafts.find(d=>d.id===input.draftId),view=stored.preview.drafts.find(d=>d.id===input.draftId);if(!draft||!view)throw new ActionError('Черновик не найден',404);
 if(Object.keys(input.choices).some(path=>!view.conflicts.includes(path))||view.conflicts.some(path=>!Object.hasOwn(input.choices,path)))throw new ActionError('Выберите вариант для каждого конфликтующего поля',400);
 const version=await releaseVersion(context);if(version.commit!==stored.preview.remoteCommit)throw new ActionError('Коллеги уже изменили выпуск. Получите свежий предпросмотр; введённые решения остаются в форме.',409);
 const remote=stored.remoteObjects[draft.id],local={...draft.base,...draft.change.patch,id:draft.change.id};
 const resolved=inspectMerge(withoutRevision(draft.base),withoutRevision(local),withoutRevision(remote),input.choices);if(resolved.conflicts.length)throw new ActionError('Есть неразрешённые поля',409);
 const catalog=await context.catalogs.readForSession(session);
 return context.db.transaction(()=>{
  if(signature(context,session)!==stored.catalogSignature)throw new ActionError('Локальные черновики изменились. Повторите предпросмотр.',409);
  if(resolved.value===null){context.db.remove('drafts',draft.id);return{draftId:draft.id,discarded:true};}
   const chosen={...resolved.value,id:draft.change.id};
   const after=Object.hasOwn(local,'revision')?refreshObjectRevision(chosen,randomUUID()):chosen;
  const next:Draft={...draft,base:remote,change:{...draft.change,baseRevision:typeof remote?.revision==='string'?remote.revision:null,patch:after},createdAt:new Date().toISOString(),error:null,status:'local'};
  const candidate=structuredClone(catalog);applyDraft(candidate,next);validateCatalog(candidate);
  context.db.set('drafts',draft.id,next);context.catalogs.recordChange(session,'publication_conflict_resolved',draft.change.id,view.label,local,after);return{draftId:draft.id,discarded:false};
 });
}
