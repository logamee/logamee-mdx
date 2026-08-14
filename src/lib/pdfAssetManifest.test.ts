import { describe, expect, it, vi } from 'vitest';
import {
  PDF_ASSET_MANIFEST_URL,
  type PdfAssetManifest,
  loadPdfAssetManifest,
  validatePdfAssetManifest,
} from './pdfAssetManifest';

const encoder = new TextEncoder();
const assetRoot = '/vendor/pdfjs/6.1.200/';
const buildWorkerUrl = '/assets/pdf.worker.min-BAKOMYW7.js';
const devWorkerUrl = '/node_modules/pdfjs-dist/build/pdf.worker.min.mjs?worker_file&type=module';
const noticeUrls = [
  `${assetRoot}LICENSE.pdfjs-dist.txt`,
  `${assetRoot}cmaps/LICENSE`,
  `${assetRoot}standard_fonts/LICENSE_FOXIT`,
  `${assetRoot}standard_fonts/LICENSE_LIBERATION`,
  `${assetRoot}wasm/LICENSE_JBIG2`,
  `${assetRoot}wasm/LICENSE_OPENJPEG`,
  `${assetRoot}wasm/LICENSE_PDFJS_JBIG2`,
  `${assetRoot}wasm/LICENSE_PDFJS_OPENJPEG`,
  `${assetRoot}wasm/LICENSE_PDFJS_QCMS`,
  `${assetRoot}wasm/LICENSE_QCMS`,
] as const;
const fixtureAssets: Record<string, Uint8Array> = {
  [buildWorkerUrl]: encoder.encode('worker-6.1.200'),
  [devWorkerUrl]: encoder.encode('worker-6.1.200'),
  [`${assetRoot}cmaps/Adobe-Japan1-UCS2.bcmap`]: encoder.encode('cmap'),
  [`${assetRoot}standard_fonts/FoxitSans.pfb`]: encoder.encode('font'),
  [`${assetRoot}wasm/jbig2_nowasm_fallback.js`]: encoder.encode('wasm'),
  [`${assetRoot}wasm/openjpeg_nowasm_fallback.js`]: encoder.encode('wasm'),
};
for (const url of noticeUrls) fixtureAssets[url] = encoder.encode('notice');

const hashes = {
  worker: 'c7719084a5839386cc39bc1941cb32b34cd91b22ef08dd831a48a620e0363e60',
  cmap: '054b66e4a813a1c3a724faa8f9c7e658834ce117519233dca13677c1aa0fc25b',
  font: '795ea3efa43d0872b63bf0067be97553b46983e4f075097669391e9d15388ecc',
  wasm: '336154bf67f765f8f75d16a0accee61b5ee5f6a75b2a2905703df913bd550f3e',
  notice: '9368a7d21e018f64ae3327d2f25cd4d7693b2d85328e4bb680bcfcbd4c26b90e',
} as const;

function createManifest(workerUrl = buildWorkerUrl): PdfAssetManifest {
  return {
    schema_version: 1,
    pdfjs_version: '6.1.200',
    worker_url: workerUrl,
    cmap_base_url: `${assetRoot}cmaps/`,
    standard_font_base_url: `${assetRoot}standard_fonts/`,
    wasm_base_url: `${assetRoot}wasm/`,
    files: [
      { url: workerUrl, sha256: hashes.worker },
      {
        url: `${assetRoot}cmaps/Adobe-Japan1-UCS2.bcmap`,
        sha256: hashes.cmap,
      },
      { url: `${assetRoot}standard_fonts/FoxitSans.pfb`, sha256: hashes.font },
      { url: `${assetRoot}wasm/jbig2_nowasm_fallback.js`, sha256: hashes.wasm },
      { url: `${assetRoot}wasm/openjpeg_nowasm_fallback.js`, sha256: hashes.wasm },
      ...noticeUrls.map((url) => ({ url, sha256: hashes.notice })),
    ],
  };
}

function cloneManifest(manifest = createManifest()): PdfAssetManifest {
  return JSON.parse(JSON.stringify(manifest)) as PdfAssetManifest;
}

describe('PDF.js packaged asset manifest', () => {
  it.each([
    ['development', devWorkerUrl],
    ['production', buildWorkerUrl],
  ])('accepts the actual %s worker URL plus pinned local assets and notices', async (_, workerUrl) => {
    const manifest = createManifest(workerUrl);
    const readAsset = vi.fn<(url: string) => Promise<Uint8Array>>(async (url) => {
      const bytes = fixtureAssets[url];
      if (!bytes) throw new Error(`missing fixture asset: ${url}`);
      return bytes;
    });

    await expect(validatePdfAssetManifest(cloneManifest(manifest), readAsset)).resolves.toEqual(
      manifest,
    );
    expect(readAsset).toHaveBeenCalledTimes(manifest.files.length);
    expect(readAsset.mock.calls.map(([url]) => url).sort()).toEqual(
      manifest.files.map(({ url }) => url).sort(),
    );
  });

  it('rejects version drift, unsafe URLs, an unused copied worker, and incomplete assets', async () => {
    const readAsset = async (url: string) => fixtureAssets[url] ?? encoder.encode('missing');
    const invalidManifests: PdfAssetManifest[] = [];

    const wrongVersion = cloneManifest();
    wrongVersion.pdfjs_version = '6.1.201';
    invalidManifests.push(wrongVersion);

    for (const [key, url] of [
      ['worker_url', 'https://cdn.example/pdf.worker.min.mjs'],
      ['worker_url', `${assetRoot}build/pdf.worker.min.mjs`],
      ['cmap_base_url', 'blob:https://local.invalid/id'],
      ['standard_font_base_url', '//cdn.example/standard_fonts/'],
      ['wasm_base_url', 'data:application/wasm;base64,AA=='],
    ] as const) {
      const manifest = cloneManifest();
      manifest[key] = url;
      invalidManifests.push(manifest);
    }

    for (const urlPart of ['/cmaps/', '/standard_fonts/', 'openjpeg_nowasm', 'LICENSE_QCMS']) {
      const manifest = cloneManifest();
      manifest.files = manifest.files.filter(({ url }) => !url.includes(urlPart));
      invalidManifests.push(manifest);
    }

    const missingWorker = cloneManifest();
    missingWorker.files = missingWorker.files.filter(({ url }) => url !== missingWorker.worker_url);
    invalidManifests.push(missingWorker);

    const unexpectedFamily = cloneManifest();
    unexpectedFamily.files.push({
      url: `${assetRoot}iccs/qcms_profile.icc`,
      sha256: hashes.notice,
    });
    invalidManifests.push(unexpectedFamily);

    const malformedHash = cloneManifest();
    malformedHash.files[0]!.sha256 = 'not-a-sha256';
    invalidManifests.push(malformedHash);

    for (const manifest of invalidManifests) {
      await expect(validatePdfAssetManifest(manifest, readAsset)).rejects.toThrow(
        'Invalid PDF asset manifest',
      );
    }
  });

  it('rejects a missing packaged file or a hash mismatch before preview startup', async () => {
    const missingAsset = async (url: string): Promise<Uint8Array> => {
      if (url.includes('/standard_fonts/')) throw new Error('asset missing');
      return fixtureAssets[url]!;
    };
    const mismatchedAsset = async (url: string): Promise<Uint8Array> => (
      url.includes('/wasm/') ? encoder.encode('tampered') : fixtureAssets[url]!
    );

    await expect(validatePdfAssetManifest(createManifest(), missingAsset)).rejects.toThrow(
      'Invalid PDF asset manifest',
    );
    await expect(validatePdfAssetManifest(createManifest(), mismatchedAsset)).rejects.toThrow(
      'Invalid PDF asset manifest',
    );
  });

  it('loads only the fixed local manifest and rejects unsafe entries before asset fetches', async () => {
    const manifest = createManifest();
    const fetchAsset = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url === PDF_ASSET_MANIFEST_URL) {
        return {
          json: async () => manifest,
          ok: true,
        } as Response;
      }
      const bytes = fixtureAssets[url];
      if (!bytes) return { ok: false } as Response;
      return {
        arrayBuffer: async () => bytes.slice().buffer,
        ok: true,
      } as Response;
    });

    await expect(loadPdfAssetManifest(fetchAsset)).resolves.toEqual(manifest);
    expect(fetchAsset.mock.calls[0]?.[0]).toBe(PDF_ASSET_MANIFEST_URL);
    expect(fetchAsset.mock.calls.slice(1).map(([url]) => String(url)).sort()).toEqual(
      manifest.files.map(({ url }) => url).sort(),
    );

    const unsafeManifest = createManifest();
    unsafeManifest.worker_url = 'https://cdn.example/pdf.worker.min.mjs';
    fetchAsset.mockReset();
    fetchAsset.mockResolvedValueOnce({
      json: async () => unsafeManifest,
      ok: true,
    } as Response);
    await expect(loadPdfAssetManifest(fetchAsset)).rejects.toThrow('Invalid PDF asset manifest');
    expect(fetchAsset).toHaveBeenCalledOnce();
  });
});
