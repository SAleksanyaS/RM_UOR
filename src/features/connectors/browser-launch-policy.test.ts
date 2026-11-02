import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { openBrowser, type BrowserLaunchOptions } from './browser';
import { privateProfileSchema } from './contracts';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

it.each([
  { channel: 'msedge', profileDirectory: 'synthetic-edge' },
  { executablePath: '/synthetic/chrome', profileDirectory: 'synthetic-chrome' },
])('requires Chromium sandbox for $profileDirectory and never retries a denied launch', async browser => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'uor-launch-policy-')); roots.push(root);
  const attempts: BrowserLaunchOptions[] = [];
  const profile = privateProfileSchema.parse({ allowedOrigins: ['https://report.example.invalid'], browser });
  await expect(openBrowser(root, profile, { launcher: { async launchPersistent(_profile, _folder, options) {
    attempts.push(options);
    throw Error('Synthetic host sandbox denial');
  } } })).rejects.toMatchObject({ code: 'browser_launch' });
  await expect(openBrowser(root, profile, { launcher: { async launchPersistent() { throw Error('Running as root without --no-sandbox is not supported'); } } })).rejects.toMatchObject({ code: 'browser_launch' });
  expect(attempts).toHaveLength(1);
  expect(attempts[0].chromiumSandbox).toBe(true);
  expect(attempts[0].args ?? []).not.toContain('--no-sandbox');
  expect(attempts[0].ignoreHTTPSErrors).toBe(false);
  // Fresh report launches block service workers. Explicit login uses a separate
  // phase and must pass the native worker retirement barrier before report replay.
  expect(attempts[0].serviceWorkers).toBe('block');
});
