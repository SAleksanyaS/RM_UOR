import { defineConfig, mergeConfig } from 'vite';
import base from './vite.config';
import { loadOkoConfiguration } from './src/server/workbench/oko-config';

export default defineConfig(async environment => {
  const original = typeof base === 'function' ? await base(environment) : await base;
  const config = await loadOkoConfiguration(process.cwd());
  return mergeConfig(original, { server: { port: config.clientPort, proxy: { '/api': `http://127.0.0.1:${config.port}` } } });
});
