import { defineManifest } from '@crxjs/vite-plugin';

export default defineManifest({
  manifest_version: 3,
  name: 'Video DL — HLS Downloader',
  version: '0.1.0',
  description: 'Detect non-DRM HLS streams, preview, and download as MP4 (ffmpeg.wasm, no companion app).',
  minimum_chrome_version: '116',
  background: {
    service_worker: 'src/background/index.ts',
    type: 'module',
  },
  side_panel: {
    default_path: 'src/sidepanel/index.html',
  },
  action: {
    default_title: 'Video DL',
  },
  permissions: [
    'webRequest',
    'storage',
    'downloads',
    'offscreen',
    'sidePanel',
    'cookies',
    'tabs',
  ],
  host_permissions: ['<all_urls>'],
  // ffmpeg.wasm + offscreen need wasm-eval; bundled locally (no remote).
  content_security_policy: {
    extension_pages:
      "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';",
  },
});
