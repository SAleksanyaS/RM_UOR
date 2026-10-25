import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {KnowledgeEntity} from '../../domain/contracts';
import type {CompletionEvent,RetentionCheck,WorkPackage,ExecutionConfig} from './execution-contracts';
import {canonicalJson} from '../publishing/merge-object';
type Entry=CompletionEvent|RetentionCheck;
type Scope={entities:KnowledgeEntity[]};
const id=z.string().min(1).max(500),text=z.string().max(5000),proof={comment:text,evidence:text};
const event=z.object({id,at:z.iso.datetime({offset:true}),actor:id,completed:z.boolean(),...proof}).strict().refine(v=>v.comment.length>=5||v.evidence.length>=5);
const check=z.object({id,at:z.iso.datetime({offset:true}),actor:id,result:z.enum(['stable','regression','unknown']),...proof}).strict().refine(v=>v.comment.length>=5||v.evidence.length>=5);
const segmentSchema=z.object({version:z.literal(1),recordId:id,goalId:id,leaderId:id.nullable(),kind:z.enum(['events','checks']),previousId:id.nullable(),entries:z.array(z.unknown()).min(1).max(100)}).strict();
interface Segment{version:1;recordId:string;goalId:string;leaderId:string|null;kind:'events'|'checks';previousId:string|null;entries:Entry[]}
const digest=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex');
export function readExecutionJournal(entity:KnowledgeEntity):Segment{
 if(entity.type!=='execution_journal'||!entity.body||entity.body.length>100000)throw new Error('Некорректный архив журнала исполнения');const body=segmentSchema.parse(JSON.parse(entity.body));const entries=body.entries.map(item=>body.kind==='events'?event.parse(item):check.parse(item)),value:Segment={...body,entries};const hash=digest(value);
 if(entity.id!==`execution-journal-${hash}`||entity.revision!==hash||entity.goalIds?.length!==1||entity.goalIds[0]!==body.goalId||entity.leaderId!==body.leaderId)throw new Error('Архив журнала изменён или его внешняя запись не совпадает с содержимым');return value;
}
export function readJournalEntries(scope:Scope|undefined,head:string|undefined,expected:{id:string;goalId:string;leaderId:string|null;kind:'events'|'checks'}):Entry[]{
 if(!head)return[];if(!scope)throw new Error('Для полного журнала исполнения необходим каталог архивных сегментов');const byId=new Map(scope.entities.map(entity=>[entity.id,entity])),seen=new Set<string>(),chunks:Entry[][]=[];let current:string|null=head;
 while(current){if(seen.has(current)||seen.size>=10000)throw new Error('Цикл или превышение безопасного числа сегментов журнала');seen.add(current);const entity=byId.get(current);if(!entity)throw new Error('В выпуск не включён архивный сегмент журнала исполнения');const segment=readExecutionJournal(entity);if(segment.recordId!==expected.id||segment.goalId!==expected.goalId||segment.leaderId!==expected.leaderId||segment.kind!==expected.kind)throw new Error('Архив относится к другой записи исполнения');chunks.push(segment.entries);current=segment.previousId;}
 return chunks.reverse().flat();
}
export function assertEntryOrder(entries:Entry[]){const seen=new Set<string>();let previous='';for(const entry of entries){if(seen.has(entry.id))throw new Error('Повторяются события полного журнала');if(previous&&Date.parse(previous)>Date.parse(entry.at))throw new Error('Нарушен порядок полного журнала');seen.add(entry.id);previous=entry.at;}}
/** Keep a small editable head, adding immutable linked archive segments; history is never truncated. */
export function rotateExecutionJournal<T extends WorkPackage|ExecutionConfig>(value:T,scope:Scope):{record:T;segments:KnowledgeEntity[]}{
 const kind='events' in value?'events':'checks',headKey=kind==='events'?'eventArchiveId':'checkArchiveId',head=(value as WorkPackage&ExecutionConfig)[headKey],archived=readJournalEntries(scope,head,{id:value.id,goalId:value.goalId,leaderId:value.leaderId,kind}),all=(value as WorkPackage&ExecutionConfig)[kind] as Entry[];
 if(canonicalJson(all.slice(0,archived.length))!==canonicalJson(archived))throw new Error('Сохранённую историю исполнения изменять нельзя');const recent=all.slice(archived.length),removed:Entry[]=[];const raw={...value,[kind]:recent} as T;
 while(recent.length>100||JSON.stringify(raw).length>80000){if(recent.length<=1)throw new Error('Паспорт записи исполнения превышает допустимый размер');removed.push(recent.shift()!);}
 let previousId=head??null;const segments:KnowledgeEntity[]=[];let batch:Entry[]=[];
 function flush(){if(!batch.length)return;const body:Segment={version:1,recordId:value.id,goalId:value.goalId,leaderId:value.leaderId,kind,previousId,entries:batch},hash=digest(body),entity:KnowledgeEntity={id:`execution-journal-${hash}`,revision:hash,type:'execution_journal',name:kind==='events'?'Архив событий вехи':'Архив проверок удержания',goalIds:[value.goalId],leaderId:value.leaderId,body:JSON.stringify(body)};const existing=scope.entities.find(item=>item.id===entity.id);if(existing&&canonicalJson(readExecutionJournal(existing))!==canonicalJson(body))throw new Error('Архивный сегмент с такимID имеет другое содержимое');if(!existing)segments.push(entity);previousId=entity.id;batch=[];}
 for(const entry of removed){if(batch.length&&(batch.length>=100||JSON.stringify([...batch,entry]).length>60000))flush();batch.push(entry);}flush();if(previousId)(raw as WorkPackage&ExecutionConfig)[headKey]=previousId;return{record:raw,segments};
}
