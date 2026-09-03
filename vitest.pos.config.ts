import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: { alias: { '@': resolve(__dirname, 'apps/web/src') } },
  test: { include: ['tests/pos/**/*.spec.ts'], environment: 'node', maxWorkers: 1 },
});
