import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { crx } from '@crxjs/vite-plugin';
import manifest from './src/manifest.config';

export default defineConfig({
  plugins: [react(), crx({ manifest })],
  // ffmpeg.wasm: keep core assets unbundled/copied; serve from extension origin.
  build: {
    target: 'esnext',
    rollupOptions: {
      // The offscreen document is created at runtime (chrome.offscreen), so it
      // isn't discoverable from the manifest. Declare it as an explicit input so
      // it's built and emitted at dist/src/offscreen/offscreen.html.
      input: {
        offscreen: 'src/offscreen/offscreen.html',
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    hmr: { port: 5173 },
  },
  optimizeDeps: {
    // ffmpeg packages ship as ESM; let vite prebundle the wrapper but not core.
    exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util'],
  },
});
