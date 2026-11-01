import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createBrowserIntegrationHarness } from './fixtures/workbench/browser-integration';

it('native_ui_host_denies_synthetic_private_files_direct_raw_and_absolute', async () => {
  const parent = path.resolve('tests/fixtures/workbench');
  const directory = await mkdtemp(path.join(parent, 't47-private-http-'));
  const sentinel = 'SYNTHETIC_T47_PRIVATE_HTTP_SENTINEL';
  const files = ['.runtime/result.log', 'config/site.local.json', '.env', '.env.test', 'certificate.pem', 'certificate.crt', 'private.key', 'private.pfx', 'private.p12', 'private.bundle', 'credentials-test.json', 'secrets-test.json', 'curators-test.json', '.git/config'];
  let harness: Awaited<ReturnType<typeof createBrowserIntegrationHarness>> | undefined;
  try {
    for (const file of files) { const target = path.join(directory, file); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, sentinel, { flag: 'wx' }); }
    harness = await createBrowserIntegrationHarness();
    const ui = await harness.curator.openUi();
    await ui.page.getByRole('button', { name: 'Выбрать признак открытого отчёта' }).waitFor();
    for (const file of files) {
      const absolute = path.join(directory, file).replaceAll('\\', '/');
      const relative = '/' + path.relative(process.cwd(), absolute).replaceAll('\\', '/');
      for (const url of [relative, relative + '?raw', '/@fs/' + absolute]) {
        const response = await fetch(ui.origin + url);
        expect(response.status, url).toBe(403);
        expect(await response.text(), url).not.toContain(sentinel);
      }
    }
  } finally {
    await harness?.close();
    if (path.dirname(directory) !== parent || !path.basename(directory).startsWith('t47-private-http-')) throw Error('Unexpected sentinel directory');
    await rm(directory, { recursive: true, force: true });
  }
}, 60000);
