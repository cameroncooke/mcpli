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
    // Allow parallelism by default; can be disabled with MCPLI_TEST_SERIAL=1
    threads: process.env.MCPLI_TEST_SERIAL === '1' ? false : true,
    fileParallelism: process.env.MCPLI_TEST_SERIAL === '1' ? false : true,
    // Use forked workers for better process isolation when parallel
    pool: process.env.MCPLI_TEST_SERIAL === '1' ? 'threads' : 'forks',
    coverage: {
      reporter: ['text', 'html', 'lcov'],
      provider: 'v8'
    }
  },
  esbuild: {
    target: 'node22'
  }
});
