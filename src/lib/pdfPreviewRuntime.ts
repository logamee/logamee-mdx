import { getDocument, PDFWorker } from 'pdfjs-dist';
import type { PdfAssetManifest } from './pdfAssetManifest';
import {
  PDF_PREVIEW_LIMITS,
  PdfResourceLimitError,
  assertPdfPageCount,
  decodePdfBase64,
  runPdfPageQueue,
} from './pdfRenderScheduler';
import {
  cancelRenderTasks,
  createJob,
  disposePdfJob,
  normalizeFailure,
  releaseCanvases,
  stopForDeadline,
  throwIfStopped,
  waitForPdfOperation,
  type PdfDocument,
  type PdfLoadingTask,
  type PdfPreviewJob,
} from './pdfPreviewJob';
import { getOutputScale, renderPdfPage } from './pdfPreviewPage';

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

const PdfWorkerWithPort = PDFWorker as unknown as new (
  options: { port: Worker },
) => PDFWorker;

function getValidatedOutputScale(zoomPercent: number): number {
  if (!Number.isFinite(zoomPercent) || zoomPercent <= 0) {
    throw new PdfResourceLimitError();
  }
  return getOutputScale();
}

// 启动解析管线：原生 worker + PDF worker 端口 + 禁流式拉取的加载任务。
function launchPdfLoadingTask(
  options: StartPdfPreviewOptions,
  job: PdfPreviewJob,
  previewBytes: Uint8Array,
): PdfLoadingTask {
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
  return job.loadingTask;
}

// 解析落定后按队列渲染全部页面，渲染队列随解析承诺一起接受超时护栏。
async function renderLoadedPages(
  options: StartPdfPreviewOptions,
  job: PdfPreviewJob,
  loadingTask: PdfLoadingTask,
  outputScale: number,
): Promise<void> {
  let renderQueue: Promise<void> | null = null;
  const preparedDocument = loadingTask.promise.then((pdfDocument: PdfDocument) => {
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
}

// 释放文档与工作线程；清理失败不抛出，返回错误由调用方聚合。
async function awaitDisposal(job: PdfPreviewJob): Promise<unknown> {
  try {
    await disposePdfJob(job);
    return undefined;
  } catch (error) {
    return error;
  }
}

async function runPdfPreview(
  options: StartPdfPreviewOptions,
  job: PdfPreviewJob,
): Promise<void> {
  let completed = false;
  let failure: unknown;

  try {
    const outputScale = getValidatedOutputScale(options.zoomPercent);
    const previewBytes = decodePdfBase64(options.bytesBase64).slice();
    throwIfStopped(job);
    const loadingTask = launchPdfLoadingTask(options, job, previewBytes);
    await renderLoadedPages(options, job, loadingTask, outputScale);
    completed = true;
  } catch (error) {
    failure = normalizeFailure(job, error);
    job.abortController.abort();
    cancelRenderTasks(job);
    releaseCanvases(job);
  }

  const disposalError = await awaitDisposal(job);
  if (disposalError !== undefined) {
    if (failure === undefined) failure = disposalError;
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
