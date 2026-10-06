import { AnnotationMode } from 'pdfjs-dist';
import { PdfResourceLimitError, getPdfCanvasAllocation } from './pdfRenderScheduler';
import {
  stopForDeadline,
  throwIfStopped,
  waitForPdfOperation,
  type OwnedCanvas,
  type PdfDocument,
  type PdfPreviewJob,
} from './pdfPreviewJob';
import { PDF_PREVIEW_LIMITS } from './pdfRenderScheduler';

export function getOutputScale(): number {
  const scale = window.devicePixelRatio;
  if (!Number.isFinite(scale) || scale <= 0) throw new PdfResourceLimitError();
  return scale;
}

function documentOwner(container: HTMLElement): Document {
  return container.ownerDocument ?? document;
}

// 画布按页码插入到首个更大页码的已连接画布之前，保持文档顺序。
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

// 页面画布准备：预算占位、创建画布并按视口尺寸写入属性。
function preparePageCanvas(
  container: HTMLElement,
  job: PdfPreviewJob,
  pageNumber: number,
  viewport: { height: number; width: number },
  outputScale: number,
): HTMLCanvasElement {
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
  job.canvases.set(owner, { canvas, owner, pageNumber } satisfies OwnedCanvas);
  return canvas;
}

export async function renderPdfPage(
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
  const canvas = preparePageCanvas(container, job, pageNumber, viewport, outputScale);

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
