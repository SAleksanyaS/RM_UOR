import { createHash } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { WorkbenchHttpError } from '../../../server/workbench/protocol';
import { packageRevisionSchema, type PackageManifest, type PackageRevision } from './contracts';

export const integrity = ():never => { throw new WorkbenchHttpError(422,'INTEGRITY_MISMATCH','Package integrity validation failed'); };
export const hashBytes = (bytes:Uint8Array):string => createHash('sha256').update(bytes).digest('hex');
export function canonicalBytes(value:unknown):Uint8Array {
  const ancestors = new Set<object>();
  const encode = (item:unknown):string => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'number') { if (!Number.isFinite(item) || !Number.isSafeInteger(item)) return integrity(); return JSON.stringify(item); }
    if (typeof item !== 'object' || ancestors.has(item)) return integrity();
    ancestors.add(item);
    try {
      if (Array.isArray(item)) { if (Object.keys(item).length !== item.length) return integrity(); return '['+item.map(encode).join(',')+']'; }
      if (![Object.prototype,null].includes(Object.getPrototypeOf(item))) return integrity();
      return '{'+Object.keys(item).sort().map(key=>JSON.stringify(key)+':'+encode((item as Record<string,unknown>)[key])).join(',')+'}';
    } finally { ancestors.delete(item); }
  };
  return Buffer.from(encode(value),'utf8');
}
export function validatePortablePaths(paths:readonly string[]):void {
  const aliases = new Set<string>();
  for (const name of paths) {
    if (typeof name !== 'string' || name === 'manifest.json' || path.posix.isAbsolute(name) || name.includes('\\') || /[<>:"|?*\x00-\x1f\x7f]/.test(name) || name.split('/').some(part=>!part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) return integrity();
    const alias = name.normalize('NFC').toLowerCase(); if (aliases.has(alias)) return integrity(); aliases.add(alias);
  }
}
export function buildPackageManifest(input:{package:Omit<PackageRevision,'contentHash'>;files:ReadonlyMap<string,Uint8Array>}):PackageManifest {
  const {contentHash:ignored,...base} = packageRevisionSchema.parse({...input.package,contentHash:'sha256:'+'0'.repeat(64)});
  validatePortablePaths([...input.files.keys()]);
  const files = [...input.files].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([name,bytes])=>({path:name,sha256:hashBytes(bytes),bytes:bytes.byteLength}));
  return {packageRevision:{...base,contentHash:`sha256:${hashBytes(canonicalBytes({package:base,files}))}`},files};
}
/** Reject every alias component, including junctions above the nominal root. */
export async function assertPhysicalPackagePath(filename:string,allowMissing=false):Promise<void> {
  const absolute = path.resolve(filename); const parsed = path.parse(absolute); let current=parsed.root;
  for (const component of absolute.slice(parsed.root.length).split(path.sep)) {
    current=path.join(current,component);
    let stat;
    try { stat=await lstat(current); }
    catch(error) { if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    if (stat.isSymbolicLink() || stat.isFile() && stat.nlink !== 1) return integrity();
  }
  const actual = await realpath(absolute);
  if (actual.toLowerCase() !== absolute.toLowerCase()) return integrity();
}
export async function readPhysicalPackageFile(filename:string):Promise<Buffer> {
  await assertPhysicalPackagePath(filename);
  const handle = await open(filename,constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try { const stat=await handle.stat(); if (!stat.isFile() || stat.nlink !== 1 || stat.size > 32*1024*1024) return integrity(); const bytes=await handle.readFile(); if (bytes.byteLength !== stat.size) return integrity(); return bytes; }
  finally { await handle.close(); }
}
export async function validatePackageFiles(input:{root:string;paths:string[];publicationMode:'demo-only'|'internal'}):Promise<void> {
  validatePortablePaths(input.paths);
  if (!['demo-only','internal'].includes(input.publicationMode)) return integrity();
  await assertPhysicalPackagePath(input.root);
  for (const name of input.paths) {
    const record = /^records\/([a-z][a-z0-9_]*)\/[a-f0-9-]{36}\/[1-9][0-9]*\.json$/.test(name);
    const artifact = /^artifacts\/[a-f0-9]{64}$/.test(name);
    if (!record && (!artifact || input.publicationMode !== 'internal')) return integrity();
    await readPhysicalPackageFile(path.join(input.root,name));
  }
}
