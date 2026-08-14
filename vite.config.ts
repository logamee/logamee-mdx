import react from '@vitejs/plugin-react';
import { configDefaults, defineConfig } from 'vitest/config';
import { createExcalidrawFontTransformPlugin } from './scripts/excalidraw-assets.mjs';
import { createPdfAssetManifestPlugin } from './scripts/pdf-assets.mjs';

export default defineConfig({
  plugins: [createPdfAssetManifestPlugin(), createExcalidrawFontTransformPlugin(), react()],
  optimizeDeps: {
    exclude: ['@excalidraw/excalidraw'],
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  test: {
    maxWorkers: 2,
    exclude: [
      ...configDefaults.exclude,
      '.omx/**',
      'scripts/check-release-version.test.mjs',
      'scripts/ci/artifact-manifest.test.mjs',
      'scripts/project-metadata.test.mjs',
      'scripts/perf/*.test.mjs',
    ],
    server: {
      deps: {
        inline: ['@excalidraw/excalidraw', 'open-color'],
      },
    },
  },
});
