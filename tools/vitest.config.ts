import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // The git and build tests shell out and copy a repository into a temp directory.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
