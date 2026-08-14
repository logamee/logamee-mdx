import {
  AnnotationMode,
  getDocument,
  PDFWorker,
} from 'pdfjs-dist';
import type { PdfAssetManifest } from './pdfAssetManifest';
import {
  PDF_PREVIEW_LIMITS,
  PdfCancelledError,
  PdfCanvasBudget,
  PdfDeadlineError,
  PdfResourceLimitError,
  assertPdfPageCount,
  decodePdfBase64,
  getPdfCanvasAllocation,
  runPdfPageQueue,
} from './pdfRenderScheduler';

export interface StartPdfPreviewOptions {
  assetManifest: PdfAssetManifest;
  bytesBase64: string;
  container: HTMLElement;
  zoomPercent: number;
}

export interface PdfPreviewRun {
  cancel: () => void;
  done: Promise<void>;
}

type PdfLoadingTask = ReturnType<typeof getDocument>;
type PdfDocument = Awaited<PdfLoadingTask['promise']>;
type PdfPage = Awaited<ReturnType<PdfDocument['getPage']>>;
type PdfRenderTask = ReturnType<PdfPage['render']>;
const PdfWorkerWithPort = PDFWorker as unknown as new (
  options: { port: Worker },
) => PDFWorker;

interface OwnedCanvas {
  canvas: HTMLCanvasElement;
  owner: string;
  pageNumber: number;
}

interface PdfPreviewJob {
  abortController: AbortController;
  budget: PdfCanvasBudget;
  callerCancelled: boolean;
  canvases: Map<string, OwnedCanvas>;
  deadlineError: PdfDeadlineError | null;
  loadingTask: PdfLoadingTask | null;
  nativeWorker: Worker | null;
  nativeWorkerTerminated: boolean;
  pdfWorker: PDFWorker | null;
  pdfWorkerDestroyed: boolean;
  renderTasks: Set<PdfRenderTask>;
}

function createJob(): PdfPreviewJob {
  return {
    abortController: new AbortController(),
    budget: new PdfCanvasBudget(),
    callerCancelled: false,
    canvases: new Map(),
    deadlineError: null,
    loadingTask: null,
    nativeWorker: null,
    nativeWorkerTerminated: false,
    pdfWorker: null,
    pdfWorkerDestroyed: false,
    renderTasks: new Set(),
  };
}

function cancelRenderTasks(job: PdfPreviewJob): void {
  for (const renderTask of job.renderTasks) {
    try {
      renderTask.cancel();
    } catch {
      // Cleanup must continue even if PDF.js reports an already-finished task.
    }
  }
}

function releaseCanvases(job: PdfPreviewJob): void {
  for (const { canvas, owner } of job.canvases.values()) {
    canvas.width = 0;
    canvas.height = 0;
    canvas.remove();
    job.budget.release(owner);
  }
  job.canvases.clear();
  job.budget.releaseAll();
}

function terminateNativeWorker(job: PdfPreviewJob): void {
  if (!job.nativeWorker || job.nativeWorkerTerminated) return;
  job.nativeWorkerTerminated = true;
  job.nativeWorker.terminate();
}

function destroyPdfWorker(job: PdfPreviewJob): void {
  if (!job.pdfWorker || job.pdfWorkerDestroyed) return;
  job.pdfWorkerDestroyed = true;
  job.pdfWorker.destroy();
}

function stopForDeadline(job: PdfPreviewJob): void {
  job.deadlineError ??= new PdfDeadlineError();
  job.abortController.abort();
  cancelRenderTasks(job);
  releaseCanvases(job);
  terminateNativeWorker(job);
}

function throwIfStopped(job: PdfPreviewJob): void {
  if (job.deadlineError) throw job.deadlineError;
  if (job.abortController.signal.aborted) throw new PdfCancelledError();
}

function waitForPdfOperation<T>(
  job: PdfPreviewJob,
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      job.abortController.signal.removeEventListener('abort', handleAbort);
    };
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const handleAbort = () => {
      settle(() => reject(job.deadlineError ?? new PdfCancelledError()));
    };

    if (job.abortController.signal.aborted) {
      handleAbort();
      return;
    }

    job.abortController.signal.addEventListener('abort', handleAbort, { once: true });
    timeoutId = setTimeout(() => {
      settle(() => {
        try {
          onTimeout();
        } finally {
          reject(job.deadlineError ?? new PdfDeadlineError());
        }
      });
    }, timeoutMs);

    promise.then(
      (value) => settle(() => resolve(value)),
      (error: unknown) => settle(() => reject(error)),
    );
  });
}

function getOutputScale(): number {
  const scale = window.devicePixelRatio;
  if (!Number.isFinite(scale) || scale <= 0) throw new PdfResourceLimitError();
  return scale;
}

function insertCanvasInPageOrder(
  container: HTMLElement,
  job: PdfPreviewJob,
  canvas: HTMLCanvasElement,
  pageNumber: number,
): void {
  const nextCanvas = Array.from(job.canvases.values())
    .filter((entry) => entry.pageNumber > pageNumber && entry.canvas.isConnected)
    .sort((left, right) => left.pageNumber - right.pageNumber)[0]?.canvas ?? null;
  container.insertBefore(canvas, nextCanvas);
}

async function renderPdfPage(
  job: PdfPreviewJob,
  document: PdfDocument,
  container: HTMLElement,
  pageNumber: number,
  zoomPercent: number,
  outputScale: number,
): Promise<void> {
  throwIfStopped(job);
  const page = await document.getPage(pageNumber);
  throwIfStopped(job);

  const viewport = page.getViewport({ scale: zoomPercent / 100 });
  const allocation = getPdfCanvasAllocation(viewport.width, viewport.height, outputScale);
  const owner = `page-${pageNumber}`;
  job.budget.reserve(owner, allocation.pixels);

  let canvas: HTMLCanvasElement;
  try {
    canvas = documentOwner(container).createElement('canvas');
  } catch (error) {
    job.budget.release(owner);
    throw error;
  }
  canvas.dataset.pageNumber = String(pageNumber);
  canvas.width = allocation.width;
  canvas.height = allocation.height;
  canvas.style.width = `${viewport.width}px`;
  canvas.style.height = `${viewport.height}px`;
  job.canvases.set(owner, { canvas, owner, pageNumber });

  throwIfStopped(job);
  const renderTask = page.render({
    annotationMode: AnnotationMode.DISABLE,
    canvas,
    transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0],
    viewport,
  });
  job.renderTasks.add(renderTask);
  try {
    await waitForPdfOperation(
      job,
      renderTask.promise,
      PDF_PREVIEW_LIMITS.pageTimeoutMs,
      () => stopForDeadline(job),
    );
    throwIfStopped(job);
    insertCanvasInPageOrder(container, job, canvas, pageNumber);
  } finally {
    job.renderTasks.delete(renderTask);
  }
}

function documentOwner(container: HTMLElement): Document {
  return container.ownerDocument ?? document;
}

async function disposePdfJob(job: PdfPreviewJob): Promise<void> {
  const forceStop = job.deadlineError !== null || job.callerCancelled;
  const renderTasks = [...job.renderTasks];
  cancelRenderTasks(job);

  if (forceStop) {
    for (const task of renderTasks) void task.promise.catch(() => undefined);
  } else {
    await Promise.allSettled(renderTasks.map((task) => task.promise));
  }

  let cleanupError: unknown;
  if (job.loadingTask) {
    try {
      const destroyPromise = job.loadingTask.destroy();
      if (forceStop) void destroyPromise.catch(() => undefined);
      else await destroyPromise;
    } catch (error) {
      cleanupError = error;
    }
  }

  try {
    destroyPdfWorker(job);
  } catch (error) {
    cleanupError ??= error;
  } finally {
    try {
      terminateNativeWorker(job);
    } catch (error) {
      cleanupError ??= error;
    }
  }

  if (cleanupError !== undefined) throw cleanupError;
}

function normalizeFailure(job: PdfPreviewJob, error: unknown): unknown {
  if (job.deadlineError) return job.deadlineError;
  if (job.callerCancelled) return new PdfCancelledError();
  return error;
}

async function runPdfPreview(
  options: StartPdfPreviewOptions,
  job: PdfPreviewJob,
): Promise<void> {
  let completed = false;
  let failure: unknown;

  try {
    if (!Number.isFinite(options.zoomPercent) || options.zoomPercent <= 0) {
      throw new PdfResourceLimitError();
    }

    const previewBytes = decodePdfBase64(options.bytesBase64).slice();
    const outputScale = getOutputScale();
    throwIfStopped(job);

    job.nativeWorker = new Worker(
      new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url),
      { name: 'mmd-pdf-preview', type: 'module' },
    );
    job.pdfWorker = new PdfWorkerWithPort({ port: job.nativeWorker });
    job.loadingTask = getDocument({
      cMapPacked: true,
      cMapUrl: options.assetManifest.cmap_base_url,
      data: previewBytes,
      disableAutoFetch: true,
      disableRange: true,
      disableStream: true,
      enableXfa: false,
      standardFontDataUrl: options.assetManifest.standard_font_base_url,
      stopAtErrors: true,
      useSystemFonts: false,
      useWasm: false,
      useWorkerFetch: false,
      wasmUrl: options.assetManifest.wasm_base_url,
      worker: job.pdfWorker,
    });

    let renderQueue: Promise<void> | null = null;
    const preparedDocument = job.loadingTask.promise.then((pdfDocument) => {
      throwIfStopped(job);
      assertPdfPageCount(pdfDocument.numPages);
      renderQueue = runPdfPageQueue({
        pageCount: pdfDocument.numPages,
        signal: job.abortController.signal,
        renderPage: (pageNumber) => renderPdfPage(
          job,
          pdfDocument,
          options.container,
          pageNumber,
          options.zoomPercent,
          outputScale,
        ),
      });
      void renderQueue.catch(() => undefined);
      return pdfDocument;
    });

    await waitForPdfOperation(
      job,
      preparedDocument,
      PDF_PREVIEW_LIMITS.parseTimeoutMs,
      () => stopForDeadline(job),
    );
    throwIfStopped(job);
    if (!renderQueue) throw new Error('PDF render queue was not initialized');
    await renderQueue;
    throwIfStopped(job);
    completed = true;
  } catch (error) {
    failure = normalizeFailure(job, error);
    job.abortController.abort();
    cancelRenderTasks(job);
    releaseCanvases(job);
  }

  try {
    await disposePdfJob(job);
  } catch (error) {
    if (failure === undefined) failure = error;
    completed = false;
    releaseCanvases(job);
  }

  if (!completed) throw failure;
}

export function startPdfPreview(options: StartPdfPreviewOptions): PdfPreviewRun {
  const job = createJob();
  const done = runPdfPreview(options, job);

  return {
    cancel: () => {
      if (job.callerCancelled) return;
      job.callerCancelled = true;
      job.abortController.abort();
      cancelRenderTasks(job);
      releaseCanvases(job);
    },
    done,
  };
}
