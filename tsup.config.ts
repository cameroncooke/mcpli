import { defineConfig } from 'tsup';
import { chmodSync, existsSync, mkdirSync, copyFileSync } from 'fs';

export default defineConfig({
  entry: {
    mcpli: 'src/mcpli.ts',
    'daemon/wrapper': 'src/daemon/wrapper.ts',
  },
  format: ['esm'],
  target: 'node18',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  dts: {
    entry: {
      mcpli: 'src/mcpli.ts',
      'daemon/wrapper': 'src/daemon/wrapper.ts',
    },
  },
  splitting: false,
  shims: false,
  treeshake: true,
  minify: false,
  onSuccess: async () => {
    console.log('✅ Build complete!');

    // Set executable permissions for built files
    if (existsSync('dist/mcpli.js')) {
      chmodSync('dist/mcpli.js', 0o755);
    }
    if (existsSync('dist/daemon/wrapper.js')) {
      chmodSync('dist/daemon/wrapper.js', 0o755);
    }

    // Copy daemon files that aren't bundled - wrapper.ts will be compiled to wrapper.js
  },
});