import { it, expect } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prepareEmptyProductionRoot } from './production-entry';

it('refuses a nonempty smoke root before changing any bytes', async () => {
  const root = await mkdtemp(path.join(realpathSync.native(tmpdir()), 't39-smoke-guard-'));
  try {
    await writeFile(path.join(root, 'user-data'), 'preserve exactly');
    await expect(prepareEmptyProductionRoot(root)).rejects.toThrow('empty');
    expect(await readFile(path.join(root, 'user-data'), 'utf8')).toBe('preserve exactly');
  } finally { await rm(root, { recursive: true, force: true }); }
});
