// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PdfAssetManifest } from './pdfAssetManifest';
import {
  PDF_PREVIEW_LIMITS,
  PdfCancelledError,
  PdfDeadlineError,
  PdfResourceLimitError,
} from './pdfRenderScheduler';
import { startPdfPreview } from './pdfPreviewRuntime';

interface Deferred<T> {
  promise: Promise<T>;
  reject: (reason?: unknown) => void;
  resolve: (value: T) => void;
}

interface FakeRenderTask {
  cancel: ReturnType<typeof vi.fn<() => void>>;
  promise: Promise<void>;
}

interface FakePage {
  forbidden: Array<ReturnType<typeof vi.fn<() => void>>>;
  getViewport: ReturnType<typeof vi.fn<(options: { scale: number }) => {
    height: number;
    width: number;
  }>>;
  render: ReturnType<typeof vi.fn<(options: Record<string, unknown>) => FakeRenderTask>>;
}

interface FakeDocument {
  getPage: ReturnType<typeof vi.fn<(pageNumber: number) => Promise<FakePage>>>;
  numPages: number;
}

interface FakeLoadingTask {
  destroy: ReturnType<typeof vi.fn<() => Promise<void>>>;
  promise: Promise<FakeDocument>;
}

const pdfjsMock = vi.hoisted(() => ({
  getDocument: vi.fn<(options: Record<string, unknown>) => FakeLoadingTask>(),
  pdfWorkers: [] as Array<{
    destroy: ReturnType<typeof vi.fn<() => void>>;
    port: Worker;
  }>,
}));

vi.mock('pdfjs-dist', () => ({
  AnnotationMode: { DISABLE: 0 },
  getDocument: pdfjsMock.getDocument,
  PDFWorker: class FakePdfWorker {
    readonly destroy = vi.fn<() => void>();
    readonly port: Worker;

    constructor({ port }: { port: Worker }) {
      this.port = port;
      pdfjsMock.pdfWorkers.push(this);
    }
  },
}));

const manifest: PdfAssetManifest = {
  schema_version: 1,
  pdfjs_version: '6.1.200',
  worker_url: '/vendor/pdfjs/6.1.200/build/pdf.worker.min.mjs',
  cmap_base_url: '/vendor/pdfjs/6.1.200/cmaps/',
  standard_font_base_url: '/vendor/pdfjs/6.1.200/standard_fonts/',
  wasm_base_url: '/vendor/pdfjs/6.1.200/wasm/',
  files: [
    {
      url: '/vendor/pdfjs/6.1.200/build/pdf.worker.min.mjs',
      sha256: '0'.repeat(64),
    },
  ],
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function flushMicrotasks(turns = 12): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) await Promise.resolve();
}

function resolvedRenderTask(): FakeRenderTask {
  return { cancel: vi.fn<() => void>(), promise: Promise.resolve() };
}

function createPage(
  width = 100,
  height = 200,
  renderTaskFactory: () => FakeRenderTask = resolvedRenderTask,
): FakePage {
  const forbidden = Array.from({ length: 7 }, () => vi.fn<() => void>());
  return {
    forbidden,
    getViewport: vi.fn<(options: { scale: number }) => { height: number; width: number }>(
      ({ scale }) => ({ width: width * scale, height: height * scale }),
    ),
    render: vi.fn<(options: Record<string, unknown>) => FakeRenderTask>(
      () => renderTaskFactory(),
    ),
    getAnnotations: forbidden[0],
    getAnnotationsByType: forbidden[1],
    getAttachments: forbidden[2],
    getAttachmentContent: forbidden[3],
    getJSActions: forbidden[4],
    getOpenAction: forbidden[5],
    getXfa: forbidden[6],
  } as FakePage;
}

function createDocument(pages: FakePage[]): FakeDocument {
  return {
    numPages: pages.length,
    getPage: vi.fn<(pageNumber: number) => Promise<FakePage>>(
      async (pageNumber) => pages[pageNumber - 1]!,
    ),
  };
}

function loadingTask(document: FakeDocument | Promise<FakeDocument>): FakeLoadingTask {
  return {
    promise: Promise.resolve(document),
    destroy: vi.fn<() => Promise<void>>(async () => undefined),
  };
}

class FakeNativeWorker {
  static readonly instances: FakeNativeWorker[] = [];

  readonly terminate = vi.fn<() => void>();

  constructor(
    readonly scriptURL: string | URL,
    readonly options?: WorkerOptions,
  ) {
    FakeNativeWorker.instances.push(this);
  }
}

describe('PDF.js preview runtime', () => {
  let container: HTMLDivElement;
  let createObjectUrl: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    pdfjsMock.getDocument.mockReset();
    pdfjsMock.pdfWorkers.splice(0);
    FakeNativeWorker.instances.splice(0);
    vi.stubGlobal('Worker', FakeNativeWorker);
    createObjectUrl = vi.fn<() => string>();
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: createObjectUrl,
    });
    Object.defineProperty(window, 'devicePixelRatio', {
      configurable: true,
      value: 2,
    });
  });

  afterEach(() => {
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('uses verified local assets, an explicit module worker, bytes-only loading, and canvas-only rendering', async () => {
    const pages = [createPage(), createPage(), createPage()];
    const task = loadingTask(createDocument(pages));
    pdfjsMock.getDocument.mockReturnValueOnce(task);

    const run = startPdfPreview({
      assetManifest: manifest,
      bytesBase64: 'JVBERi0xLjQ=',
      container,
      zoomPercent: 100,
    });
    await run.done;

    expect(FakeNativeWorker.instances).toHaveLength(1);
    expect(FakeNativeWorker.instances[0]?.scriptURL).toBeInstanceOf(URL);
    expect(String(FakeNativeWorker.instances[0]?.scriptURL)).toContain('pdf.worker.min.mjs');
    expect(FakeNativeWorker.instances[0]?.options).toEqual({
      name: 'mmd-pdf-preview',
      type: 'module',
    });
    expect(pdfjsMock.pdfWorkers).toHaveLength(1);
    expect(pdfjsMock.pdfWorkers[0]?.port).toBe(FakeNativeWorker.instances[0]);
    expect(createObjectUrl).not.toHaveBeenCalled();

    const options = pdfjsMock.getDocument.mock.calls[0]?.[0];
    expect(options).toMatchObject({
      cMapPacked: true,
      cMapUrl: manifest.cmap_base_url,
      disableAutoFetch: true,
      disableRange: true,
      disableStream: true,
      enableXfa: false,
      standardFontDataUrl: manifest.standard_font_base_url,
      stopAtErrors: true,
      useSystemFonts: false,
      useWasm: false,
      useWorkerFetch: false,
      wasmUrl: manifest.wasm_base_url,
      worker: pdfjsMock.pdfWorkers[0],
    });
    expect(options?.data).toBeInstanceOf(Uint8Array);
    expect(Array.from(options?.data as Uint8Array)).toEqual([
      0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34,
    ]);
    for (const forbiddenOption of [
      'url',
      'range',
      'docBaseUrl',
      'httpHeaders',
      'withCredentials',
      'iccUrl',
      'isEvalSupported',
    ]) {
      expect(options).not.toHaveProperty(forbiddenOption);
    }

    const canvases = Array.from(container.querySelectorAll('canvas'));
    expect(canvases.map((canvas) => canvas.dataset.pageNumber)).toEqual(['1', '2', '3']);
    expect(canvases.every((canvas) => canvas.width === 200 && canvas.height === 400)).toBe(true);
    expect(container.querySelector('a, form, input, object, embed, iframe')).toBeNull();
    expect(container.querySelector('[class*="annotation"], [class*="text-layer"], [class*="xfa"]')).toBeNull();
    for (const page of pages) {
      expect(page.render).toHaveBeenCalledOnce();
      expect(page.render.mock.calls[0]?.[0]).toMatchObject({
        annotationMode: 0,
        canvas: expect.any(HTMLCanvasElement),
      });
      expect(page.forbidden.every((method) => method.mock.calls.length === 0)).toBe(true);
    }

    expect(task.destroy).toHaveBeenCalledOnce();
    expect(pdfjsMock.pdfWorkers[0]?.destroy).toHaveBeenCalledOnce();
    expect(FakeNativeWorker.instances[0]?.terminate).toHaveBeenCalledOnce();
  });

  it('cancels both live render tasks, releases canvases, and never starts a later page', async () => {
    const pendingTasks = [deferred<void>(), deferred<void>()];
    const renderTasks = pendingTasks.map((pending) => ({
      cancel: vi.fn<() => void>(() => pending.reject(new Error('render cancelled'))),
      promise: pending.promise,
    }));
    const pages = [
      createPage(100, 100, () => renderTasks[0]!),
      createPage(100, 100, () => renderTasks[1]!),
      createPage(),
    ];
    const task = loadingTask(createDocument(pages));
    pdfjsMock.getDocument.mockReturnValueOnce(task);
    const run = startPdfPreview({
      assetManifest: manifest,
      bytesBase64: 'JVBERg==',
      container,
      zoomPercent: 100,
    });
    void run.done.catch(() => undefined);

    await Promise.resolve();
    await Promise.resolve();
    run.cancel();
    await expect(run.done).rejects.toBeInstanceOf(PdfCancelledError);

    expect(renderTasks.every(({ cancel }) => cancel.mock.calls.length >= 1)).toBe(true);
    expect(pages[2]!.render).not.toHaveBeenCalled();
    expect(container.querySelector('canvas')).toBeNull();
    expect(task.destroy).toHaveBeenCalledOnce();
    expect(pdfjsMock.pdfWorkers[0]?.destroy).toHaveBeenCalledOnce();
    expect(FakeNativeWorker.instances[0]?.terminate).toHaveBeenCalledOnce();
  });

  it('force-stops a pending parse when loading-task destruction never settles', async () => {
    const parse = deferred<FakeDocument>();
    const destruction = deferred<void>();
    const observeDestructionRejection = vi.spyOn(destruction.promise, 'catch');
    const task: FakeLoadingTask = {
      promise: parse.promise,
      destroy: vi.fn<() => Promise<void>>(() => destruction.promise),
    };
    pdfjsMock.getDocument.mockReturnValueOnce(task);
    const rejected = vi.fn<(error: unknown) => void>();
    const run = startPdfPreview({
      assetManifest: manifest,
      bytesBase64: 'JVBERg==',
      container,
      zoomPercent: 100,
    });
    void run.done.catch(rejected);

    run.cancel();
    await flushMicrotasks();

    try {
      expect(rejected).toHaveBeenCalledOnce();
      expect(rejected.mock.calls[0]?.[0]).toBeInstanceOf(PdfCancelledError);
      expect(task.destroy).toHaveBeenCalledOnce();
      expect(observeDestructionRejection).toHaveBeenCalledOnce();
      expect(pdfjsMock.pdfWorkers[0]?.destroy).toHaveBeenCalledOnce();
      expect(FakeNativeWorker.instances[0]?.terminate).toHaveBeenCalledOnce();
      expect(container.querySelector('canvas')).toBeNull();
    } finally {
      parse.reject(new Error('late parse rejection'));
      destruction.reject(new Error('late destroy rejection'));
      await run.done.catch(() => undefined);
    }

    expect(container.querySelector('canvas')).toBeNull();
  });

  it('force-stops a live render whose cancellation promise never settles', async () => {
    const rendering = deferred<void>();
    const destruction = deferred<void>();
    const observeDestructionRejection = vi.spyOn(destruction.promise, 'catch');
    const renderTask = {
      cancel: vi.fn<() => void>(),
      promise: rendering.promise,
    };
    const page = createPage(100, 100, () => renderTask);
    const task: FakeLoadingTask = {
      promise: Promise.resolve(createDocument([page])),
      destroy: vi.fn<() => Promise<void>>(() => destruction.promise),
    };
    pdfjsMock.getDocument.mockReturnValueOnce(task);
    const rejected = vi.fn<(error: unknown) => void>();
    const run = startPdfPreview({
      assetManifest: manifest,
      bytesBase64: 'JVBERg==',
      container,
      zoomPercent: 100,
    });
    void run.done.catch(rejected);
    await flushMicrotasks();
    expect(page.render).toHaveBeenCalledOnce();
    const canvas = page.render.mock.calls[0]?.[0].canvas as HTMLCanvasElement;

    run.cancel();
    await flushMicrotasks();

    try {
      expect(rejected).toHaveBeenCalledOnce();
      expect(rejected.mock.calls[0]?.[0]).toBeInstanceOf(PdfCancelledError);
      expect(renderTask.cancel).toHaveBeenCalled();
      expect(canvas.width).toBe(0);
      expect(canvas.height).toBe(0);
      expect(canvas.isConnected).toBe(false);
      expect(observeDestructionRejection).toHaveBeenCalledOnce();
      expect(pdfjsMock.pdfWorkers[0]?.destroy).toHaveBeenCalledOnce();
      expect(FakeNativeWorker.instances[0]?.terminate).toHaveBeenCalledOnce();
    } finally {
      rendering.reject(new Error('late render rejection'));
      destruction.reject(new Error('late destroy rejection'));
      await run.done.catch(() => undefined);
    }

    expect(canvas.isConnected).toBe(false);
    expect(container.querySelector('canvas')).toBeNull();
  });

  it('rejects excessive pages, page pixels, and aggregate live pixels before unsafe work survives', async () => {
    const tooMany = loadingTask({
      numPages: PDF_PREVIEW_LIMITS.maxPages + 1,
      getPage: vi.fn<(pageNumber: number) => Promise<FakePage>>(),
    });
    pdfjsMock.getDocument.mockReturnValueOnce(tooMany);
    await expect(startPdfPreview({
      assetManifest: manifest,
      bytesBase64: 'JVBERg==',
      container,
      zoomPercent: 100,
    }).done).rejects.toBeInstanceOf(PdfResourceLimitError);
    expect(container.querySelector('canvas')).toBeNull();

    const oversizedPage = createPage(4_001, 4_000);
    pdfjsMock.getDocument.mockReturnValueOnce(loadingTask(createDocument([oversizedPage])));
    await expect(startPdfPreview({
      assetManifest: manifest,
      bytesBase64: 'JVBERg==',
      container,
      zoomPercent: 100,
    }).done).rejects.toBeInstanceOf(PdfResourceLimitError);
    expect(oversizedPage.render).not.toHaveBeenCalled();
    expect(container.querySelector('canvas')).toBeNull();

    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 1 });
    const aggregatePages = [
      createPage(4_000, 8_000),
      createPage(4_000, 8_000),
      createPage(4_000, 8_000),
    ];
    pdfjsMock.getDocument.mockReturnValueOnce(loadingTask(createDocument(aggregatePages)));
    await expect(startPdfPreview({
      assetManifest: manifest,
      bytesBase64: 'JVBERg==',
      container,
      zoomPercent: 100,
    }).done).rejects.toBeInstanceOf(PdfResourceLimitError);
    expect(aggregatePages[2]!.render).not.toHaveBeenCalled();
    expect(container.querySelector('canvas')).toBeNull();
  });

  it('enforces the parse deadline and tears down the external workers', async () => {
    vi.useFakeTimers();
    const parse = deferred<FakeDocument>();
    const task = loadingTask(parse.promise);
    pdfjsMock.getDocument.mockReturnValueOnce(task);
    const run = startPdfPreview({
      assetManifest: manifest,
      bytesBase64: 'JVBERg==',
      container,
      zoomPercent: 100,
    });
    void run.done.catch(() => undefined);

    await vi.advanceTimersByTimeAsync(PDF_PREVIEW_LIMITS.parseTimeoutMs);
    await expect(run.done).rejects.toBeInstanceOf(PdfDeadlineError);

    expect(task.destroy).toHaveBeenCalledOnce();
    expect(pdfjsMock.pdfWorkers[0]?.destroy).toHaveBeenCalledOnce();
    expect(FakeNativeWorker.instances[0]?.terminate).toHaveBeenCalledOnce();
  });

  it('enforces the page deadline and cancels its render task', async () => {
    vi.useFakeTimers();
    const pending = deferred<void>();
    const renderTask = {
      cancel: vi.fn<() => void>(() => pending.reject(new Error('page render timed out'))),
      promise: pending.promise,
    };
    const page = createPage(100, 100, () => renderTask);
    pdfjsMock.getDocument.mockReturnValueOnce(loadingTask(createDocument([page])));
    const run = startPdfPreview({
      assetManifest: manifest,
      bytesBase64: 'JVBERg==',
      container,
      zoomPercent: 100,
    });
    void run.done.catch(() => undefined);

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(PDF_PREVIEW_LIMITS.pageTimeoutMs);
    await expect(run.done).rejects.toBeInstanceOf(PdfDeadlineError);

    expect(renderTask.cancel).toHaveBeenCalled();
    expect(container.querySelector('canvas')).toBeNull();
  });
});
