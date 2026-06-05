import { defineConfig } from 'vitest/config';

// Only run TypeScript specs from src — never the compiled copies in dist (avoids double-runs).
export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts'],
  },
});
