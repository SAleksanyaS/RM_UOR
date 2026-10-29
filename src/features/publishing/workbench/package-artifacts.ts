import { lstat, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { packageManifestSchema, packageRevisionSchema, type PackageArtifactStore, type PackageRevision } from './contracts';
import { assertPhysicalPackagePath, buildPackageManifest, canonicalBytes, hashBytes, integrity, readPhysicalPackageFile, validatePortablePaths } from './package-manifest';

/** Files are staged privately, checked and atomically promoted; completed revisions are immutable. */
export function createPackageArtifactStore({artifactRoot}:{artifactRoot:string}):PackageArtifactStore {
  const root = path.resolve(artifactRoot);
  const directory = (ref:PackageRevision) => { const value=packageRevisionSchema.parse(ref); return path.join(root,value.packageId,String(value.revision)); };
  const read:PackageArtifactStore['readRevision'] = async ref => {
    try {
      const target=directory(ref);
      const manifest=packageManifestSchema.parse(JSON.parse((await readPhysicalPackageFile(path.join(target,'manifest.json'))).toString('utf8')));
      if (Buffer.compare(Buffer.from(canonicalBytes(manifest.packageRevision)),Buffer.from(canonicalBytes(ref))) !== 0) return integrity();
      validatePortablePaths(manifest.files.map(file=>file.path));
      const expected = new Set(['manifest.json',...manifest.files.map(file=>file.path)]);
      const pending = ['']; const found = new Set<string>();
      while (pending.length) {
        const relative=pending.pop()!;
        for (const item of await readdir(path.join(target,relative),{withFileTypes:true})) {
          const name=relative ? relative+'/'+item.name : item.name;
          if (item.isSymbolicLink()) return integrity();
          if (item.isDirectory()) { if (![...expected].some(file=>file.startsWith(name+'/'))) return integrity(); pending.push(name); }
          else if (item.isFile() && expected.has(name)) found.add(name);
          else return integrity();
        }
      }
      if (found.size !== expected.size) return integrity();
      const files = new Map<string,Uint8Array>();
      for (const file of manifest.files) { const bytes=await readPhysicalPackageFile(path.join(target,file.path)); if (bytes.length !== file.bytes || hashBytes(bytes) !== file.sha256) return integrity(); files.set(file.path,bytes); }
      const {contentHash,...base}=ref;
      if (buildPackageManifest({package:base,files}).packageRevision.contentHash !== contentHash) return integrity();
      return files;
    } catch { return integrity(); }
  };
  return {
    readRevision:read,
    async writeRevision(ref,provided) {
      const {contentHash,...base}=packageRevisionSchema.parse(ref);
      const files = new Map([...provided].map(([name,bytes])=>[name,new Uint8Array(bytes)]));
      const manifest=buildPackageManifest({package:base,files});
      if (manifest.packageRevision.contentHash !== contentHash) return integrity();
      await assertPhysicalPackagePath(root,true); await mkdir(root,{recursive:true}); await assertPhysicalPackagePath(root);
      const target=directory(ref); const parent=path.dirname(target);
      await assertPhysicalPackagePath(parent,true); await mkdir(parent,{recursive:true}); await assertPhysicalPackagePath(parent);
      let exists=true;
      try { await lstat(target); } catch(error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; exists=false; }
      if (exists) { await read(ref); return; }
      const staging=path.join(parent,'.staging-'+randomUUID()); await mkdir(staging);
      try {
        for (const [name,bytes] of files) { const filename=path.join(staging,name); await mkdir(path.dirname(filename),{recursive:true}); await assertPhysicalPackagePath(path.dirname(filename)); await writeFile(filename,bytes,{flag:'wx'}); }
        await writeFile(path.join(staging,'manifest.json'),canonicalBytes(manifest),{flag:'wx'});
        try { await rename(staging,target); }
        catch(error) { if (!['EEXIST','ENOTEMPTY','EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; await read(ref); }
        await read(ref);
      } finally {
        // Only this exact generated staging child is eligible for removal.
        if (path.dirname(staging) !== parent || !path.basename(staging).startsWith('.staging-')) return integrity();
        await rm(staging,{recursive:true,force:true});
      }
    },
  };
}
