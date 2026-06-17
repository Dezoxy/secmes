import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// SWC handles NestJS decorators + emitDecoratorMetadata under Vitest.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    // DB-integration specs do real work — notably breakglass rotate runs Argon2id verify+hash (~7s),
    // which exceeds the 5s default. Bump so legitimately slow integration tests aren't flaky in CI.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  plugins: [swc.vite()],
});
