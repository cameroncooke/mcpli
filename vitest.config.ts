import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    exclude: ['dist/**', 'node_modules/**'],
    testTimeout: 60000,
    hookTimeout: 60000,
    reporters: 'default',
    // Run tests sequentially to avoid daemon conflicts
    threads: false,
    fileParallelism: false,
    coverage: {
      reporter: ['text', 'html'],
      provider: 'v8'
    }
  },
  esbuild: {
    target: 'node18'
  }
});