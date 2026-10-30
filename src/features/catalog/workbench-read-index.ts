import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { WorkbenchEntityMap, WorkbenchEntityType } from '../../domain/workbench/entities';
import type { EntityRef, Header } from '../../domain/workbench/primitives';
import type { WorkbenchRepository } from '../../server/storage/workbench-repository';
import { stableJson } from '../../server/workbench/command-store';
import { WorkbenchHttpError, type PageRequest, type PageResult } from '../../server/workbench/protocol';
import type { QueryContext } from '../../server/workbench/query-registry';

type Row={entity_type:string;id:string;title:string;payload:string};
const installed=new WeakMap<WorkbenchRepository,WorkbenchReadIndex>();
export const normalizedSearch=(text:string)=>text.normalize('NFC').toLocaleLowerCase('ru-RU');
export type WorkbenchReadIndex=ReturnType<typeof install>;
/** Only current confirmed heads live here. Bootstrap/rebuild and transactional
 * owner projections write the index; ordinary queries never repair or populate it. */
export function createWorkbenchReadIndex(repository:WorkbenchRepository):WorkbenchReadIndex {
  const existing=installed.get(repository); if(existing) return existing;
  const index=install(repository); installed.set(repository,index); return index;
}
function install(repository:WorkbenchRepository) {
  const sql=repository.sqlForModule('read',{trackStateRevision:false});
  sql.execMigration('catalog-v1',`
    CREATE TABLE wb_read_catalog(entity_type TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,title TEXT NOT NULL,search_text TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(entity_type,id));
    CREATE INDEX wb_read_type ON wb_read_catalog(entity_type,title,id);
    CREATE INDEX wb_read_name ON wb_read_catalog(search_text,entity_type,id);
  `);
  const put=(entityType:string,value:Header)=>{
    const named=value as Header & {title?:string;name?:string;request?:string};
    const title=named.title??named.name??(entityType==='decision'?named.request:undefined)??value.id;
    sql.run('INSERT OR REPLACE INTO wb_read_catalog VALUES(?,?,?,?,?,?)',[entityType,value.id,value.revision,title,normalizedSearch(title),JSON.stringify(value)]);
  };
  const secret=randomBytes(32); let generation=0;
  const cursorFingerprint=(binding:unknown,context:QueryContext)=>createHash('sha256').update(stableJson({binding,revision:repository.getStateRevision(),generation,installationId:context.installationId,personId:context.ownAccess.personId,role:context.ownAccess.role,policyState:context.ownAccess.policyState})).digest('hex');
  const rebuild=()=>repository.transaction(()=>{
    sql.run('DELETE FROM wb_read_catalog');
    for(const {entityType,value} of repository.readPublishedCatalog()) put(entityType,value);
    generation++;
  });
  rebuild();
  repository.registerCatalogProjection('read',refs=>{
    for(const ref of refs) {
      const value=repository.readPublishedHead(ref);
      if(value) put(ref.entityType,value);
      else sql.run('DELETE FROM wb_read_catalog WHERE entity_type=? AND id=?',[ref.entityType,ref.id]);
    }
  });
  const pageRead=<T>(read:(offset:number,limit:number)=>T[],request:PageRequest,binding:unknown,context:QueryContext):{items:T[];page:PageResult}=>{
    const fingerprint=createHash('sha256').update(stableJson({binding,revision:repository.getStateRevision(),generation,installationId:context.installationId,personId:context.ownAccess.personId,role:context.ownAccess.role,policyState:context.ownAccess.policyState,limit:request.limit})).digest('hex');
    const stale=():never=>{throw new WorkbenchHttpError(409,'CURSOR_STALE','Обновите список: контекст или данные изменились');};
    let offset=0;
    if(request.cursor) {
      try {
        const [body,mac,...extra]=request.cursor.split('.'); if(!body || !mac || extra.length) stale();
        const expected=createHmac('sha256',secret).update(body).digest(); const received=Buffer.from(mac,'base64url');
        if(received.length!==expected.length || !timingSafeEqual(received,expected)) stale();
        const decoded=JSON.parse(Buffer.from(body,'base64url').toString());
        if(decoded.fingerprint!==fingerprint || !Number.isSafeInteger(decoded.offset) || decoded.offset<0) stale();
        offset=decoded.offset;
      } catch {stale();}
    }
    const candidates=read(offset,request.limit+1); const items=candidates.slice(0,request.limit),hasMore=candidates.length>request.limit;
    const body=Buffer.from(JSON.stringify({fingerprint,offset:offset+items.length})).toString('base64url');
    return {items,page:{hasMore,nextCursor:hasMore?body+'.'+createHmac('sha256',secret).update(body).digest('base64url'):null}};
  };
  return {
    rebuild,
    sealCursor(position:unknown,binding:unknown,context:QueryContext):string {
      const body=Buffer.from(JSON.stringify({fingerprint:cursorFingerprint(binding,context),position})).toString('base64url');
      return body+'.'+createHmac('sha256',secret).update(body).digest('base64url');
    },
    openCursor(token:string,binding:unknown,context:QueryContext):unknown {
      try {
        const [body,mac,...extra]=token.split('.'); if(!body||!mac||extra.length) throw Error('cursor');
        const expected=createHmac('sha256',secret).update(body).digest(),received=Buffer.from(mac,'base64url');
        if(received.length!==expected.length || !timingSafeEqual(received,expected)) throw Error('cursor');
        const decoded=JSON.parse(Buffer.from(body,'base64url').toString());if(decoded.fingerprint!==cursorFingerprint(binding,context)) throw Error('cursor');
        return decoded.position;
      } catch {throw new WorkbenchHttpError(409,'CURSOR_STALE','Обновите историю: контекст или данные изменились');}
    },
    list<K extends WorkbenchEntityType>(type:K):WorkbenchEntityMap[K][] {
      return sql.all<Row>('SELECT payload FROM wb_read_catalog INDEXED BY wb_read_type WHERE entity_type=? ORDER BY title,id',[type]).map(row=>JSON.parse(row.payload));
    },
    read(ref:EntityRef):Header|null {
      const row=sql.get<Row>('SELECT payload FROM wb_read_catalog WHERE entity_type=? AND id=?',[ref.entityType,ref.id]); return row?JSON.parse(row.payload):null;
    },
    search(text:string):Array<{entityType:string;value:Header;name:string}> {
      return sql.all<Row>(`SELECT entity_type,payload,title FROM wb_read_catalog INDEXED BY wb_read_name WHERE instr(search_text,?)>0
        AND entity_type IN ('core_goal_definition','directory_entity','work','decision') ORDER BY search_text,entity_type,id`,[normalizedSearch(text)])
        .map(row=>({entityType:row.entity_type,value:JSON.parse(row.payload),name:row.title}));
    },
    explain(type:string):string[] {return sql.all<{detail:string}>('EXPLAIN QUERY PLAN SELECT payload FROM wb_read_catalog INDEXED BY wb_read_type WHERE entity_type=? ORDER BY title,id',[type]).map(row=>row.detail);},
    pageRead,
    page<T>(items:T[],request:PageRequest,binding:unknown,context:QueryContext) {return pageRead((offset,limit)=>items.slice(offset,offset+limit),request,binding,context);},
  };
}
