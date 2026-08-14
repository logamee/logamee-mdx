import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, createServer } from 'vite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadPdfAssetManifest,
  validatePdfAssetManifest,
} from '../src/lib/pdfAssetManifest';
import {
  PDFJS_VERSION,
  PDF_ASSET_MANIFEST_PATH,
  PDF_ASSET_MANIFEST_URL,
  PDF_DEV_WORKER_URL,
  collectSynchronizedPdfAssets,
  createPdfAssetManifest,
  createPdfAssetManifestPlugin,
  findEmittedPdfWorker,
  syncPdfAssets,
} from './pdf-assets.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryDirectories = [];

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function createFixtureProject() {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'mmd-pdf-fixture-'));
  temporaryDirectories.push(fixtureRoot);
  const packageRoot = path.join(fixtureRoot, 'node_modules', 'pdfjs-dist');
  await Promise.all([
    mkdir(path.join(packageRoot, 'cmaps'), { recursive: true }),
    mkdir(path.join(packageRoot, 'standard_fonts'), { recursive: true }),
    mkdir(path.join(packageRoot, 'wasm'), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ version: PDFJS_VERSION })),
    writeFile(path.join(packageRoot, 'LICENSE'), 'root-license'),
    writeFile(path.join(packageRoot, 'cmaps', 'Example.bcmap'), 'cmap'),
    writeFile(path.join(packageRoot, 'standard_fonts', 'Example.pfb'), 'font'),
    writeFile(path.join(packageRoot, 'wasm', 'fallback.js'), 'fallback'),
  ]);
  return fixtureRoot;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { force: true, recursive: true })
  )));
});

describe('PDF asset manifest build integration', () => {
  it('builds mode-specific manifests around the exact worker bytes', () => {
    const assetFiles = [{
      url: `/vendor/pdfjs/${PDFJS_VERSION}/cmaps/Example.bcmap`,
      sha256: sha256('cmap'),
    }];
    const development = createPdfAssetManifest({
      assetFiles,
      workerBytes: Buffer.from('worker'),
      workerUrl: PDF_DEV_WORKER_URL,
    });
    const production = createPdfAssetManifest({
      assetFiles,
      workerBytes: Buffer.from('worker'),
      workerUrl: '/assets/pdf.worker.min-ABCDEFGH.js',
    });

    expect(development.worker_url).toBe(PDF_DEV_WORKER_URL);
    expect(production.worker_url).toBe('/assets/pdf.worker.min-ABCDEFGH.js');
    expect(development.files[0]).toEqual({
      url: PDF_DEV_WORKER_URL,
      sha256: sha256('worker'),
    });
    expect(() => createPdfAssetManifest({
      assetFiles,
      workerBytes: Buffer.from('worker'),
      workerUrl: 'https://cdn.example/pdf.worker.min.mjs',
    })).toThrow('Invalid PDF worker URL');
  });

  it('requires exactly one Vite-emitted worker asset', () => {
    const worker = {
      fileName: 'assets/pdf.worker.min-ABCDEFGH.js',
      source: 'worker',
      type: 'asset',
    };
    expect(findEmittedPdfWorker({ [worker.fileName]: worker })).toEqual(worker);
    expect(() => findEmittedPdfWorker({})).toThrow('Missing emitted PDF worker');
    expect(() => findEmittedPdfWorker({
      [worker.fileName]: worker,
      'assets/pdf.worker.min-IJKLMNOP.js': {
        ...worker,
        fileName: 'assets/pdf.worker.min-IJKLMNOP.js',
      },
    })).toThrow('Multiple emitted PDF workers');
  });

  it('fails synchronization on missing, mismatched, extra, or version-drifted files', async () => {
    const fixtureRoot = await createFixtureProject();
    const publicRoot = path.join(fixtureRoot, 'public', 'vendor', 'pdfjs', PDFJS_VERSION);
    const packageJsonPath = path.join(fixtureRoot, 'node_modules', 'pdfjs-dist', 'package.json');
    await syncPdfAssets({ projectRoot: fixtureRoot });
    await expect(collectSynchronizedPdfAssets({ projectRoot: fixtureRoot })).resolves.toHaveLength(4);

    await writeFile(path.join(publicRoot, 'cmaps', 'Example.bcmap'), 'tampered');
    await expect(collectSynchronizedPdfAssets({ projectRoot: fixtureRoot })).rejects.toThrow(
      'PDF asset hash mismatch',
    );

    await syncPdfAssets({ projectRoot: fixtureRoot });
    await rm(path.join(publicRoot, 'wasm', 'fallback.js'));
    await expect(collectSynchronizedPdfAssets({ projectRoot: fixtureRoot })).rejects.toThrow(
      'PDF assets are not synchronized',
    );

    await syncPdfAssets({ projectRoot: fixtureRoot });
    await mkdir(path.join(publicRoot, 'build'));
    await writeFile(path.join(publicRoot, 'build', 'pdf.worker.min.mjs'), 'unused worker');
    await expect(collectSynchronizedPdfAssets({ projectRoot: fixtureRoot })).rejects.toThrow(
      'PDF assets are not synchronized',
    );

    await writeFile(packageJsonPath, JSON.stringify({ version: '6.1.201' }));
    await expect(collectSynchronizedPdfAssets({ projectRoot: fixtureRoot })).rejects.toThrow(
      'Expected pdfjs-dist 6.1.200, found 6.1.201',
    );
  });

  it('serves the exact transformed worker URL and matching development hash', async () => {
    const server = await createServer({
      configFile: false,
      publicDir: path.join(projectRoot, 'public'),
      root: projectRoot,
      plugins: [createPdfAssetManifestPlugin({ projectRoot })],
      server: { host: '127.0.0.1', port: 0, strictPort: false },
    });
    try {
      await server.listen();
      const transformed = await server.transformRequest('/src/lib/pdfPreviewRuntime.ts');
      expect(transformed?.code).toContain(JSON.stringify(PDF_DEV_WORKER_URL));

      const address = server.httpServer?.address();
      if (!address || typeof address === 'string') throw new Error('Expected Vite TCP address');
      const origin = `http://127.0.0.1:${address.port}`;
      const manifestResponse = await fetch(`${origin}${PDF_ASSET_MANIFEST_URL}`);
      expect(manifestResponse.status).toBe(200);
      const manifest = await manifestResponse.json();
      expect(manifest.worker_url).toBe(PDF_DEV_WORKER_URL);

      const workerResponse = await fetch(`${origin}${manifest.worker_url}`);
      const workerBytes = Buffer.from(await workerResponse.arrayBuffer());
      expect(workerResponse.status).toBe(200);
      expect(workerBytes.byteLength).toBeGreaterThan(1_000_000);
      expect(manifest.files.find(({ url }) => url === manifest.worker_url)?.sha256)
        .toBe(sha256(workerBytes));

      const validatedManifest = await loadPdfAssetManifest((input, init) => (
        fetch(new URL(String(input), origin), init)
      ));
      expect(validatedManifest).toEqual(manifest);
      expect(validatedManifest.files).toHaveLength(200);
    } finally {
      await server.close();
    }
  }, 20_000);

  it('emits a manifest whose worker and copied assets exist and match every hash', async () => {
    const outDir = await mkdtemp(path.join(os.tmpdir(), 'mmd-pdf-assets-'));
    temporaryDirectories.push(outDir);

    await build({
      configFile: false,
      publicDir: path.join(projectRoot, 'public'),
      plugins: [createPdfAssetManifestPlugin({ projectRoot })],
      build: {
        emptyOutDir: true,
        lib: {
          entry: path.join(projectRoot, 'src/lib/pdfPreviewRuntime.ts'),
          fileName: 'pdf-runtime',
          formats: ['es'],
        },
        outDir,
      },
    });

    const manifest = JSON.parse(await readFile(
      path.join(outDir, PDF_ASSET_MANIFEST_PATH),
      'utf8',
    ));
    expect(manifest.pdfjs_version).toBe(PDFJS_VERSION);
    expect(manifest.worker_url).toMatch(/^\/assets\/pdf\.worker\.min-[A-Za-z0-9_-]{8}\.js$/);
    expect(manifest.files[0]?.url).toBe(manifest.worker_url);
    expect(manifest.files.some(({ url }) => url.includes('/build/pdf.worker'))).toBe(false);

    await expect(validatePdfAssetManifest(manifest, async (url) => (
      new Uint8Array(await readFile(path.join(outDir, url.slice(1))))
    ))).resolves.toEqual(manifest);

    for (const file of manifest.files) {
      const bytes = await readFile(path.join(outDir, file.url.slice(1)));
      expect(sha256(bytes)).toBe(file.sha256);
    }

    for (const notice of [
      'LICENSE.pdfjs-dist.txt',
      'cmaps/LICENSE',
      'standard_fonts/LICENSE_FOXIT',
      'standard_fonts/LICENSE_LIBERATION',
      'wasm/LICENSE_JBIG2',
      'wasm/LICENSE_OPENJPEG',
      'wasm/LICENSE_PDFJS_JBIG2',
      'wasm/LICENSE_PDFJS_OPENJPEG',
      'wasm/LICENSE_PDFJS_QCMS',
      'wasm/LICENSE_QCMS',
    ]) {
      const url = `/vendor/pdfjs/${PDFJS_VERSION}/${notice}`;
      expect(manifest.files.some((file) => file.url === url)).toBe(true);
    }
    await expect(access(
      path.join(outDir, `vendor/pdfjs/${PDFJS_VERSION}/build/pdf.worker.min.mjs`),
    )).rejects.toMatchObject({ code: 'ENOENT' });
  }, 20_000);
});
