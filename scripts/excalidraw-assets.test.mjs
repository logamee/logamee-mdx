import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  assertExcalidrawVersion,
  createExcalidrawFontTransformPlugin,
  EXCALIDRAW_FONT_FAMILIES,
  EXCALIDRAW_VERSION,
  transformExcalidrawModule,
  validatePinnedExcalidrawBuild,
} from './excalidraw-assets.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageRoot = path.join(projectRoot, 'node_modules', '@excalidraw', 'excalidraw');
const modulePaths = {
  development: path.join(packageRoot, 'dist', 'dev', 'chunk-4FTI6OG3.js'),
  production: path.join(packageRoot, 'dist', 'prod', 'chunk-K2UTITRG.js'),
};

describe('Excalidraw font transform', () => {
  it('pins the reviewed dependency and complete registered family list', async () => {
    expect(EXCALIDRAW_VERSION).toBe('0.18.1');
    expect(EXCALIDRAW_FONT_FAMILIES).toEqual([
      'Cascadia',
      'Comic Shanns',
      'Excalifont',
      'Helvetica',
      'Liberation Sans',
      'Lilita One',
      'Nunito',
      'Virgil',
      'Xiaolai',
      'Segoe UI Emoji',
    ]);
    await expect(validatePinnedExcalidrawBuild({ projectRoot })).resolves.toEqual({
      development: modulePaths.development,
      production: modulePaths.production,
    });
  });

  it('fails closed when the dependency version changes', () => {
    expect(() => assertExcalidrawVersion('0.18.2')).toThrow(
      'Expected @excalidraw/excalidraw 0.18.1, found 0.18.2',
    );
  });

  it.each(Object.entries(modulePaths))('transforms the %s module shape', async (_, modulePath) => {
    const source = await readFile(modulePath, 'utf8');
    const result = transformExcalidrawModule(source, modulePath);

    expect(result).not.toBeNull();
    expect(result.code).toContain('ui-monospace, monospace');
    expect(result.code).toContain('system-ui, sans-serif');
    expect(result.code).not.toMatch(/skipInliningFonts\s*\?\s*\[\]\s*:/u);
    expect(result.code).not.toMatch(/!opts\?\.skipInliningFonts/u);
    expect(result.code).not.toMatch(/await\s+[\w$.]+\.generateFontFaceDeclarations\(/u);
  });

  it.each(Object.entries(modulePaths))('fails closed when a %s transform marker changes', async (_, modulePath) => {
    const source = await readFile(modulePath, 'utf8');
    const changedSource = source.includes('const fontFaces = !opts?.skipInliningFonts')
      ? source.replace('const fontFaces = !opts?.skipInliningFonts', 'const fontFaces = !opts?.changed')
      : source.replace('let S=r?.skipInliningFonts?', 'let S=r?.changed?');

    expect(() => transformExcalidrawModule(changedSource, modulePath)).toThrow(
      /expected exactly 1 SVG font-inlining marker/iu,
    );
  });

  it.each(Object.entries(modulePaths))('fails closed when the %s family registration changes', async (_, modulePath) => {
    const source = await readFile(modulePath, 'utf8');
    const changedSource = source.includes('init("Cascadia"')
      ? source.replace('init("Cascadia"', 'init("Changed Cascadia"')
      : source.replace('n("Cascadia"', 'n("Changed Cascadia"');

    expect(() => transformExcalidrawModule(changedSource, modulePath)).toThrow(
      /expected exactly 1 registered-family marker/iu,
    );
  });

  it('exposes only the version-locked transform plugin and no asset emission hooks', async () => {
    const plugin = createExcalidrawFontTransformPlugin({ projectRoot });
    const viteConfig = await readFile(path.join(projectRoot, 'vite.config.ts'), 'utf8');
    const script = await readFile(path.join(projectRoot, 'scripts', 'excalidraw-assets.mjs'), 'utf8');

    expect(plugin.name).toBe('mmd-excalidraw-system-fonts');
    expect(plugin.enforce).toBe('pre');
    expect(plugin).not.toHaveProperty('configureServer');
    expect(plugin).not.toHaveProperty('generateBundle');
    expect(viteConfig).toContain('createExcalidrawFontTransformPlugin()');
    expect(viteConfig).not.toContain('createExcalidrawAssetPlugin');
    expect(script).not.toContain('emitFile');
    expect(script).not.toContain('collectExcalidrawAssetFiles');
  });

  it('keeps the Vite dev server from pre-bundling past the transform plugin', async () => {
    const viteConfig = await readFile(path.join(projectRoot, 'vite.config.ts'), 'utf8');

    expect(viteConfig).toMatch(
      /optimizeDeps:\s*\{\s*exclude:\s*\[\s*['"]@excalidraw\/excalidraw['"]\s*\]/u,
    );
  });

  it('installs the system font adapter through the single bootstrap entry', async () => {
    const html = await readFile(path.join(projectRoot, 'index.html'), 'utf8');
    const bootstrap = await readFile(path.join(projectRoot, 'src', 'bootstrap.ts'), 'utf8');
    const fontBootstrap = await readFile(
      path.join(projectRoot, 'src', 'lib', 'excalidrawSystemFontsBootstrap.ts'),
      'utf8',
    );
    const moduleEntries = html.match(/<script\b[^>]*\btype=["']module["'][^>]*\bsrc=/gu) ?? [];
    const fontImportIndex = bootstrap.indexOf("import './lib/excalidrawSystemFontsBootstrap'");
    const lifecycleGateIndex = bootstrap.indexOf('VITE_MMD_PACKAGED_LIFECYCLE_E2E');
    const openGateIndex = bootstrap.indexOf('VITE_MMD_PACKAGED_OPEN_E2E');
    const packagedBootstrapImportIndex = bootstrap.indexOf("import('./lib/packagedBootstrap')");
    const mainImportIndex = bootstrap.indexOf("import('./main')");

    expect(moduleEntries).toHaveLength(1);
    expect(html).toContain('src="/src/bootstrap.ts"');
    expect(html).not.toContain('src="/src/main.tsx"');
    expect(html).not.toContain('EXCALIDRAW_ASSET_PATH');
    expect(fontBootstrap).toContain('installExcalidrawSystemFonts()');
    expect(fontImportIndex).toBeGreaterThan(-1);
    expect(lifecycleGateIndex).toBeGreaterThan(fontImportIndex);
    expect(openGateIndex).toBeGreaterThan(lifecycleGateIndex);
    expect(packagedBootstrapImportIndex).toBeGreaterThan(openGateIndex);
    expect(mainImportIndex).toBeGreaterThan(openGateIndex);
    expect(bootstrap.match(/\bimport\s*\(/gu)).toHaveLength(2);
    expect(bootstrap).not.toContain("import './main'");
  });
});
