import { describe, expect, it } from 'vitest';
import {
  PDF_PREVIEW_LIMITS,
  PdfCanvasBudget,
  PdfCancelledError,
  PdfResourceLimitError,
  assertPdfPageCount,
  assertPdfSourceByteLength,
  decodePdfBase64,
  getPdfCanvasAllocation,
  runPdfPageQueue,
} from './pdfRenderScheduler';

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('PDF render resource scheduler', () => {
  it('decodes canonical base64 locally and rejects malformed or oversized sources before allocation', () => {
    expect(Array.from(decodePdfBase64('JVBERi0xLjQ='))).toEqual([
      0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34,
    ]);
    expect(() => decodePdfBase64('')).toThrow(PdfResourceLimitError);
    expect(() => decodePdfBase64('data:application/pdf;base64,JVBERg==')).toThrow(
      PdfResourceLimitError,
    );
    expect(() => decodePdfBase64('Zh==')).toThrow(PdfResourceLimitError);

    expect(() => assertPdfSourceByteLength(PDF_PREVIEW_LIMITS.maxSourceBytes)).not.toThrow();
    expect(() => assertPdfSourceByteLength(PDF_PREVIEW_LIMITS.maxSourceBytes + 1)).toThrow(
      PdfResourceLimitError,
    );
  });

  it('enforces page count, backing-canvas page pixels, and aggregate live-canvas pixels', () => {
    expect(() => assertPdfPageCount(PDF_PREVIEW_LIMITS.maxPages)).not.toThrow();
    expect(() => assertPdfPageCount(PDF_PREVIEW_LIMITS.maxPages + 1)).toThrow(
      PdfResourceLimitError,
    );
    expect(getPdfCanvasAllocation(2_000, 2_000, 2)).toEqual({
      height: 4_000,
      pixels: 16_000_000,
      width: 4_000,
    });
    expect(() => getPdfCanvasAllocation(4_001, 4_000, 2)).toThrow(PdfResourceLimitError);

    const budget = new PdfCanvasBudget();
    budget.reserve('page-1', 32_000_000);
    budget.reserve('page-2', 32_000_000);
    expect(budget.livePixels).toBe(PDF_PREVIEW_LIMITS.maxLiveCanvasPixels);
    expect(() => budget.reserve('page-3', 1)).toThrow(PdfResourceLimitError);
    budget.release('page-1');
    expect(budget.livePixels).toBe(32_000_000);
    budget.releaseAll();
    expect(budget.livePixels).toBe(0);
  });

  it('starts pages in numerical order with no more than two live renders', async () => {
    const gates = Array.from({ length: 5 }, () => deferred());
    const started: number[] = [];
    let active = 0;
    let maxActive = 0;
    const queue = runPdfPageQueue({
      pageCount: gates.length,
      signal: new AbortController().signal,
      renderPage: async (pageNumber) => {
        started.push(pageNumber);
        active += 1;
        maxActive = Math.max(maxActive, active);
        await gates[pageNumber - 1]!.promise;
        active -= 1;
      },
    });

    await Promise.resolve();
    expect(started).toEqual([1, 2]);
    gates[1]!.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual([1, 2, 3]);
    gates[0]!.resolve();
    gates[2]!.resolve();
    await Promise.resolve();
    await Promise.resolve();
    gates[3]!.resolve();
    gates[4]!.resolve();
    await queue;

    expect(started).toEqual([1, 2, 3, 4, 5]);
    expect(maxActive).toBe(PDF_PREVIEW_LIMITS.maxConcurrentRenders);
  });

  it('stops scheduling after identity cancellation', async () => {
    const controller = new AbortController();
    const gates = [deferred(), deferred()];
    const started: number[] = [];
    const queue = runPdfPageQueue({
      pageCount: 4,
      signal: controller.signal,
      renderPage: async (pageNumber) => {
        started.push(pageNumber);
        await gates[pageNumber - 1]!.promise;
      },
    });

    await Promise.resolve();
    expect(started).toEqual([1, 2]);
    controller.abort();
    gates[0]!.resolve();
    gates[1]!.resolve();
    await expect(queue).rejects.toBeInstanceOf(PdfCancelledError);
    expect(started).toEqual([1, 2]);
  });
});
