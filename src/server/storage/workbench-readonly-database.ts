import { lstatSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { WorkbenchError } from '../../domain/workbench/errors';

/** Offline inspection under the runtime lease, never a replacement for WAL recovery.
 * SQLite's ordinary readOnly connection can create WAL/SHM sidecars. Immutable URI
 * mode avoids those writes, but must never ignore retained uncheckpointed history. */
export function openReadonlyWorkbenchDatabase(filename: string): DatabaseSync {
  if (filename === ':memory:') throw new WorkbenchError('READ_ONLY_FILE_REQUIRED');
  for (const suffix of ['-wal', '-journal']) {
    try {
      const file = lstatSync(filename + suffix);
      if (file.isSymbolicLink() || !file.isFile() || file.size !== 0) throw new WorkbenchError('READ_ONLY_RECOVERY_REQUIRED');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const uri = pathToFileURL(path.resolve(filename)); uri.search = '?mode=ro&immutable=1';
  return new DatabaseSync(uri.href, { readOnly: true });
}
