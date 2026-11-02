import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { Download } from 'playwright';
import { privateProfileSchema } from './contracts';
import { completedBrowserDownload } from './workbench-browser-recorder';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const profile = privateProfileSchema.parse({ allowedOrigins: ['https://report.example.invalid'] });

it.each(['completed', 'partial', 'different-guid', 'non-guid'] as const)('handles the rebased native download path without accepting %s as another completed artifact', async mode => {
  const root = await mkdtemp(path.join(tmpdir(), 'uor-download-path-')); roots.push(root);
  const directory = path.join(root, randomUUID()), guid = randomUUID(); await mkdir(directory);
  const nativeName = mode === 'non-guid' ? 'arbitrary.csv' : guid;
  const stagedName = mode === 'partial' ? guid + '.crdownload' : mode === 'different-guid' ? randomUUID() : nativeName;
  await writeFile(path.join(directory, stagedName), 'ID;Value\nr1;42');
  const nativePath = path.join(root, 'launch-time-directory', nativeName);
  const file = { path: async () => nativePath, suggestedFilename: () => 'report.csv' } as Download;
  const result = completedBrowserDownload(file, profile, { directory, since: Date.now(), idleMs: 1 });
  if (mode === 'completed') expect((await result).bytes.toString()).toBe('ID;Value\nr1;42');
  else await expect(result).rejects.toMatchObject({ code: 'incomplete', reason: 'DOWNLOAD_NO_PROGRESS' });
});
