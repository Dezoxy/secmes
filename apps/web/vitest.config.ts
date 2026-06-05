import { defineConfig } from 'vitest/config';

// Keystore tests run in Node with a polyfilled IndexedDB (fake-indexeddb/auto).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    setupFiles: ['fake-indexeddb/auto'],
  },
});
