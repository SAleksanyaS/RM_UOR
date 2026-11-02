import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { describeLaunchFailure, inspectBrowserEnvironment, launchHint, safeErrorDetail } from './workbench-browser-diagnostics';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function folder(): Promise<string> { const root = await mkdtemp(path.join(os.tmpdir(), 'uor-browser-diagnostics-')); roots.push(root); return root; }

it('distinguishes a directory, a missing binary and a runnable executable', async () => {
  const root = await folder(), executable = path.join(root, 'browser');
  const missing = await inspectBrowserEnvironment({ executablePath: executable, profileDirectory: 'oko', headless: false });
  expect(missing.executable).toEqual({ exists: false, isFile: false, executable: false, directory: false, mode: null });
  expect(describeLaunchFailure(Error('spawn ENOENT'), missing)).toMatchObject({ reason: 'EXECUTABLE_NOT_EXECUTABLE', detail: expect.stringContaining('executable_missing') });
  await writeFile(executable, '#!/bin/sh\nexit 0\n'); await chmod(executable, 0o755);
  const file = await inspectBrowserEnvironment({ executablePath: executable, profileDirectory: 'oko', headless: false });
  expect(file.executable).toMatchObject({ exists: true, isFile: true, executable: true, directory: false });
  expect(file.sandbox.chromeSandbox).toBe(path.join(root, 'chrome-sandbox'));
});

it('reports sandbox denial, dependencies and protocol loss as separate reasons', async () => {
  const root = await folder(), executable = path.join(root, 'browser');
  await writeFile(executable, ''); await chmod(executable, 0o755);
  const environment = await inspectBrowserEnvironment({ executablePath: executable, profileDirectory: 'oko', headless: false });
  expect(describeLaunchFailure(Error('Running as root without --no-sandbox is not supported. See https://crbug.com/638180.'), environment).reason).toBe('SANDBOX_DENIED');
  expect(describeLaunchFailure(Error('No usable sandbox! Update your kernel'), environment).reason).toBe('SANDBOX_DENIED');
  expect(describeLaunchFailure(Error('error while loading shared libraries: libnss3.so'), environment).reason).toBe('MISSING_DEPENDENCY');
  expect(describeLaunchFailure(Error('Target page, context or browser has been closed'), environment).reason).toBe('BROWSER_PROTOCOL_MISMATCH');
  expect(describeLaunchFailure(Error('Profile is already in use (SingletonLock)'), environment).reason).toBe('PROFILE_LOCKED');
  expect(describeLaunchFailure(Error('Synthetic transport failure'), environment)).toMatchObject({ reason: 'BROWSER_LAUNCH_FAILED', detail: 'BROWSER_OPERATION_FAILED' });
});

it('keeps host paths and URLs out of the user-visible detail', async () => {
  const root = await folder();
  const environment = await inspectBrowserEnvironment({ executablePath: path.join(root, 'browser'), profileDirectory: 'oko', headless: false });
  const detail = describeLaunchFailure(Error('Failed to launch /home/user/secret/browser at https://internal.example/report'), environment).detail;
  expect(detail).not.toContain('/home/user/secret');
  expect(detail).not.toContain('https://internal.example');
  expect(safeErrorDetail('boom at https://oko.example/report and /var/lib/profile')).toBe('BROWSER_OPERATION_FAILED');
  expect(launchHint('SANDBOX_DENIED', environment)).toContain('probe:sberbrowser');
});

it('never reflects canary credentials, identity, field values or Windows paths in default details',()=>{
 const secret='CanaryToken123';for(const input of [`Bearer ${secret}`,`password=${secret}`,`C:\\Users\\PrivateName\\profile`, `Cookie: sid=${secret}`,`user@example.invalid ${secret}`])expect(safeErrorDetail(input)).not.toMatch(/CanaryToken123|PrivateName|user@example/);
});
