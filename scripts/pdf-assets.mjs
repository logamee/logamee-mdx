import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PDFJS_VERSION = '6.1.200';
export const PDF_ASSET_ROOT = `/vendor/pdfjs/${PDFJS_VERSION}/`;
export const PDF_ASSET_MANIFEST_PATH = `vendor/pdfjs/${PDFJS_VERSION}/manifest.json`;
export const PDF_ASSET_MANIFEST_URL = `/${PDF_ASSET_MANIFEST_PATH}`;
export const PDF_DEV_WORKER_PATH = '/node_modules/pdfjs-dist/build/pdf.worker.min.mjs';
export const PDF_DEV_WORKER_URL = `${PDF_DEV_WORKER_PATH}?worker_file&type=module`;

const BUILD_WORKER_PATTERN = /^\/assets\/pdf\.worker\.min-[A-Za-z0-9_-]{8,}\.js$/;
const EMITTED_WORKER_PATTERN = /^assets\/pdf\.worker\.min-[A-Za-z0-9_-]{8,}\.js$/;
const projectRootFromModule = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const copySpecs = [
  ['cmaps', 'cmaps'],
  ['standard_fonts', 'standard_fonts'],
  ['wasm', 'wasm'],
  ['LICENSE', 'LICENSE.pdfjs-dist.txt'],
];

function toBuffer(value) {
  if (typeof value === 'string') return Buffer.from(value);
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new Error('Invalid PDF asset bytes');
}

export function sha256Bytes(value) {
  return createHash('sha256').update(toBuffer(value)).digest('hex');
}

function toPublicUrl(relativePath) {
  return `${PDF_ASSET_ROOT}${relativePath.split(path.sep).join('/')}`;
}

async function collectRelativeFiles(directory, prefix = '') {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relativePath = path.join(prefix, entry.name);
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectRelativeFiles(absolutePath, relativePath));
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

function resolvePaths(projectRoot = projectRootFromModule) {
  return {
    packageRoot: path.join(projectRoot, 'node_modules', 'pdfjs-dist'),
    publicRoot: path.join(projectRoot, 'public', 'vendor', 'pdfjs', PDFJS_VERSION),
  };
}

async function assertPinnedPdfJsVersion(packageRoot) {
  const packageJson = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
  if (packageJson.version !== PDFJS_VERSION) {
    throw new Error(`Expected pdfjs-dist ${PDFJS_VERSION}, found ${String(packageJson.version)}`);
  }
}

async function expectedCopiedFiles(packageRoot) {
  const files = [];
  for (const [source, destination] of copySpecs) {
    const sourcePath = path.join(packageRoot, source);
    if ((await stat(sourcePath)).isDirectory()) {
      for (const relativePath of await collectRelativeFiles(sourcePath)) {
        files.push({
          destination: path.join(destination, relativePath),
          source: path.join(sourcePath, relativePath),
        });
      }
    } else {
      files.push({ destination, source: sourcePath });
    }
  }
  return files.sort((left, right) => left.destination.localeCompare(right.destination));
}

export async function collectSynchronizedPdfAssets({
  projectRoot = projectRootFromModule,
} = {}) {
  const { packageRoot, publicRoot } = resolvePaths(projectRoot);
  await assertPinnedPdfJsVersion(packageRoot);

  const expectedFiles = await expectedCopiedFiles(packageRoot);
  const actualFiles = await collectRelativeFiles(publicRoot);
  const expectedPaths = expectedFiles.map(({ destination }) => destination);
  if (
    actualFiles.length !== expectedPaths.length
    || actualFiles.some((file, index) => file !== expectedPaths[index])
  ) {
    throw new Error('PDF assets are not synchronized');
  }

  const manifestFiles = [];
  for (const { destination, source } of expectedFiles) {
    const [sourceBytes, publicBytes] = await Promise.all([
      readFile(source),
      readFile(path.join(publicRoot, destination)),
    ]);
    const sourceHash = sha256Bytes(sourceBytes);
    if (sourceHash !== sha256Bytes(publicBytes)) {
      throw new Error(`PDF asset hash mismatch: ${destination}`);
    }
    manifestFiles.push({ url: toPublicUrl(destination), sha256: sourceHash });
  }
  return manifestFiles;
}

export async function syncPdfAssets({ projectRoot = projectRootFromModule } = {}) {
  const { packageRoot, publicRoot } = resolvePaths(projectRoot);
  await assertPinnedPdfJsVersion(packageRoot);
  await rm(publicRoot, { force: true, recursive: true });
  await mkdir(publicRoot, { recursive: true });

  for (const [source, destination] of copySpecs) {
    await cp(path.join(packageRoot, source), path.join(publicRoot, destination), {
      force: true,
      recursive: true,
    });
  }
  return collectSynchronizedPdfAssets({ projectRoot });
}

function isValidWorkerUrl(value) {
  return value === PDF_DEV_WORKER_URL || BUILD_WORKER_PATTERN.test(value);
}

export function createPdfAssetManifest({ assetFiles, workerBytes, workerUrl }) {
  if (!isValidWorkerUrl(workerUrl)) throw new Error('Invalid PDF worker URL');
  const bytes = toBuffer(workerBytes);
  if (bytes.byteLength === 0) throw new Error('Invalid PDF worker bytes');
  if (!Array.isArray(assetFiles) || assetFiles.length === 0) {
    throw new Error('Missing PDF runtime assets');
  }

  return {
    schema_version: 1,
    pdfjs_version: PDFJS_VERSION,
    worker_url: workerUrl,
    cmap_base_url: `${PDF_ASSET_ROOT}cmaps/`,
    standard_font_base_url: `${PDF_ASSET_ROOT}standard_fonts/`,
    wasm_base_url: `${PDF_ASSET_ROOT}wasm/`,
    files: [
      { url: workerUrl, sha256: sha256Bytes(bytes) },
      ...assetFiles,
    ],
  };
}

export function findEmittedPdfWorker(bundle) {
  const candidates = Object.values(bundle).filter((output) => (
    output?.type === 'asset'
    && typeof output.fileName === 'string'
    && EMITTED_WORKER_PATTERN.test(output.fileName)
  ));
  if (candidates.length === 0) throw new Error('Missing emitted PDF worker');
  if (candidates.length > 1) throw new Error('Multiple emitted PDF workers');
  const [worker] = candidates;
  toBuffer(worker.source);
  return worker;
}

function isExactDevWorkerRequest(requestUrl) {
  return requestUrl.pathname === PDF_DEV_WORKER_PATH
    && requestUrl.search === '?worker_file&type=module';
}

function sendBytes(response, bytes, contentType) {
  response.statusCode = 200;
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Length', String(bytes.byteLength));
  response.setHeader('Content-Type', contentType);
  response.end(bytes);
}

export function createPdfAssetManifestPlugin({
  projectRoot = projectRootFromModule,
} = {}) {
  const { packageRoot } = resolvePaths(projectRoot);
  const workerSourcePath = path.join(packageRoot, 'build', 'pdf.worker.min.mjs');
  let base = '/';
  let developmentManifestPromise;

  return {
    name: 'mmd-pdf-asset-manifest',
    configResolved(config) {
      base = config.base;
      if (base !== '/') throw new Error('PDF assets require a root-local Vite base');
    },
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        try {
          const requestUrl = new URL(request.url ?? '/', 'http://mmd.local');
          if (isExactDevWorkerRequest(requestUrl)) {
            await assertPinnedPdfJsVersion(packageRoot);
            sendBytes(
              response,
              await readFile(workerSourcePath),
              'text/javascript; charset=utf-8',
            );
            return;
          }
          if (requestUrl.pathname === PDF_ASSET_MANIFEST_URL && requestUrl.search === '') {
            developmentManifestPromise ??= Promise.all([
              collectSynchronizedPdfAssets({ projectRoot }),
              readFile(workerSourcePath),
            ]).then(([assetFiles, workerBytes]) => createPdfAssetManifest({
              assetFiles,
              workerBytes,
              workerUrl: PDF_DEV_WORKER_URL,
            }));
            const manifestBytes = Buffer.from(
              `${JSON.stringify(await developmentManifestPromise, null, 2)}\n`,
            );
            sendBytes(response, manifestBytes, 'application/json; charset=utf-8');
            return;
          }
          next();
        } catch (error) {
          next(error);
        }
      });
    },
    async generateBundle(_outputOptions, bundle) {
      if (base !== '/') throw new Error('PDF assets require a root-local Vite base');
      const worker = findEmittedPdfWorker(bundle);
      const manifest = createPdfAssetManifest({
        assetFiles: await collectSynchronizedPdfAssets({ projectRoot }),
        workerBytes: worker.source,
        workerUrl: `/${worker.fileName}`,
      });
      this.emitFile({
        type: 'asset',
        fileName: PDF_ASSET_MANIFEST_PATH,
        source: `${JSON.stringify(manifest, null, 2)}\n`,
      });
    },
  };
}
