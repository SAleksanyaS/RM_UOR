/** Exact extracted content of the approved Node 22.16.0 Linux x64 archive. */
import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { lstat, readdir, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';

// Independently derived directly from the archive pinned by package-prepared-linux.mjs.
// Descendants only, UTF-8 byte-sorted paths, compact JSON arrays, no newline:
// [path,'directory',mode], [path,'file',mode,size,sha256], [path,'symlink',mode,target].
// Modes include special bits; the official tree has none. The owned root is omitted.
export const pinnedNodeTreeSha256 = '943fedffb513cc78f59e694bb806a137ced7f34dd0471fcb2b181510387ecc27';
const maximumEntries = 10_000, maximumBytes = 512 * 1024 * 1024;
const inside = (root, file) => { const relative = path.relative(root, file); return relative === '' || !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep); };

/** Never edits/deletes mismatches or follows symlinks while collecting content. */
export async function verifyPreparedRuntime(directory, expectedSha256 = pinnedNodeTreeSha256) {
  if (!/^[a-f0-9]{64}$/.test(expectedSha256)) throw Error('Expected runtime tree SHA-256 is invalid.');
  const root = path.resolve(directory);
  if (await realpath(root) !== root || !(await lstat(root)).isDirectory()) throw Error('Prepared runtime must be a physical directory.');
  const records = [], summary = { sha256: '', entries: 0, files: 0, directories: 0, symlinks: 0, bytes: 0 };
  async function visit(relative = '') {
    for (const name of await readdir(path.join(root, relative))) {
      if (/[\\:\x00-\x1f\x7f]/.test(name)) throw Error('Prepared runtime contains an unsafe name.');
      const child = relative ? relative + '/' + name : name, file = path.join(root, child), info = await lstat(file), mode = info.mode & 0o7777;
      if (++summary.entries > maximumEntries || mode & ~0o777) throw Error('Prepared runtime exceeds its entry/permission bounds.');
      if (info.isDirectory()) {
        records.push([child, 'directory', mode]); summary.directories++; await visit(child);
      } else if (info.isSymbolicLink()) {
        const target = await readlink(file);
        if (!target || path.isAbsolute(target) || /[\\:\x00-\x1f\x7f]/.test(target) || !inside(root, path.resolve(path.dirname(file), target))) throw Error('Prepared runtime contains an unsafe symlink.');
        records.push([child, 'symlink', mode, target]); summary.symlinks++;
      } else if (info.isFile() && info.nlink === 1) {
        summary.bytes += info.size;
        if (summary.bytes > maximumBytes) throw Error('Prepared runtime exceeds its byte bound.');
        const hash = createHash('sha256'); let read = 0;
        for await (const bytes of createReadStream(file, { flags: constants.O_RDONLY | constants.O_NOFOLLOW })) {
          read += bytes.length; if (read > info.size) throw Error('Prepared runtime changed during verification.'); hash.update(bytes);
        }
        if (read !== info.size) throw Error('Prepared runtime changed during verification.');
        records.push([child, 'file', mode, info.size, hash.digest('hex')]); summary.files++;
      } else throw Error('Prepared runtime contains a special or hard-linked file.');
    }
  }
  await visit();
  records.sort((left, right) => Buffer.compare(Buffer.from(left[0]), Buffer.from(right[0])));
  summary.sha256 = createHash('sha256').update(JSON.stringify(records), 'utf8').digest('hex');
  if (summary.sha256 !== expectedSha256) throw Error('Prepared runtime does not match the pinned official tree.');
  return summary;
}
