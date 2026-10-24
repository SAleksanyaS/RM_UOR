import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { environment: 'node', include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'tests/**/*.test.ts'], testTimeout: 15000, fileParallelism: false } });
