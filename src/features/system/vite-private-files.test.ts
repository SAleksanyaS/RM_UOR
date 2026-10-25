import { afterEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, normalizePath, type ViteDevServer } from 'vite';
import configFactory from '../../../vite.config';

const roots: string[] = [], servers: ViteDevServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it('serves the application but blocks private local files through direct, raw and absolute filesystem requests', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'uor-vite-private-')); roots.push(root);
  const privatePaths = ['.runtime/local-config/curators.input.json', '.runtime/local-config/curators.json', '.runtime/app.db', '.runtime/exports/private.zip',
    'config/site.local.json', 'config/connectors.local.json', 'credentials.json', 'secrets.json', 'client.key', 'client.pfx', 'client.p12', 'archive.bundle',
    '.env', '.env.local', '.git/config', 'client.pem', 'client.crt'];
  for (const relative of privatePaths) {
    const target = path.join(root, relative); await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, relative === 'config/site.local.json' ? JSON.stringify({ port: 1, clientPort: 0, syntheticPrivateMarker: 'synthetic-private-content' }) : 'synthetic-private-content');
  }
  await writeFile(path.join(root, 'index.html'), '<!doctype html><html><head><title>Synthetic safe index</title></head><body>synthetic-safe-content</body></html>');
  const previousDirectory = process.cwd(); let config;
  try { process.chdir(root); config = await configFactory({ command: 'serve', mode: 'development' }); }
  finally { process.chdir(previousDirectory); }
  const server = await createServer({ ...config, configFile: false, root, publicDir: false, cacheDir: path.join(root, '.vite-cache'), logLevel: 'silent',
    optimizeDeps: { noDiscovery: true, include: [] }, server: { ...config.server, host: '127.0.0.1', port: 0, strictPort: false, proxy: undefined } });
  servers.push(server); await server.listen();
  const address = server.httpServer!.address(); if (!address || typeof address === 'string') throw new Error('Test server did not bind a temporary TCP port');
  const origin = `http://127.0.0.1:${address.port}`, safe = await fetch(`${origin}/index.html`);
  expect(safe.status).toBe(200); expect(await safe.text()).toContain('synthetic-safe-content');
  const exposed: { request: string; status: number; disclosed: boolean }[] = [];
  for (const relative of privatePaths) {
    for (const urlPath of [`/${relative}`, `/${relative}?raw`, `/@fs/${normalizePath(path.join(root, relative))}`, `/@fs/${normalizePath(path.join(root, relative))}?raw`]) {
      const response = await fetch(`${origin}${urlPath}`), body = await response.text();
      if (![403, 404].includes(response.status) || body.includes('synthetic-private-content')) exposed.push({ request: urlPath, status: response.status, disclosed: body.includes('synthetic-private-content') });
    }
  }
  expect(exposed).toEqual([]);
}, 30000);
