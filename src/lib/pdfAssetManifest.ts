const PDFJS_VERSION = '6.4.299';
const PDF_ASSET_ROOT = `/vendor/pdfjs/${PDFJS_VERSION}/`;
export const PDF_ASSET_MANIFEST_URL = `${PDF_ASSET_ROOT}manifest.json`;
const PDF_DEV_WORKER_URL = '/node_modules/pdfjs-dist/build/pdf.worker.min.mjs?worker_file&type=module';
const PDF_BUILD_WORKER_PATTERN = /^\/assets\/pdf\.worker\.min-[A-Za-z0-9_-]{8,}\.js$/;
const REQUIRED_PDF_ASSET_URLS = [
  `${PDF_ASSET_ROOT}LICENSE.pdfjs-dist.txt`,
  `${PDF_ASSET_ROOT}cmaps/LICENSE`,
  `${PDF_ASSET_ROOT}standard_fonts/LICENSE_FOXIT`,
  `${PDF_ASSET_ROOT}standard_fonts/LICENSE_LIBERATION`,
  `${PDF_ASSET_ROOT}wasm/LICENSE_JBIG2`,
  `${PDF_ASSET_ROOT}wasm/LICENSE_OPENJPEG`,
  `${PDF_ASSET_ROOT}wasm/LICENSE_PDFJS_JBIG2`,
  `${PDF_ASSET_ROOT}wasm/LICENSE_PDFJS_OPENJPEG`,
  `${PDF_ASSET_ROOT}wasm/LICENSE_PDFJS_QCMS`,
  `${PDF_ASSET_ROOT}wasm/LICENSE_QCMS`,
  `${PDF_ASSET_ROOT}wasm/jbig2_nowasm_fallback.js`,
  `${PDF_ASSET_ROOT}wasm/openjpeg_nowasm_fallback.js`,
] as const;

interface PdfAssetManifestFile {
  url: string;
  sha256: string;
}

export interface PdfAssetManifest {
  schema_version: 1;
  pdfjs_version: string;
  worker_url: string;
  cmap_base_url: string;
  standard_font_base_url: string;
  wasm_base_url: string;
  files: PdfAssetManifestFile[];
}

function invalidManifest(_cause?: unknown): never {
  throw new Error('Invalid PDF asset manifest');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function isLocalPdfAssetUrl(value: unknown, directory = false): value is string {
  return typeof value === 'string'
    && value.startsWith(PDF_ASSET_ROOT)
    && !value.startsWith('//')
    && !value.includes('\\')
    && !value.includes('..')
    && !value.includes('?')
    && !value.includes('#')
    && (directory ? value.endsWith('/') : !value.endsWith('/'));
}

function isLocalPdfWorkerUrl(value: unknown): value is string {
  return value === PDF_DEV_WORKER_URL
    || (typeof value === 'string' && PDF_BUILD_WORKER_PATTERN.test(value));
}

function isPermittedPdfAssetFileUrl(value: unknown): value is string {
  if (!isLocalPdfAssetUrl(value)) return false;
  if (value === `${PDF_ASSET_ROOT}LICENSE.pdfjs-dist.txt`) return true;
  return [
    `${PDF_ASSET_ROOT}cmaps/`,
    `${PDF_ASSET_ROOT}standard_fonts/`,
    `${PDF_ASSET_ROOT}wasm/`,
  ].some((baseUrl) => value.startsWith(baseUrl) && value.length > baseUrl.length);
}

function bytesToHex(bytes: Uint8Array): string {
  let result = '';
  for (const byte of bytes) result += byte.toString(16).padStart(2, '0');
  return result;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const input = new Uint8Array(bytes).buffer;
  const digest = await globalThis.crypto.subtle.digest('SHA-256', input);
  return bytesToHex(new Uint8Array(digest));
}

// 结构预检：恰好七键、版本一致且文件数组非空。
function manifestShapeInvalid(value: Record<string, unknown>): boolean {
  return !hasExactKeys(value, [
    'schema_version',
    'pdfjs_version',
    'worker_url',
    'cmap_base_url',
    'standard_font_base_url',
    'wasm_base_url',
    'files',
  ])
    || value.schema_version !== 1
    || value.pdfjs_version !== PDFJS_VERSION
    || !Array.isArray(value.files)
    || value.files.length === 0;
}

// 根 URL 预检：worker 白名单，三个资产根均为白名单本地 URL 且为约定子目录。
function manifestRootUrlsInvalid(value: Record<string, unknown>): boolean {
  return !isLocalPdfWorkerUrl(value.worker_url)
    || !isLocalPdfAssetUrl(value.cmap_base_url, true)
    || value.cmap_base_url !== `${PDF_ASSET_ROOT}cmaps/`
    || !isLocalPdfAssetUrl(value.standard_font_base_url, true)
    || value.standard_font_base_url !== `${PDF_ASSET_ROOT}standard_fonts/`
    || !isLocalPdfAssetUrl(value.wasm_base_url, true)
    || value.wasm_base_url !== `${PDF_ASSET_ROOT}wasm/`;
}

// 文件条目收集：URL 白名单或 worker 自身、SHA-256 格式与唯一性。
function collectManifestFiles(value: Record<string, unknown>): PdfAssetManifestFile[] {
  const files: PdfAssetManifestFile[] = [];
  const urls = new Set<string>();
  for (const file of value.files as unknown[]) {
    if (
      !isRecord(file)
      || !hasExactKeys(file, ['url', 'sha256'])
      || (file.url !== value.worker_url && !isPermittedPdfAssetFileUrl(file.url as string))
      || typeof file.sha256 !== 'string'
      || !/^[a-f0-9]{64}$/.test(file.sha256 as string)
      || urls.has(file.url as string)
    ) {
      return invalidManifest();
    }
    urls.add(file.url as string);
    files.push({ url: file.url as string, sha256: file.sha256 as string });
  }
  return files;
}

// 必备资产检查：worker、必选 URL、至少一个 cmap 与一个字体文件。
function requiredManifestAssetsMissing(
  files: PdfAssetManifestFile[],
  workerUrl: string,
  cmapBaseUrl: string,
  standardFontBaseUrl: string,
): boolean {
  const urls = new Set(files.map(({ url }) => url));
  return !urls.has(workerUrl)
    || REQUIRED_PDF_ASSET_URLS.some((url) => !urls.has(url))
    || !files.some(({ url }) => url.startsWith(cmapBaseUrl) && url.endsWith('.bcmap'))
    || !files.some(({ url }) => (
      url.startsWith(standardFontBaseUrl)
      && (url.endsWith('.pfb') || url.endsWith('.ttf'))
    ));
}

function parsePdfAssetManifest(value: unknown): PdfAssetManifest {
  if (!isRecord(value) || manifestShapeInvalid(value) || manifestRootUrlsInvalid(value)) {
    return invalidManifest();
  }
  const files = collectManifestFiles(value);
  if (requiredManifestAssetsMissing(
    files,
    value.worker_url as string,
    value.cmap_base_url as string,
    value.standard_font_base_url as string,
  )) {
    return invalidManifest();
  }
  return {
    schema_version: 1,
    pdfjs_version: PDFJS_VERSION,
    worker_url: value.worker_url as string,
    cmap_base_url: value.cmap_base_url as string,
    standard_font_base_url: value.standard_font_base_url as string,
    wasm_base_url: value.wasm_base_url as string,
    files,
  };
}

export async function validatePdfAssetManifest(
  value: unknown,
  readAsset: (url: string) => Promise<Uint8Array>,
): Promise<PdfAssetManifest> {
  try {
    const manifest = parsePdfAssetManifest(value);
    for (const file of manifest.files) {
      const bytes = await readAsset(file.url);
      if (await sha256(bytes) !== file.sha256) return invalidManifest();
    }
    return manifest;
  } catch (error) {
    return invalidManifest(error);
  }
}

export async function loadPdfAssetManifest(
  fetchAsset: typeof fetch = globalThis.fetch,
): Promise<PdfAssetManifest> {
  try {
    const manifestResponse = await fetchAsset(PDF_ASSET_MANIFEST_URL);
    if (!manifestResponse.ok) return invalidManifest();
    const value: unknown = await manifestResponse.json();
    return validatePdfAssetManifest(value, async (url) => {
      const response = await fetchAsset(url);
      if (!response.ok) return invalidManifest();
      return new Uint8Array(await response.arrayBuffer());
    });
  } catch (error) {
    return invalidManifest(error);
  }
}
