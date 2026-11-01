import assert from 'node:assert/strict';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Test-only installed browser selection. An explicit path never falls back to another browser. */
export function testBrowserSelection(channel: 'msedge' | 'chrome' = 'msedge') {
  const executablePath = process.env.UOR_TEST_BROWSER_EXECUTABLE;
  return executablePath ? { executablePath, channel: undefined } : { channel };
}

/** Legacy entrypoints without a launcher port still execute the exact installed native browser. */
export async function testHeadlessBrowserSelection(directory: string) {
  const selection = testBrowserSelection();
  if (!selection.executablePath || process.platform === 'win32') return selection;
  await access(selection.executablePath);
  const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
  const executablePath = path.join(directory, 'owned-native-headless.sh');
  const argumentsPath = path.join(directory, 'owned-native-arguments.txt');
  await writeFile(executablePath, '#!/bin/sh\n' +
    `printf '%s\\n' ${quote('BEGIN LEGACY NATIVE TEST')} ${quote(selection.executablePath)} '--headless' "$@" >> ${quote(argumentsPath)}\n` +
    `exec ${quote(selection.executablePath)} --headless "$@"\n`, { mode: 0o700, flag: 'wx' });
  return { executablePath, channel: undefined };
}

export async function verifyLegacyNativeArguments(directory: string, label: string) {
  if (!process.env.UOR_TEST_BROWSER_EXECUTABLE || process.platform === 'win32') return;
  assert.match(label, /^[a-z-]+$/);
  const args = await readFile(path.join(directory, 'owned-native-arguments.txt'), 'utf8');
  assert.ok(args.includes(process.env.UOR_TEST_BROWSER_EXECUTABLE));
  assert.ok(args.includes('--headless\n'));
  assert.doesNotMatch(args, /--no-sandbox|--ignore-certificate-errors/);
  const proof = path.resolve('.runtime/validation/workbench/continuation/native-legacy');
  await mkdir(proof, { recursive: true });
  await writeFile(path.join(proof, label + '.txt'), args);
}
