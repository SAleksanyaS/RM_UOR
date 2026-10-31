import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { uuidSchema, type UUIDv4 } from '../../domain/workbench/primitives';
import { validateFileContent } from './file-content-safety';
import { WorkbenchHttpError } from './protocol';
import { fileHandleViewSchema, type FileHandleView } from './file-view';
export { fileHandleViewSchema, type FileHandleView } from './file-view';

export type FilePurpose = 'goal-import' | 'evidence' | 'workspace-restore';
export type StagedFile = FileHandleView & { purpose: FilePurpose; installationId: UUIDv4; profilePersonId?: UUIDv4 | null; bytesValue: Uint8Array };
export type FileLimits = { goalImportBytes: number; evidenceBytes: number; restoreBytes: number; restoreExpandedBytes: number };
export interface FileStore {
  stage(input: { installationId: UUIDv4; profilePersonId?: UUIDv4 | null; purpose: FilePurpose; name: string; mediaType: string; stream: AsyncIterable<Uint8Array> }): Promise<FileHandleView>;
  read(handle: UUIDv4, installationId: UUIDv4, purpose: FilePurpose, profilePersonId?: UUIDv4 | null): Promise<StagedFile>;
}
export const defaultFileLimits: Readonly<FileLimits> = { goalImportBytes: 10 * 1024 ** 2, evidenceBytes: 32 * 1024 ** 2, restoreBytes: 64 * 1024 ** 2, restoreExpandedBytes: 256 * 1024 ** 2 };
export const filePurposeSchema = z.enum(['goal-import', 'evidence', 'workspace-restore']);
const metadataSchema = fileHandleViewSchema.extend({ purpose: filePurposeSchema, installationId: uuidSchema, profilePersonId: uuidSchema.nullable().optional() });
export const fileValidationError = () => new WorkbenchHttpError(422, 'INVALID_FILE', 'The file is invalid or unsupported');
const missing = () => new WorkbenchHttpError(404, 'FILE_NOT_FOUND', 'File not found');
export function assertFileName(name: string): void {
  if (typeof name !== 'string' || !name.trim() || name.length > 255 || /[\x00-\x1f\x7f/\\:]/.test(name) || name === '.' || name === '..' || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) throw fileValidationError();
}
/** Check every physical ancestor too: canonicalization alone hides junctions. */
export async function assertPhysicalPath(target: string, directory: boolean): Promise<void> {
  const absolute = path.resolve(target); const parsed = path.parse(absolute); let current = parsed.root;
  const parts = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]); const info = await lstat(current);
    if (info.isSymbolicLink() || (index < parts.length - 1 || directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1)) throw fileValidationError();
  }
}
export function createFileStore(options: { directory: string; limits: FileLimits }): FileStore {
  const directory = path.resolve(options.directory); const limits = { ...options.limits };
  for (const key of Object.keys(defaultFileLimits) as Array<keyof FileLimits>) if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > defaultFileLimits[key]) throw Error('Invalid server file limits');
  const cap = (purpose: FilePurpose) => purpose === 'goal-import' ? limits.goalImportBytes : purpose === 'evidence' ? limits.evidenceBytes : limits.restoreBytes;
  const root = async () => {
    // Before recursive mkdir, reject existing aliases; only absent suffixes may be created.
    let ancestor = directory; while (true) { try { await assertPhysicalPath(ancestor, true); break; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; const parent = path.dirname(ancestor); if (parent === ancestor) throw fileValidationError(); ancestor = parent; } }
    await mkdir(directory, { recursive: true, mode: 0o700 }); await assertPhysicalPath(directory, true);
    return realpath(directory);
  };
  const verifiedRead = async (filename: string, maxBytes: number) => {
    await assertPhysicalPath(filename, false); const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try { const info = await handle.stat(); if (!info.isFile() || info.nlink !== 1 || info.size > maxBytes) throw fileValidationError(); const bytes = await handle.readFile(); if (bytes.length !== info.size) throw fileValidationError(); return bytes; } finally { await handle.close(); }
  };
  return {
    async stage(input) {
      assertFileName(input.name);
      if (!uuidSchema.safeParse(input.installationId).success || (input.profilePersonId !== undefined && !uuidSchema.nullable().safeParse(input.profilePersonId).success) || !filePurposeSchema.safeParse(input.purpose).success || typeof input.mediaType !== 'string') throw fileValidationError();
      const base = await root(), id = randomUUID(), temporary = path.join(base, '.pending-' + id), final = path.join(base, id);
      await mkdir(temporary, { mode: 0o700 }); let finalized = false;
      try {
        const file = await open(path.join(temporary, 'bytes'), 'wx', 0o600); const hash = createHash('sha256'); let bytes = 0;
        try { for await (const chunk of input.stream) { if (!(chunk instanceof Uint8Array)) throw fileValidationError(); bytes += chunk.byteLength; if (bytes > cap(input.purpose)) throw new WorkbenchHttpError(413, 'FILE_TOO_LARGE', 'The file exceeds the server size limit'); hash.update(chunk); await file.writeFile(chunk); } await file.sync(); } finally { await file.close(); }
        if (!bytes) throw fileValidationError();
        const bytesValue = await verifiedRead(path.join(temporary, 'bytes'), cap(input.purpose));
        const sha256 = hash.digest('hex');
        if (bytesValue.length !== bytes || createHash('sha256').update(bytesValue).digest('hex') !== sha256) throw new WorkbenchHttpError(422, 'INTEGRITY_MISMATCH', 'The staged file failed integrity verification');
        await validateFileContent(input.purpose, input.name, input.mediaType, bytesValue, limits);
        const view: FileHandleView = { fileHandle: id, name: input.name, mediaType: input.mediaType, bytes, sha256 };
        const meta = await open(path.join(temporary, 'metadata.json'), 'wx', 0o600);
        try { await meta.writeFile(JSON.stringify({ ...view, installationId: input.installationId, purpose: input.purpose, ...(input.profilePersonId !== undefined ? { profilePersonId: input.profilePersonId } : {}) })); await meta.sync(); } finally { await meta.close(); }
        await assertPhysicalPath(directory, true); await assertPhysicalPath(temporary, true); await rename(temporary, final); finalized = true;
        return view;
      } finally {
        if (!finalized) {
          // Only the two known files in this invocation's UUID directory are removed.
          await assertPhysicalPath(base, true); await assertPhysicalPath(temporary, true);
          for (const name of ['bytes', 'metadata.json']) await unlink(path.join(temporary, name)).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
          await rmdir(temporary);
        }
      }
    },
    async read(handle, installationId, purpose, profilePersonId) {
      if (!uuidSchema.safeParse(handle).success || !uuidSchema.safeParse(installationId).success || !filePurposeSchema.safeParse(purpose).success) throw missing();
      try {
        const base = await root(); const stored = path.join(base, handle);
        const parsed = metadataSchema.safeParse(JSON.parse((await verifiedRead(path.join(stored, 'metadata.json'), 32768)).toString('utf8')));
        if (!parsed.success) throw fileValidationError(); const metadata = parsed.data;
        if (metadata.installationId !== installationId || metadata.purpose !== purpose || (metadata.profilePersonId !== undefined && metadata.profilePersonId !== profilePersonId)) throw missing();
        if (metadata.fileHandle !== handle || metadata.bytes > cap(purpose)) throw fileValidationError(); assertFileName(metadata.name);
        const bytes = await verifiedRead(path.join(stored, 'bytes'), cap(purpose));
        if (bytes.length !== metadata.bytes || createHash('sha256').update(bytes).digest('hex') !== metadata.sha256) throw new WorkbenchHttpError(422, 'INTEGRITY_MISMATCH', 'The staged file failed integrity verification');
        await validateFileContent(purpose, metadata.name, metadata.mediaType, bytes, limits);
        return { ...metadata, bytesValue: Uint8Array.from(bytes) };
      } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw missing(); if (error instanceof WorkbenchHttpError) throw error; throw fileValidationError(); }
    },
  };
}
