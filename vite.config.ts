import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
export default defineConfig(async () => {
  let site = { port: 4174, clientPort: 5173 };
  try { site = { ...site, ...JSON.parse(await readFile(path.join(process.cwd(), 'config/site.local.json'), 'utf8')) }; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return { plugins: [react()], server: { host: '127.0.0.1', port: site.clientPort, strictPort: true, proxy: { '/api': `http://127.0.0.1:${site.port}` } }, build: { outDir: 'dist' } };
});
