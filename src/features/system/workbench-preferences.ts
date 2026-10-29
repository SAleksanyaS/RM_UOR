import { z } from 'zod';
import type { DirectoryEntity, PersonalPreferences } from '../../domain/workbench/entities';
import type { Clock } from '../../domain/workbench/primitives';
import { uuidSchema } from '../../domain/workbench/primitives';
import type { WorkbenchRepository } from '../../server/storage/workbench-repository';
import type { CommandContext } from '../../server/workbench/command-registry';
import { commitCommandEffect, createCommandStore } from '../../server/workbench/command-store';
import { globalContextSchema, sortSchema, WorkbenchHttpError } from '../../server/workbench/protocol';
import { goalColumns, executionColumns } from '../knowledge/workbench-dashboards';

export const preferenceSortFields:Record<string,readonly string[]> = {
  overview:goalColumns,'goals.list':goalColumns,'execution.list':executionColumns,
  'data.captures':['capturedAt','source','status'],'data.rows':['factKey','metric','value','scope'],
  'snapshots.list':['recordedAt','title'],'search':['title','kind'],'notifications.list':['emittedAt','category','readAt'],'uor.queue':['title','state','recordedAt'],
};
export const personalPreferencesSchema = z.strictObject({
  context:globalContextSchema.nullable(),sorts:z.record(z.string(),z.array(sortSchema)),
  visual:z.strictObject({theme:z.enum(['system','light','dark']),density:z.enum(['comfortable','compact'])}),notificationPersonId:uuidSchema.nullable().optional(),
}).superRefine((value,ctx) => {
  for (const [query,sorts] of Object.entries(value.sorts)) if (!Object.hasOwn(preferenceSortFields,query) || sorts.some(sort => !preferenceSortFields[query].includes(sort.field)) || new Set(sorts.map(s => s.field)).size !== sorts.length) ctx.addIssue({code:'custom',path:['sorts',query],message:'Unknown or duplicate sort'});
});
const fail = (code:string,status=422):never => { throw new WorkbenchHttpError(status,code,code); };
type Row = { revision:number;payload:string };
export function createPreferencesService({repository,installationId,clock}:{repository:WorkbenchRepository;installationId:string;clock:Clock}) {
  uuidSchema.parse(installationId);
  const sql = repository.sqlForModule('preferences');
  sql.execMigration('001','CREATE TABLE wb_preferences_personal(installation_id TEXT PRIMARY KEY,revision INTEGER NOT NULL,payload TEXT NOT NULL,updated_at TEXT NOT NULL)');
  const own = (id:string) => { if (id !== installationId) fail('PREFERENCES_NOT_FOUND',404); };
  const read = () => sql.get<Row>('SELECT revision,payload FROM wb_preferences_personal WHERE installation_id=?',[installationId]);
  const defaults = ():PersonalPreferences => ({context:null,sorts:{},visual:{theme:'system',density:'comfortable'},notificationPersonId:null});
  const token = (row:Row|null) => row ? `preferences:${installationId}:${row.revision}` : null;
  const write = (revision:number,values:PersonalPreferences) => {
    sql.run('INSERT OR IGNORE INTO wb_preferences_personal(installation_id,revision,payload,updated_at) VALUES(?,?,?,?)',[installationId,revision,JSON.stringify(values),clock.now()]);
    sql.run('UPDATE wb_preferences_personal SET revision=?,payload=?,updated_at=? WHERE installation_id=?',[revision,JSON.stringify(values),clock.now(),installationId]);
  };
  const validateReferences = (values:PersonalPreferences) => {
    const person = values.notificationPersonId;
    if (person && repository.readPublishedHead<DirectoryEntity>({entityType:'directory_entity',id:person})?.kind !== 'person') fail('PREFERENCES_PERSON_INVALID');
    const context = values.context; if (!context) return;
    const path = context.scopePath;
    for (const [key,kind] of [['ditId','dit'],['clusterId','cluster'],['productId','product'],['teamId','team']] as const) if (path[key] && repository.readPublishedHead<DirectoryEntity>({entityType:'directory_entity',id:path[key]!})?.kind !== kind) fail('PREFERENCES_CONTEXT_INVALID');
    const links = repository.readPublishedDirectoryLinks();
    const linked = (kind:string,from:string,to:string|null) => !to || links.some(link => link.kind === kind && 'from' in link && link.from.id === from && link.to.id === to);
    if (!linked('dit_cluster',path.ditId,path.clusterId) || path.clusterId && !linked('cluster_product',path.clusterId,path.productId) || path.clusterId && !linked('cluster_team',path.clusterId,path.teamId) || path.productId && !linked('product_team',path.productId,path.teamId)) fail('PREFERENCES_CONTEXT_INVALID');
    if (context.goalId && !repository.readPublishedHead({entityType:'core_goal_definition',id:context.goalId})) fail('PREFERENCES_CONTEXT_INVALID');
    if (context.resultMode === 'current' && context.snapshotId !== null || context.snapshotId && !repository.readPublishedHead({entityType:'agreed_snapshot',id:context.snapshotId})) fail('PREFERENCES_CONTEXT_INVALID');
  };
  const backupSchema = z.strictObject({schemaVersion:z.literal(1),values:personalPreferencesSchema});
  const service = {
    get(id:string):PersonalPreferences { own(id); const row = read(); return row ? personalPreferencesSchema.parse(JSON.parse(row.payload)) : defaults(); },
    editToken(id:string) { own(id); return token(read()); },
    async set(context:CommandContext,input:{values:PersonalPreferences}):Promise<{values:PersonalPreferences}> {
      own(context.installationId);
      if (context.repository !== repository || context.actor.installationId !== installationId || context.actor.profilePersonId !== context.ownAccess.personId) fail('COMMAND_CONTEXT_MISMATCH',409);
      const values = personalPreferencesSchema.parse(input.values);
      validateReferences(values);
      return commitCommandEffect(context,() => {
        const intent = createCommandStore(repository).get(installationId,context.commandId); if (!intent) return fail('COMMAND_INTENT_MISSING',409);
        const row = read();
        if (JSON.parse(intent.request_json).baseRevision !== token(row)) return fail('REVISION_CONFLICT',409);
        const revision = (row?.revision ?? 0)+1;
        write(revision,values);
        return {result:{values},changedRefs:[],editToken:`preferences:${installationId}:${revision}`};
      }).result;
    },
    backup:{
      describeOwnedData:() => ({namespaces:['preferences.personal']}),
      exportSnapshot:() => ({schemaVersion:1 as const,values:service.get(installationId)}),
      validateRestore:(input:unknown) => { backupSchema.parse(input); },
      restore:(input:unknown) => { const value = backupSchema.parse(input); repository.transaction(() => { write((read()?.revision ?? 0)+1,value.values); }); },
    },
  };
  return service;
}
export type PreferencesService = ReturnType<typeof createPreferencesService>;
