import { defineConfig } from 'vitest/config';
export default defineConfig({
  // Node 22.16 supports node:sqlite, but omits this prefix-only builtin from
  // builtinModules. Keep real SQLite in mixed jsdom/API tests on Vitest 4;
  // no browser polyfill or production bundler setting is involved.
  plugins: [{ name: 'uor-native-sqlite-tests', enforce: 'pre', resolveId(id) { if (id === 'node:sqlite') return { id, external: true }; } }],
  test: { environment: 'node', include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'tests/**/*.test.ts'], testTimeout: 15000, fileParallelism: false },
});
