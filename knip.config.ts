import type { KnipConfig } from 'knip';

// Dead-code detection scoped to the shipped frontend plus the vite/vitest
// config. CI tooling under scripts/ is excluded on purpose: its exports are
// consumed by *.node-test.mjs runner files, which knip does not treat as
// entry points, and its binaries (taskkill.exe) are Windows process helpers
// invoked dynamically.
const config: KnipConfig = {
  entry: ['src/main.tsx'],
  project: ['src/**/*.{ts,tsx}'],
  // Windows process-cleanup helper spawned dynamically by packaged-app
  // lifecycle runners under scripts/ci/.
  ignoreBinaries: ['taskkill.exe'],
};

export default config;
