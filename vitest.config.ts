import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    globalSetup: ['tests/global-setup.ts'],
    // Integration tests share one Postgres database.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
