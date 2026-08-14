// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PdfAssetManifest } from '../lib/pdfAssetManifest';
import type { PdfPreviewRun } from '../lib/pdfPreviewRuntime';
import { PdfPreview, type PdfPreviewFeedback } from './PdfPreview';

interface Deferred<T = void> {
  promise: Promise<T>;
  reject: (reason?: unknown) => void;
  resolve: (value: T) => void;
}

const runtimeMock = vi.hoisted(() => ({
  startPdfPreview: vi.fn<typeof import('../lib/pdfPreviewRuntime').startPdfPreview>(),
}));
const manifestMock = vi.hoisted(() => ({
  loadPdfAssetManifest: vi.fn<
    typeof import('../lib/pdfAssetManifest').loadPdfAssetManifest
  >(),
}));

vi.mock('../lib/pdfPreviewRuntime', () => ({
  startPdfPreview: runtimeMock.startPdfPreview,
}));
vi.mock('../lib/pdfAssetManifest', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/pdfAssetManifest')>(),
  loadPdfAssetManifest: manifestMock.loadPdfAssetManifest,
}));

const manifest: PdfAssetManifest = {
  schema_version: 1,
  pdfjs_version: '6.1.200',
  worker_url: '/assets/pdf.worker.min-BAKOMYW7.js',
  cmap_base_url: '/vendor/pdfjs/6.1.200/cmaps/',
  standard_font_base_url: '/vendor/pdfjs/6.1.200/standard_fonts/',
  wasm_base_url: '/vendor/pdfjs/6.1.200/wasm/',
  files: [
    {
      url: '/assets/pdf.worker.min-BAKOMYW7.js',
      sha256: '0'.repeat(64),
    },
  ],
};

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const element = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!element) throw new Error(`Expected button: ${label}`);
  return element;
}

describe('PdfPreview', () => {
  let container: HTMLDivElement;
  let root: Root;
  let runs: Array<Deferred & { cancel: ReturnType<typeof vi.fn<() => void>> }>;
  let onFeedback: ReturnType<typeof vi.fn<(feedback: PdfPreviewFeedback) => void>>;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    runs = [];
    onFeedback = vi.fn<(feedback: PdfPreviewFeedback) => void>();
    manifestMock.loadPdfAssetManifest.mockReset();
    manifestMock.loadPdfAssetManifest.mockResolvedValue(manifest);
    runtimeMock.startPdfPreview.mockReset();
    runtimeMock.startPdfPreview.mockImplementation(() => {
      const pending = deferred();
      const run = { ...pending, cancel: vi.fn<() => void>() };
      runs.push(run);
      return { cancel: run.cancel, done: run.promise } satisfies PdfPreviewRun;
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('starts at 100 percent with stable accessible controls and a scroll viewport', async () => {
    await act(async () => root.render(
      <PdfPreview
        assetManifest={manifest}
        bytesBase64="JVBERg=="
        documentEpoch={1}
        documentId="document-a"
        onFeedback={onFeedback}
      />,
    ));

    expect(runtimeMock.startPdfPreview).toHaveBeenCalledOnce();
    expect(runtimeMock.startPdfPreview.mock.calls[0]?.[0]).toMatchObject({
      assetManifest: manifest,
      bytesBase64: 'JVBERg==',
      zoomPercent: 100,
    });
    const viewport = container.querySelector('.pdf-preview-viewport');
    expect(viewport).not.toBeNull();
    expect(viewport?.getAttribute('aria-busy')).toBe('true');
    expect(button(container, 'Zoom out').disabled).toBe(false);
    expect(container.querySelector('.preview-zoom-value')?.textContent).toBe('100%');
    expect(button(container, 'Zoom in').disabled).toBe(false);
  });

  it('loads and validates the fixed local manifest before starting an uninjected runtime', async () => {
    const pendingManifest = deferred<PdfAssetManifest>();
    manifestMock.loadPdfAssetManifest.mockReturnValueOnce(pendingManifest.promise);
    await act(async () => root.render(
      <PdfPreview
        bytesBase64="JVBERg=="
        documentEpoch={1}
        documentId="document-a"
        onFeedback={onFeedback}
      />,
    ));

    expect(manifestMock.loadPdfAssetManifest).toHaveBeenCalledOnce();
    expect(runtimeMock.startPdfPreview).not.toHaveBeenCalled();

    await act(async () => pendingManifest.resolve(manifest));
    expect(runtimeMock.startPdfPreview).toHaveBeenCalledOnce();
    expect(runtimeMock.startPdfPreview.mock.lastCall?.[0].assetManifest).toBe(manifest);
  });

  it('cancels and restarts rendering for zoom, clamps controls, and resets on a newer document epoch', async () => {
    await act(async () => root.render(
      <PdfPreview
        assetManifest={manifest}
        bytesBase64="JVBERg=="
        documentEpoch={1}
        documentId="document-a"
        onFeedback={onFeedback}
      />,
    ));

    for (let percent = 110; percent <= 200; percent += 10) {
      act(() => button(container, 'Zoom in').click());
      expect(runtimeMock.startPdfPreview.mock.lastCall?.[0].zoomPercent).toBe(percent);
    }
    expect(button(container, 'Zoom in').disabled).toBe(true);
    expect(runs.slice(0, -1).every(({ cancel }) => cancel.mock.calls.length === 1)).toBe(true);

    await act(async () => root.render(
      <PdfPreview
        assetManifest={manifest}
        bytesBase64="JVBERi0xLjQ="
        documentEpoch={2}
        documentId="document-a"
        onFeedback={onFeedback}
      />,
    ));
    expect(runtimeMock.startPdfPreview.mock.lastCall?.[0]).toMatchObject({
      bytesBase64: 'JVBERi0xLjQ=',
      zoomPercent: 100,
    });
    expect(container.querySelector('.preview-zoom-value')?.textContent).toBe('100%');
  });

  it('suppresses stale failure and routes the current friendly failure through onFeedback once', async () => {
    await act(async () => root.render(
      <PdfPreview
        assetManifest={manifest}
        bytesBase64="JVBERg=="
        documentEpoch={1}
        documentId="document-a"
        onFeedback={onFeedback}
      />,
    ));
    act(() => button(container, 'Zoom in').click());

    await act(async () => runs[0]!.reject(new Error('internal stale renderer detail')));
    expect(onFeedback).not.toHaveBeenCalled();

    await act(async () => runs[1]!.reject(new Error('internal current renderer detail')));
    expect(onFeedback).toHaveBeenCalledOnce();
    expect(onFeedback).toHaveBeenCalledWith({
      kind: 'error',
      message: 'This PDF could not be displayed. The file may be damaged or unsupported.',
    });
    expect(container.textContent).not.toContain('internal current renderer detail');
    expect(container.querySelector('.pdf-preview-viewport')?.getAttribute('aria-busy')).toBe('false');

    act(() => button(container, 'Zoom in').click());
    await act(async () => runs[2]!.reject(new Error('same identity, later zoom failure')));
    expect(onFeedback).toHaveBeenCalledOnce();

    await act(async () => root.render(
      <PdfPreview
        assetManifest={manifest}
        bytesBase64="JVBERi0xLjQ="
        documentEpoch={2}
        documentId="document-b"
        onFeedback={onFeedback}
      />,
    ));
    await act(async () => runs[3]!.reject(new Error('new identity failure')));
    expect(onFeedback).toHaveBeenCalledTimes(2);
  });

  it('does not decode or start a worker before preview authority is enabled', async () => {
    await act(async () => root.render(
      <PdfPreview
        assetManifest={manifest}
        bytesBase64="JVBERg=="
        documentEpoch={1}
        documentId="document-a"
        enabled={false}
        onFeedback={onFeedback}
      />,
    ));

    expect(runtimeMock.startPdfPreview).not.toHaveBeenCalled();
    expect(manifestMock.loadPdfAssetManifest).not.toHaveBeenCalled();
    expect(container.querySelector('canvas')).toBeNull();
  });
});
