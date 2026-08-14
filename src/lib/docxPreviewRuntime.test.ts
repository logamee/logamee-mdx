// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DOCX_RUNTIME_LIMITS,
  DocxCancelledError,
  DocxDeadlineError,
  DocxFatalConversionError,
  DocxResourceLimitError,
  DocxWorkerProtocolError,
  assertDocxSourceByteLength,
  decodeDocxBase64,
  startDocxPreview,
  type DocxWorkerResponse,
} from './docxPreviewRuntime';

class FakeWorker {
  static readonly instances: FakeWorker[] = [];

  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null = null;
  readonly postMessage = vi.fn<(message: unknown, transfer: Transferable[]) => void>();
  readonly terminate = vi.fn<() => void>();

  constructor(
    readonly scriptURL: string | URL,
    readonly options?: WorkerOptions,
  ) {
    FakeWorker.instances.push(this);
  }

  respond(response: DocxWorkerResponse): void {
    this.onmessage?.(new MessageEvent('message', { data: response }));
  }
}

describe('DOCX preview runtime', () => {
  beforeEach(() => {
    FakeWorker.instances.splice(0);
    vi.stubGlobal('Worker', FakeWorker);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('decodes only canonical non-empty base64 within the 32 MiB source bound', () => {
    expect(Array.from(decodeDocxBase64('AQIDBA=='))).toEqual([1, 2, 3, 4]);
    for (const invalid of ['', 'A===', 'AB==', 'AQIDBA', 'AQIDBA__', 'data:application/zip;base64,AQ==']) {
      expect(() => decodeDocxBase64(invalid)).toThrow(DocxResourceLimitError);
    }
    expect(() => assertDocxSourceByteLength(DOCX_RUNTIME_LIMITS.maxSourceBytes + 1))
      .toThrow(DocxResourceLimitError);
  });

  it('transfers preview-owned bytes to a dedicated module worker and resolves sanitized HTML only', async () => {
    const run = startDocxPreview({
      bytesBase64: 'AQIDBA==',
      documentEpoch: 7,
      documentId: 'document-a',
    });
    const worker = FakeWorker.instances[0]!;

    expect(worker.scriptURL).toBeInstanceOf(URL);
    expect(String(worker.scriptURL)).toContain('docxPreview.worker');
    expect(worker.options).toEqual({ name: 'mmd-docx-preview', type: 'module' });
    expect(worker.postMessage).toHaveBeenCalledOnce();
    const [request, transfer] = worker.postMessage.mock.calls[0]!;
    expect(request).toMatchObject({ type: 'convert-docx', requestId: 'document-a:7' });
    expect(request).toHaveProperty('arrayBuffer', transfer[0]);
    expect(Array.from(new Uint8Array(transfer[0] as ArrayBuffer))).toEqual([1, 2, 3, 4]);

    worker.respond({
      type: 'docx-converted',
      requestId: 'document-a:7',
      rawHtml: '<script>alert(1)</script><p onclick="alert(2)">Safe</p>',
      images: [],
      messages: [],
    });

    await expect(run.done).resolves.toEqual({
      detectedLoss: false,
      html: '<p>Safe</p>',
      nodeCount: 2,
    });
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('returns detected loss only for usable output and rejects fatal conversion messages', async () => {
    const degraded = startDocxPreview({
      bytesBase64: 'AQ==',
      documentEpoch: 1,
      documentId: 'degraded',
    });
    FakeWorker.instances[0]!.respond({
      type: 'docx-converted',
      requestId: 'degraded:1',
      rawHtml: '<p>Supported content</p>',
      images: [],
      messages: [{ type: 'warning', message: 'Unsupported break type: column' }],
    });
    await expect(degraded.done).resolves.toMatchObject({ detectedLoss: true });

    const fatal = startDocxPreview({
      bytesBase64: 'Ag==',
      documentEpoch: 2,
      documentId: 'fatal',
    });
    FakeWorker.instances[1]!.respond({
      type: 'docx-converted',
      requestId: 'fatal:2',
      rawHtml: '<p>Misleading partial content</p>',
      images: [],
      messages: [{
        type: 'warning',
        message: 'Did not understand this style mapping, so ignored it: invalid',
      }],
    });
    await expect(fatal.done).rejects.toBeInstanceOf(DocxFatalConversionError);
  });

  it('terminates the worker on deadline, cancellation, failure, and mismatched identity', async () => {
    vi.useFakeTimers();
    const deadline = startDocxPreview({
      bytesBase64: 'AQ==', documentEpoch: 1, documentId: 'deadline',
    });
    void deadline.done.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(DOCX_RUNTIME_LIMITS.conversionTimeoutMs);
    await expect(deadline.done).rejects.toBeInstanceOf(DocxDeadlineError);
    expect(FakeWorker.instances[0]!.terminate).toHaveBeenCalledOnce();

    const cancelled = startDocxPreview({
      bytesBase64: 'Ag==', documentEpoch: 2, documentId: 'cancelled',
    });
    cancelled.cancel();
    await expect(cancelled.done).rejects.toBeInstanceOf(DocxCancelledError);
    expect(FakeWorker.instances[1]!.terminate).toHaveBeenCalledOnce();

    const mismatched = startDocxPreview({
      bytesBase64: 'Aw==', documentEpoch: 3, documentId: 'current',
    });
    FakeWorker.instances[2]!.respond({
      type: 'docx-failed',
      requestId: 'stale:2',
    });
    await expect(mismatched.done).rejects.toBeInstanceOf(DocxWorkerProtocolError);
    expect(FakeWorker.instances[2]!.terminate).toHaveBeenCalledOnce();
  });
});
