import type { WorkbenchRepository } from '../../../server/storage/workbench-repository';
import type { ValidatedWorkspaceArchive,WorkspaceArchiveCodec,WorkspaceArchiveFileSource,WorkspaceArchiveRecord } from './contracts';
export type ProductionArchiveEnvironment={installationId:string;personId:()=>string|null;localPreview:boolean;subjectRoot:()=>string};
export type ProductionArchiveFileReference={sha256:string;bytes:number;kind:'evidence'|'original'|'module'};
export type ProductionArchiveOwner=WorkspaceArchiveCodec&{
 fileReferences(records:readonly WorkspaceArchiveRecord[]):ProductionArchiveFileReference[];
 files(repository:WorkbenchRepository,records:readonly WorkspaceArchiveRecord[]):Promise<WorkspaceArchiveFileSource[]>;
 authorize(records:readonly WorkspaceArchiveRecord[],personId:string|null,installationId:string):void;
 validateArchive?(archive:ValidatedWorkspaceArchive):void;
 omittedOriginals?(repository:WorkbenchRepository):boolean;
};
