// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DocxPreviewResult,
  DocxPreviewRun,
} from '../lib/docxPreviewRuntime';
import { DocxPreview, type DocxPreviewFeedback } from './DocxPreview';

interface Deferred<T> {
  promise: Promise<T>;
  reject: (reason?: unknown) => void;
  resolve: (value: T) => void;
}

const runtimeMock = vi.hoisted(() => ({
  startDocxPreview: vi.fn<typeof import('../lib/docxPreviewRuntime').startDocxPreview>(),
}));

vi.mock('../lib/docxPreviewRuntime', () => ({
  startDocxPreview: runtimeMock.startDocxPreview,
}));

function deferred<T>(): Deferred<T> {
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

describe('DocxPreview', () => {
  let container: HTMLDivElement;
  let root: Root;
  let runs: Array<Deferred<DocxPreviewResult> & { cancel: ReturnType<typeof vi.fn> }>;
  let onFeedback: ReturnType<typeof vi.fn<(feedback: DocxPreviewFeedback) => void>>;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    runs = [];
    onFeedback = vi.fn<(feedback: DocxPreviewFeedback) => void>();
    runtimeMock.startDocxPreview.mockReset();
    runtimeMock.startDocxPreview.mockImplementation(() => {
      const pending = deferred<DocxPreviewResult>();
      const run = { ...pending, cancel: vi.fn<() => void>() };
      runs.push(run);
      return { cancel: run.cancel, done: run.promise } satisfies DocxPreviewRun;
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('renders only completed safe HTML in a stable viewport and blocks every anchor click', async () => {
    await act(async () => root.render(
      <DocxPreview
        bytesBase64="AQIDBA=="
        documentEpoch={1}
        documentId="document-a"
        onFeedback={onFeedback}
      />,
    ));
    expect(runtimeMock.startDocxPreview).toHaveBeenCalledWith({
      bytesBase64: 'AQIDBA==',
      documentEpoch: 1,
      documentId: 'document-a',
    });
    expect(container.querySelector('.docx-preview-viewport')?.getAttribute('aria-busy')).toBe('true');
    expect(container.querySelector('.docx-preview-document')?.childNodes).toHaveLength(0);

    await act(async () => runs[0]!.resolve({
      detectedLoss: false,
      html: '<h1>Guide</h1><p><a href="https://safe.example"><strong>Link</strong></a></p>',
      nodeCount: 6,
    }));

    const viewport = container.querySelector('.docx-preview-viewport');
    const document = container.querySelector<HTMLElement>('.docx-preview-document');
    expect(viewport?.getAttribute('aria-busy')).toBe('false');
    expect(document?.querySelector('h1')?.textContent).toBe('Guide');
    const linkText = document?.querySelector('strong');
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    expect(linkText?.dispatchEvent(click)).toBe(false);
    expect(click.defaultPrevented).toBe(true);
    expect(onFeedback).not.toHaveBeenCalled();
  });

  it('zooms from 50 to 200 without reconversion and resets on a newer document epoch', async () => {
    await act(async () => root.render(
      <DocxPreview
        bytesBase64="AQ=="
        documentEpoch={1}
        documentId="document-a"
        onFeedback={onFeedback}
      />,
    ));

    for (let percent = 110; percent <= 200; percent += 10) {
      act(() => button(container, 'Zoom in').click());
    }
    const previewDocument = container.querySelector<HTMLElement>('.docx-preview-document');
    expect(button(container, 'Zoom in').disabled).toBe(true);
    expect(container.querySelector('.preview-zoom-value')?.textContent).toBe('200%');
    expect(previewDocument?.style.getPropertyValue('--docx-zoom')).toBe('200%');
    expect(previewDocument?.style.zoom).toBe('');
    expect(runtimeMock.startDocxPreview).toHaveBeenCalledOnce();

    await act(async () => root.render(
      <DocxPreview
        bytesBase64="Ag=="
        documentEpoch={2}
        documentId="document-a"
        onFeedback={onFeedback}
      />,
    ));
    expect(runs[0]!.cancel).toHaveBeenCalledOnce();
    expect(runtimeMock.startDocxPreview).toHaveBeenCalledTimes(2);
    expect(container.querySelector('.preview-zoom-value')?.textContent).toBe('100%');
  });

  it('suppresses stale results and emits one detected-loss notice for the current identity', async () => {
    await act(async () => root.render(
      <DocxPreview
        bytesBase64="AQ=="
        documentEpoch={1}
        documentId="document-a"
        onFeedback={onFeedback}
      />,
    ));
    await act(async () => root.render(
      <DocxPreview
        bytesBase64="Ag=="
        documentEpoch={2}
        documentId="document-b"
        onFeedback={onFeedback}
      />,
    ));

    await act(async () => runs[0]!.resolve({
      detectedLoss: true,
      html: '<p>Stale</p>',
      nodeCount: 2,
    }));
    expect(container.textContent).not.toContain('Stale');
    expect(onFeedback).not.toHaveBeenCalled();

    await act(async () => runs[1]!.resolve({
      detectedLoss: true,
      html: '<p>Current</p>',
      nodeCount: 2,
    }));
    expect(container.textContent).toContain('Current');
    expect(onFeedback).toHaveBeenCalledOnce();
    expect(onFeedback).toHaveBeenCalledWith({
      kind: 'notice',
      message: 'Some DOCX content could not be displayed completely. This preview includes only content that can be rendered safely.',
    });
  });

  it('shows one friendly current error with no partial HTML or technical detail', async () => {
    await act(async () => root.render(
      <DocxPreview
        bytesBase64="AQ=="
        documentEpoch={1}
        documentId="document-a"
        onFeedback={onFeedback}
      />,
    ));
    await act(async () => runs[0]!.reject(new Error('internal Mammoth detail')));

    expect(onFeedback).toHaveBeenCalledOnce();
    expect(onFeedback).toHaveBeenCalledWith({
      kind: 'error',
      message: 'This DOCX could not be displayed. The file may be damaged or unsupported.',
    });
    expect(container.textContent).not.toContain('internal Mammoth detail');
    expect(container.querySelector('.docx-preview-document')?.childNodes).toHaveLength(0);
  });

  it('does not decode or create a worker before preview authority is enabled', async () => {
    await act(async () => root.render(
      <DocxPreview
        bytesBase64="AQ=="
        documentEpoch={1}
        documentId="document-a"
        enabled={false}
        onFeedback={onFeedback}
      />,
    ));

    expect(runtimeMock.startDocxPreview).not.toHaveBeenCalled();
    expect(container.querySelector('.docx-preview-document')?.childNodes).toHaveLength(0);
  });
});
