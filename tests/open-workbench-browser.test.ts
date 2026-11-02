import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { inspectSberBrowser, openWorkbenchBrowser, discoverSberBrowsers } from '../scripts/open-workbench-browser.mjs';
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

it('opens only the explicitly configured browser and does not fall back to another installed browser', async () => {
  const notices: string[] = [];
  expect(await openWorkbenchBrowser({ url: 'http://127.0.0.1:5173', notify: (value: string) => notices.push(value) })).toBe(false);
  expect(notices[0]).toContain('СберБраузере');
  await expect(openWorkbenchBrowser({ url: 'https://external.invalid', notify: () => {} })).rejects.toThrow('локального рабочего места');
});

it.runIf(process.platform === 'linux')('probes the configured synthetic binary and passes the local URL as one literal argument', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'uor-browser-')); directories.push(directory);
  const executable = path.join(directory, 'browser with spaces'), received = path.join(directory, 'received.json');
  writeFileSync(executable, `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';\nif(process.argv[2]==='--version')console.log('SberBrowser 152.0.7977.120');else writeFileSync(${JSON.stringify(received)},JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o700 });
  expect(await inspectSberBrowser(executable)).toEqual({ version: '152.0.7977.120' });
  const discovery = await discoverSberBrowsers({ configuredExecutable: executable, searchPath: directory, systemCandidates: [] });
  expect(discovery.candidates).toEqual([{ executablePath: executable, version: '152.0.7977.120', status: 'compatible' }]);
  expect(await openWorkbenchBrowser({ executable, url: 'http://127.0.0.1:5173', notify: () => {} })).toBe(true);
  for (let attempt = 0; attempt < 30 && !existsSync(received); attempt++) await new Promise(resolve => setTimeout(resolve, 20));
  expect(JSON.parse(readFileSync(received, 'utf8'))).toEqual(['http://127.0.0.1:5173']);
  writeFileSync(executable, `#!${process.execPath}\nconsole.log('OtherBrowser 152.0.7977.120');\n`, { mode: 0o700 });
  await expect(inspectSberBrowser(executable)).rejects.toThrow('не подтвердил СберБраузер');
  expect((await discoverSberBrowsers({ configuredExecutable: executable, searchPath: directory, systemCandidates: [] })).candidates[0].status).toBe('unverified');
});
