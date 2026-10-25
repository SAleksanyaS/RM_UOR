export function emptyCatalog():Record<string,unknown>;
export function setupWorkspace(options:{projectRoot:string;mode?:'empty'|'demo';repositoryUrl?:string;publicationMode?:'internal'|'demo-only'}):Promise<{mode:string;projectRoot:string;repositoryConfigured:boolean;publicationMode:string;credentialsFile:string;message:string}>;
