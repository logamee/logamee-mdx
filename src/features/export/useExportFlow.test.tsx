// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExportPreflightIssue } from '../../lib/exportPreflight';
import { useExportFlow, type ExportFlowDeps } from './useExportFlow';
import {
  bytesToBase64,
  collectPreviewExportIssues,
  exportBaseName,
  nextExportFormat,
  resolveExportTheme,
} from './exportFlowRunners';

vi.mock('../../lib/tauriCommands', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    saveExport: vi.fn<() => Promise<{ path: string; bytesWritten: number } | null>>(async () => ({
      path: '/out/doc.html',
      bytesWritten: 10,
    })),
    saveExcalidrawBundle: vi.fn<() => Promise<string[] | null>>(async () => ['/out/a.svg']),
  };
});

vi.mock('../../lib/offlineHtmlExport', () => ({
  buildOfflineHtml: vi.fn<() => string>(() => '<html>offline</html>'),
}));
vi.mock('../../lib/exportAssetInlining', () => ({
  replaceVideoElementsWithExportFallback: vi.fn<(...args: unknown[]) => void>(),
  collectOfflineExportAssets: vi.fn<() => Promise<{ assetDataUrls: Record<string, string>; css: string }>>(async () => ({
    assetDataUrls: {},
    css: 'body{}',
  })),
}));
vi.mock('../../lib/longPngExport', () => ({
  renderElementToLongPng: vi.fn<() => Promise<Blob>>(async () => new Blob([new Uint8Array([1, 2])])),
}));
vi.mock('../../lib/excalidrawRuntime', () => ({
  exportExcalidrawSceneAssets: vi.fn<() => Promise<{ pngBlob: Blob; svgText: string }>>(async () => ({
    pngBlob: new Blob([new Uint8Array([3])]),
    svgText: '<svg/>',
  })),
}));

const locale = { code: 'en', dir: 'ltr' } as unknown as ExportFlowDeps['locale'];

function previewPane(): HTMLElement {
  const pane = document.createElement('div');
  const preview = document.createElement('div');
  preview.className = 'mmd-preview-content';
  pane.append(preview);
  return pane;
}

function buildDeps(overrides: Partial<ExportFlowDeps> = {}): ExportFlowDeps {
  return {
    activeFileKind: 'markdown',
    activePath: '/ws/notes/doc.md',
    appearance: 'light',
    content: '# hello',
    locale,
    getPreviewPaneEl: vi.fn<() => HTMLElement | null>(previewPane),
    setError: vi.fn<(...args: unknown[]) => void>(),
    setNotice: vi.fn<(...args: unknown[]) => void>(),
    skin: 'original',
    ...overrides,
  };
}

describe('export flow runners', () => {
  it('derives the export base name and next format', () => {
    expect(exportBaseName('/ws/notes/doc.md')).toBe('doc');
    expect(exportBaseName(null)).toBe('document');
    expect(nextExportFormat('excalidraw', 'html')).toBe('excalidraw');
    expect(nextExportFormat('markdown', 'excalidraw')).toBe('html');
    expect(nextExportFormat('markdown', 'png')).toBe('png');
  });

  it('resolves export theme following the current or selected appearance', () => {
    expect(resolveExportTheme({ appearance: 'dark', selectedTheme: 'current', skin: 'original' }))
      .toEqual({ appearance: 'dark', skin: 'original' });
    expect(resolveExportTheme({ appearance: 'dark', selectedTheme: 'light', skin: 'original' }).appearance)
      .toBe('light');
  });

  it('chunk-encodes bytes to base64', () => {
    expect(bytesToBase64(new TextEncoder().encode('hello'))).toBe(btoa('hello'));
  });

  it('collects preview issues from broken diagrams and unavailable images', () => {
    const pane = document.createElement('div');
    const preview = document.createElement('div');
    preview.className = 'mmd-preview-content';
    preview.innerHTML = '<div class="image-error">boom</div><img src="x.png">';
    pane.append(preview);
    const issues = collectPreviewExportIssues(() => pane, '# doc');
    expect(issues.length).toBeGreaterThan(0);
    expect(JSON.stringify(issues)).toContain('boom');
    const empty: ExportPreflightIssue[] = collectPreviewExportIssues(() => null, '# doc');
    expect(Array.isArray(empty)).toBe(true);
  });
});

describe('useExportFlow hook', () => {
  let container: HTMLDivElement;
  let root: Root;
  let controller: ReturnType<typeof useExportFlow>;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  function renderFlow(deps: ExportFlowDeps): void {
    function Probe(): null {
      controller = useExportFlow(deps);
      return null;
    }
    act(() => root.render(<Probe />));
  }

  it('opens the dialog with preview issues for a markdown document', () => {
    renderFlow(buildDeps());
    act(() => controller.openExportDialog());
    expect(controller.showExport).toBe(true);
    expect(controller.exportValue.format).toBe('html');
  });

  it('keeps the dialog closed for unsupported kinds', () => {
    renderFlow(buildDeps({ activeFileKind: 'html' }));
    act(() => controller.openExportDialog());
    expect(controller.showExport).toBe(false);
  });

  it('exports html, closes the dialog and notifies', async () => {
    const deps = buildDeps();
    renderFlow(deps);
    await act(async () => {
      controller.setExportValue((current) => ({ ...current, format: 'html' }));
    });
    await act(async () => {
      await controller.runExport();
    });
    expect(controller.showExport).toBe(false);
    expect(deps.setNotice).toHaveBeenCalled();
    expect(deps.setError).toHaveBeenCalledWith(null);
  });

  it('exports a long png with the selected scale', async () => {
    const deps = buildDeps();
    renderFlow(deps);
    await act(async () => {
      controller.setExportValue((current) => ({ ...current, format: 'png', scale: 2 }));
    });
    await act(async () => {
      await controller.runExport();
    });
    expect(controller.showExport).toBe(false);
    expect(deps.setNotice).toHaveBeenCalled();
    expect(deps.setError).toHaveBeenCalledWith(null);
  });

  it('exports an excalidraw bundle for a board document', async () => {
    const deps = buildDeps({ activeFileKind: 'excalidraw' });
    renderFlow(deps);
    await act(async () => {
      controller.setExportValue((current) => ({ ...current, format: 'excalidraw' }));
    });
    await act(async () => {
      await controller.runExport();
    });
    expect(controller.showExport).toBe(false);
    expect(deps.setNotice).toHaveBeenCalled();
    expect(deps.setError).toHaveBeenCalledWith(null);
  });

  it('surfaces an error when the preview pane is unavailable', async () => {
    const deps = buildDeps({ getPreviewPaneEl: vi.fn<() => HTMLElement | null>(() => null) });
    renderFlow(deps);
    await act(async () => {
      await controller.runExport();
    });
    expect(controller.showExport).toBe(false);
    expect(deps.setError).toHaveBeenCalled();
  });

  it('rejects excalidraw export for a non-board document', async () => {
    const deps = buildDeps({ activeFileKind: 'markdown' });
    renderFlow(deps);
    await act(async () => {
      controller.setExportValue((current) => ({ ...current, format: 'excalidraw' }));
    });
    await act(async () => {
      await controller.runExport();
    });
    expect(deps.setError).toHaveBeenCalled();
  });
});
