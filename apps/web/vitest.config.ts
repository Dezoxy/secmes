import { defineConfig } from 'vitest/config';

// Keystore tests run in Node with a polyfilled IndexedDB (fake-indexeddb/auto).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    setupFiles: ['fake-indexeddb/auto'],
    // Keystore tests do Argon2id + many IndexedDB ops; under CPU contention (the pre-push hook / CI running
    // multiple suites) they can exceed the 5s default. Generous headroom so legitimately-slow-under-load work
    // doesn't flake — still low enough to catch a real hang.
    testTimeout: 20_000,
  },
});
