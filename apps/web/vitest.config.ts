import { defineConfig } from 'vitest/config';

// Keystore tests run in Node with a polyfilled IndexedDB (fake-indexeddb/auto).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts', 'scripts/**/*.spec.ts'],
    setupFiles: ['fake-indexeddb/auto', './src/test/setup-browser-storage.ts'],
    environmentOptions: {
      jsdom: {
        url: 'http://localhost/',
      },
    },
    // Keystore tests do Argon2id + many IndexedDB ops; under CPU contention (the pre-push hook / CI running
    // multiple suites) they can exceed the 5s default. Generous headroom so legitimately-slow-under-load work
    // doesn't flake — still low enough to catch a real hang.
    testTimeout: 20_000,
  },
});
