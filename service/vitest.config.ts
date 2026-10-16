import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // All test files share one real PostgreSQL. Each test creates its own accounts, so they do not
    // interfere with each other, but running files one at a time keeps the output easy to read.
    fileParallelism: false,
  },
});
