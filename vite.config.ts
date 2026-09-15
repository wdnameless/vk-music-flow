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
    rollupOptions: {
      // crxjs only processes HTML pages it finds in the manifest (the popup).
      // The offscreen document lives in web_accessible_resources, so it must be
      // declared here or its <script type="module"> is copied unprocessed and
      // the player never loads.
      input: {
        offscreen: 'src/offscreen/offscreen.html',
      },
    },
  },
});
