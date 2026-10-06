import type { PDFWorker } from 'pdfjs-dist';
import type { getDocument } from 'pdfjs-dist';
import { PdfCanvasBudget, PdfCancelledError, PdfDeadlineError } from './pdfRenderScheduler';

export type PdfLoadingTask = ReturnType<typeof getDocument>;
export type PdfDocument = Awaited<PdfLoadingTask['promise']>;
type PdfPage = Awaited<ReturnType<PdfDocument['getPage']>>;
type PdfRenderTask = ReturnType<PdfPage['render']>;

export interface OwnedCanvas {
  canvas: HTMLCanvasElement;
  owner: string;
  pageNumber: number;
}

export interface PdfPreviewJob {
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

export function createJob(): PdfPreviewJob {
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

export function cancelRenderTasks(job: PdfPreviewJob): void {
  for (const renderTask of job.renderTasks) {
    try {
      renderTask.cancel();
    } catch {
      // Cleanup must continue even if PDF.js reports an already-finished task.
    }
  }
}

export function releaseCanvases(job: PdfPreviewJob): void {
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

export function stopForDeadline(job: PdfPreviewJob): void {
  job.deadlineError ??= new PdfDeadlineError();
  job.abortController.abort();
  cancelRenderTasks(job);
  releaseCanvases(job);
  terminateNativeWorker(job);
}

export function throwIfStopped(job: PdfPreviewJob): void {
  if (job.deadlineError) throw job.deadlineError;
  if (job.abortController.signal.aborted) throw new PdfCancelledError();
}

// PDF.js 操作护栏：中止信号或超时先到即落败并回调止损。
export function waitForPdfOperation<T>(
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

export function normalizeFailure(job: PdfPreviewJob, error: unknown): unknown {
  if (job.deadlineError) return job.deadlineError;
  if (job.callerCancelled) return new PdfCancelledError();
  return error;
}

// 文档销毁：强停时吞掉销毁承诺，优雅停时等待其落定。
async function disposeLoadingTask(job: PdfPreviewJob, forceStop: boolean): Promise<unknown> {
  if (!job.loadingTask) return undefined;
  try {
    const destroyPromise = job.loadingTask.destroy();
    if (forceStop) void destroyPromise.catch(() => undefined);
    else await destroyPromise;
  } catch (error) {
    return error;
  }
  return undefined;
}

// 工作线程销毁：PDF worker 与原生 worker 依次清理，错误向上聚合。
function disposeWorkers(job: PdfPreviewJob): unknown {
  let cleanupError: unknown;
  try {
    destroyPdfWorker(job);
  } catch (error) {
    cleanupError = error;
  } finally {
    try {
      terminateNativeWorker(job);
    } catch (error) {
      cleanupError ??= error;
    }
  }
  return cleanupError;
}

export async function disposePdfJob(job: PdfPreviewJob): Promise<void> {
  const forceStop = job.deadlineError !== null || job.callerCancelled;
  const renderTasks = [...job.renderTasks];
  cancelRenderTasks(job);

  if (forceStop) {
    for (const task of renderTasks) void task.promise.catch(() => undefined);
  } else {
    await Promise.allSettled(renderTasks.map((task) => task.promise));
  }

  const loadingError = await disposeLoadingTask(job, forceStop);
  const cleanupError = loadingError ?? disposeWorkers(job);
  if (cleanupError !== undefined) throw cleanupError;
}
