import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/tests/**/*.test.ts'],
    // Sequential is safer on NAS-backed workspaces; the CLI flag mirrors this.
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
