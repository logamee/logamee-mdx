export const PDF_PREVIEW_LIMITS = {
  maxSourceBytes: 64 * 1024 * 1024,
  maxPages: 500,
  maxPagePixels: 32_000_000,
  maxLiveCanvasPixels: 64_000_000,
  maxConcurrentRenders: 2,
  parseTimeoutMs: 30_000,
  pageTimeoutMs: 15_000,
} as const;

export class PdfResourceLimitError extends Error {
  constructor(message = 'PDF resource limit exceeded') {
    super(message);
    this.name = 'PdfResourceLimitError';
  }
}

export class PdfDeadlineError extends Error {
  constructor(message = 'PDF operation deadline exceeded') {
    super(message);
    this.name = 'PdfDeadlineError';
  }
}

export class PdfCancelledError extends Error {
  constructor() {
    super('PDF operation cancelled');
    this.name = 'PdfCancelledError';
  }
}

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function getCanonicalBase64ByteLength(value: string): number {
  if (!value || value.length % 4 !== 0 || !BASE64_PATTERN.test(value)) {
    throw new PdfResourceLimitError('Invalid PDF source encoding');
  }

  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  if (padding === 2) {
    const finalSextet = BASE64_ALPHABET.indexOf(value[value.length - 3]!);
    if (finalSextet < 0 || (finalSextet & 0x0f) !== 0) {
      throw new PdfResourceLimitError('Invalid PDF source encoding');
    }
  } else if (padding === 1) {
    const finalSextet = BASE64_ALPHABET.indexOf(value[value.length - 2]!);
    if (finalSextet < 0 || (finalSextet & 0x03) !== 0) {
      throw new PdfResourceLimitError('Invalid PDF source encoding');
    }
  }

  return (value.length / 4) * 3 - padding;
}

export function assertPdfSourceByteLength(byteLength: number): void {
  if (
    !Number.isSafeInteger(byteLength)
    || byteLength <= 0
    || byteLength > PDF_PREVIEW_LIMITS.maxSourceBytes
  ) {
    throw new PdfResourceLimitError();
  }
}

export function decodePdfBase64(value: string): Uint8Array {
  const byteLength = getCanonicalBase64ByteLength(value);
  assertPdfSourceByteLength(byteLength);

  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new PdfResourceLimitError('Invalid PDF source encoding');
  }
  if (binary.length !== byteLength) {
    throw new PdfResourceLimitError('Invalid PDF source encoding');
  }

  const bytes = new Uint8Array(byteLength);
  for (let index = 0; index < byteLength; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function assertPdfPageCount(pageCount: number): void {
  if (
    !Number.isSafeInteger(pageCount)
    || pageCount <= 0
    || pageCount > PDF_PREVIEW_LIMITS.maxPages
  ) {
    throw new PdfResourceLimitError();
  }
}

export interface PdfCanvasAllocation {
  width: number;
  height: number;
  pixels: number;
}

export function getPdfCanvasAllocation(
  viewportWidth: number,
  viewportHeight: number,
  outputScale: number,
): PdfCanvasAllocation {
  if (
    !Number.isFinite(viewportWidth)
    || viewportWidth <= 0
    || !Number.isFinite(viewportHeight)
    || viewportHeight <= 0
    || !Number.isFinite(outputScale)
    || outputScale <= 0
  ) {
    throw new PdfResourceLimitError();
  }

  const width = Math.ceil(viewportWidth * outputScale);
  const height = Math.ceil(viewportHeight * outputScale);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) {
    throw new PdfResourceLimitError();
  }
  const pixels = width * height;
  if (
    !Number.isSafeInteger(pixels)
    || pixels <= 0
    || pixels > PDF_PREVIEW_LIMITS.maxPagePixels
  ) {
    throw new PdfResourceLimitError();
  }

  return { width, height, pixels };
}

export class PdfCanvasBudget {
  private readonly allocations = new Map<string, number>();
  private allocatedPixels = 0;

  get livePixels(): number {
    return this.allocatedPixels;
  }

  reserve(owner: string, pixels: number): void {
    if (
      this.allocations.has(owner)
      || !Number.isSafeInteger(pixels)
      || pixels <= 0
      || this.allocatedPixels + pixels > PDF_PREVIEW_LIMITS.maxLiveCanvasPixels
    ) {
      throw new PdfResourceLimitError();
    }
    this.allocations.set(owner, pixels);
    this.allocatedPixels += pixels;
  }

  release(owner: string): void {
    const pixels = this.allocations.get(owner);
    if (pixels === undefined) return;
    this.allocations.delete(owner);
    this.allocatedPixels -= pixels;
  }

  releaseAll(): void {
    this.allocations.clear();
    this.allocatedPixels = 0;
  }
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new PdfCancelledError();
}

interface RunPdfPageQueueOptions {
  pageCount: number;
  signal: AbortSignal;
  renderPage: (pageNumber: number) => Promise<void>;
}

export async function runPdfPageQueue({
  pageCount,
  signal,
  renderPage,
}: RunPdfPageQueueOptions): Promise<void> {
  assertPdfPageCount(pageCount);
  let nextPage = 1;

  const runWorker = async () => {
    while (nextPage <= pageCount) {
      throwIfCancelled(signal);
      const pageNumber = nextPage;
      nextPage += 1;
      await renderPage(pageNumber);
      throwIfCancelled(signal);
    }
  };

  const workerCount = Math.min(PDF_PREVIEW_LIMITS.maxConcurrentRenders, pageCount);
  await Promise.all(Array.from({ length: workerCount }, runWorker));
}
