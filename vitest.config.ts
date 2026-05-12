import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Loads `fake-indexeddb/auto` so cache tests can run Dexie under Node.
    // Idempotent for non-cache tests.
    setupFiles: ['./tests/cache/setup.ts'],
  },
});
