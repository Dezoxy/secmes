import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// SWC handles NestJS decorators + emitDecoratorMetadata under Vitest.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.spec.ts'],
  },
  plugins: [swc.vite()],
});
