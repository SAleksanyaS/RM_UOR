import {lstat,realpath} from 'node:fs/promises';
import path from 'node:path';
import {safeArtifactPath} from '../../server/workspace/paths';
/** Portable/cleanup files must be physical paths, never aliases into another private folder. */
export async function physicalArtifactPath(root:string,relative:string){const canonical=await realpath(root);if(path.isAbsolute(relative)||relative.includes('\\')||relative.includes(':')||relative.split('/').some(part=>!part||part==='.'||part==='..'))throw new Error('Недопустимый физический путь');let current=canonical;for(const part of relative.split('/')){current=path.join(current,part);try{const info=await lstat(current);if(info.isSymbolicLink()||info.isFile()&&info.nlink>1)throw new Error('Ссылки и общие файловые алиасы в переносе/очистке запрещены');}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')break;throw error;}}return safeArtifactPath(canonical,relative);}
