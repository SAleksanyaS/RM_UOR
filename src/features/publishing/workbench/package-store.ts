import type { EntityRef, VersionRef } from '../../../domain/workbench/primitives';
import { newUuid } from '../../../domain/workbench/primitives';
import type { CommandContext } from '../../../server/workbench/command-registry';
import type { QueryContext } from '../../../server/workbench/query-registry';
import type { WorkbenchRepository } from '../../../server/storage/workbench-repository';
import { WorkbenchHttpError } from '../../../server/workbench/protocol';
import type { DraftService } from '../../catalog/workbench-drafts';
import { publicationPackageRecordSchema, packagePreviewResultSchema, type PackagePreviewResult, type PublicationPackageRecord } from './contracts';

type Identity = Pick<QueryContext,'repository'|'installationId'|'ownAccess'>;
export type PreviewBinding = {repositoryId:string;mainCommit:string;draftRevision:number;fingerprint:string};
export type Reservation = {revision:number;cycleId:string;createdAt:string};
export type TokenRecord = {binding:PreviewBinding;result:PackagePreviewResult};
type Row = {payload:string};
export interface PublicationReadPort {
  readOwnPackage(context:Identity,packageId:string):PublicationPackageRecord|null;
  listOwnPackages(context:Identity):PublicationPackageRecord[];
}
export function createPackageStore(repository:WorkbenchRepository,drafts:DraftService) {
  const sql=repository.sqlForModule('publishing');
  const technical=repository.sqlForModule('publishing',{trackStateRevision:false});
  sql.execMigration('preview-001',`
    CREATE TABLE wb_publishing_reservations(package_id TEXT NOT NULL,installation_id TEXT NOT NULL,person_id TEXT NOT NULL,revision INTEGER NOT NULL,fingerprint TEXT NOT NULL,cycle_id TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(package_id,revision),UNIQUE(package_id,fingerprint));
    CREATE TABLE wb_publishing_packages(package_id TEXT NOT NULL,installation_id TEXT NOT NULL,person_id TEXT NOT NULL,revision INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(package_id,revision));
    CREATE INDEX wb_publishing_own_packages ON wb_publishing_packages(installation_id,person_id,package_id,revision);
    CREATE TABLE wb_publishing_tokens(token TEXT PRIMARY KEY,package_id TEXT NOT NULL,installation_id TEXT NOT NULL,person_id TEXT NOT NULL,payload TEXT NOT NULL);
    CREATE INDEX wb_publishing_own_tokens ON wb_publishing_tokens(package_id,installation_id,person_id);
  `);
  const own=(context:Identity,packageId:string)=>drafts.readOwnPackage(context,packageId);
  const latest=(context:Identity,packageId:string):PublicationPackageRecord|null=>{
    own(context,packageId);
    const row=sql.get<Row>('SELECT payload FROM wb_publishing_packages WHERE package_id=? AND installation_id=? AND person_id=? ORDER BY revision DESC LIMIT 1',[packageId,context.installationId,context.ownAccess.personId]);
    return row?publicationPackageRecordSchema.parse(JSON.parse(row.payload)):null;
  };
  return {
    readPort:{
      readOwnPackage:latest,
      listOwnPackages(context:Identity) {
        if(context.repository!==repository) throw new WorkbenchHttpError(409,'COMMAND_CONTEXT_MISMATCH','Wrong repository');
        return sql.all<Row>('SELECT payload FROM wb_publishing_packages p WHERE installation_id=? AND person_id=? AND revision=(SELECT MAX(revision) FROM wb_publishing_packages q WHERE q.package_id=p.package_id) ORDER BY package_id',[context.installationId,context.ownAccess.personId]).map(row=>publicationPackageRecordSchema.parse(JSON.parse(row.payload)));
      },
    } satisfies PublicationReadPort,
    reserve(context:CommandContext,packageId:string,fingerprint:string):Reservation {
      own(context,packageId);
      return repository.transaction(()=>{
        const old=technical.get<{revision:number;cycle_id:string;created_at:string}>('SELECT revision,cycle_id,created_at FROM wb_publishing_reservations WHERE package_id=? AND installation_id=? AND person_id=? AND fingerprint=?',[packageId,context.installationId,context.ownAccess.personId,fingerprint]);
        if(old) return {revision:old.revision,cycleId:old.cycle_id,createdAt:old.created_at};
        const previous=technical.get<{revision:number;cycle_id:string}>('SELECT revision,cycle_id FROM wb_publishing_reservations WHERE package_id=? ORDER BY revision DESC LIMIT 1',[packageId]);
        const value={revision:(previous?.revision??0)+1,cycleId:previous?.cycle_id??newUuid(),createdAt:context.clock.now()};
        technical.run('INSERT INTO wb_publishing_reservations(package_id,installation_id,person_id,revision,fingerprint,cycle_id,created_at) VALUES(?,?,?,?,?,?,?)',[packageId,context.installationId,context.ownAccess.personId,value.revision,fingerprint,value.cycleId,value.createdAt]);
        return value;
      });
    },
    token(context:Identity,packageId:string,token:string):TokenRecord|null {
      own(context,packageId);
      const row=technical.get<Row>('SELECT payload FROM wb_publishing_tokens WHERE token=? AND package_id=? AND installation_id=? AND person_id=?',[token,packageId,context.installationId,context.ownAccess.personId]);
      return row?JSON.parse(row.payload) as TokenRecord:null;
    },
    prior(context:Identity,packageId:string,fingerprint:string):TokenRecord|null {
      own(context,packageId);
      const rows=technical.all<Row>('SELECT payload FROM wb_publishing_tokens WHERE package_id=? AND installation_id=? AND person_id=? ORDER BY rowid DESC',[packageId,context.installationId,context.ownAccess.personId]);
      return rows.map(row=>JSON.parse(row.payload) as TokenRecord).find(row=>row.binding.fingerprint===fingerprint)??null;
    },
    commit(context:CommandContext,packageId:string,binding:PreviewBinding,result:PackagePreviewResult,refs:VersionRef[]) {
      const previous=latest(context,packageId); const value=publicationPackageRecordSchema.parse({
        schemaVersion:1,id:packageId,revision:(previous?.revision??0)+1,recordedAt:context.clock.now(),actor:context.actor,publicationAnchorId:null,
        cycleId:result.packageRevision.cycleId,curatorPersonId:context.ownAccess.personId,state:result.errors.length?'draft':'preview_ready',current:result.packageRevision,sent:previous?.sent??null,proposal:previous?.proposal??null,draftRefs:refs,
      });
      const checked=packagePreviewResultSchema.parse(result);
      sql.run('INSERT INTO wb_publishing_packages(package_id,installation_id,person_id,revision,payload) VALUES(?,?,?,?,?)',[packageId,context.installationId,context.ownAccess.personId,value.revision,JSON.stringify(value)]);
      technical.run('INSERT OR IGNORE INTO wb_publishing_tokens(token,package_id,installation_id,person_id,payload) VALUES(?,?,?,?,?)',[result.previewToken,packageId,context.installationId,context.ownAccess.personId,JSON.stringify({binding,result:checked})]);
      return {entityType:'publication_package',id:packageId} satisfies EntityRef;
    },
  };
}
