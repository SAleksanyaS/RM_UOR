import { createReadStream } from 'node:fs';
import { mkdtemp, open, rmdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyRequest } from 'fastify';
import { assertFileName, assertPhysicalPath, defaultFileLimits, filePurposeSchema, fileValidationError, type FileStore } from './files';
import { WorkbenchHttpError } from './protocol';

/** Private bounded spool permits purpose before or after the file, with no durable handle until EOF. */
export async function withMultipartUpload<T>(request: FastifyRequest, accept: (input: Omit<Parameters<FileStore['stage']>[0], 'installationId'>) => Promise<T>): Promise<T> {
  if (!request.isMultipart()) throw new WorkbenchHttpError(422, 'VALIDATION_FAILED', 'Use one multipart file and purpose');
  const temporaryRoot = tmpdir(); await assertPhysicalPath(temporaryRoot, true);
  const directory = await mkdtemp(path.join(temporaryRoot, 'uor-private-upload-')), filename = path.join(directory, 'bytes');
  let purpose: ReturnType<typeof filePurposeSchema.parse> | undefined, name: string | undefined, mediaType: string | undefined, count = 0;
  try {
    for await (const part of request.parts({ preservePath: true, limits: { files: 1, fields: 1, parts: 2, fileSize: defaultFileLimits.restoreBytes, fieldSize: 32, fieldNameSize: 20, headerPairs: 16 } })) {
      if (part.type === 'field') {
        if (part.fieldname !== 'purpose' || purpose !== undefined || part.fieldnameTruncated || part.valueTruncated) throw fileValidationError();
        const parsed = filePurposeSchema.safeParse(part.value); if (!parsed.success) throw fileValidationError(); purpose = parsed.data;
      } else {
        if (++count !== 1 || part.fieldname !== 'file') { part.file.resume(); throw fileValidationError(); }
        assertFileName(part.filename); name = part.filename; mediaType = part.mimetype;
        const spool = await open(filename, 'wx', 0o600); let bytes = 0;
        try { for await (const chunk of part.file) { bytes += chunk.length; if (bytes > defaultFileLimits.restoreBytes) throw new WorkbenchHttpError(413, 'FILE_TOO_LARGE', 'The file exceeds the server size limit'); await spool.writeFile(chunk); } } finally { await spool.close(); }
        if (part.file.truncated) throw new WorkbenchHttpError(413, 'FILE_TOO_LARGE', 'The file exceeds the server size limit');
      }
    }
    if (!purpose || !name || !mediaType || count !== 1 || request.raw.aborted) throw fileValidationError();
    await assertPhysicalPath(filename, false);
    return await accept({ purpose, name, mediaType, stream: createReadStream(filename) });
  } catch (error) {
    if (error instanceof WorkbenchHttpError) throw error;
    if ((error as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') throw new WorkbenchHttpError(413, 'FILE_TOO_LARGE', 'The file exceeds the server size limit');
    throw fileValidationError();
  } finally {
    await assertPhysicalPath(directory, true); await unlink(filename).catch(error => { if (error.code !== 'ENOENT') throw error; }); await rmdir(directory);
  }
}
