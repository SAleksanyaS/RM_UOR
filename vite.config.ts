import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { privateDevServerDeny } from './scripts/vite-private-files';
export default defineConfig(async () => {
  let site = { port: 4174, clientPort: 5173 };
  try { site = { ...site, ...JSON.parse(await readFile(path.join(process.cwd(), 'config/site.local.json'), 'utf8')) }; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return { plugins: [react()], cacheDir: path.join(process.cwd(), '.runtime', 'vite-cache'), server: { host: '127.0.0.1', port: site.clientPort, strictPort: true, proxy: { '/api': `http://127.0.0.1:${site.port}` },
    fs: { strict: true, deny: [...privateDevServerDeny] } }, build: { outDir: 'dist', rollupOptions: { input: { app: path.resolve(process.cwd(), 'index.html'), oko: path.resolve(process.cwd(), 'oko.html') } } } };
});
