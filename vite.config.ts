import { defineConfig } from 'vite';
import { crx } from '@crxjs/vite-plugin';
import manifestJson from './manifest.json' with { type: 'json' };

// The repo-root manifest.json stays the single source of truth; crxjs rewrites
// script paths to the bundled output at build time.
const manifest = manifestJson as Parameters<typeof crx>[0]['manifest'];

export default defineConfig({
  plugins: [crx({ manifest })],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 1024,
  },
});
