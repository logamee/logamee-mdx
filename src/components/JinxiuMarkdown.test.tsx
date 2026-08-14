// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_FEEDBACK_ERROR_EVENT } from '../lib/appFeedback';
import { resetImagePreviewCache } from '../lib/workspacePreviewSource';
import JinxiuMarkdown from './JinxiuMarkdown';

const tauriMocks = vi.hoisted(() => ({
  convertFileSrc: vi.fn<(path: string) => string>((path) => `asset://localhost/${encodeURIComponent(path)}`),
  invoke: vi.fn<(command: string, payload?: unknown) => Promise<unknown>>(),
}));

const mermaidMocks = vi.hoisted(() => ({
  initialize: vi.fn<(config: unknown) => void>(),
  render: vi.fn<(id: string, source: string) => Promise<{ svg: string }>>(),
}));

const excalidrawMocks = vi.hoisted(() => ({
  exportToSvg: vi.fn<(options: unknown) => Promise<SVGSVGElement>>(),
  getNonDeletedElements: vi.fn<(elements: unknown[]) => unknown[]>((elements) => elements),
  restore: vi.fn<(input: unknown) => { appState: Record<string, unknown>; elements: unknown[]; files: Record<string, unknown> }>(),
}));

const lazyModuleMocks = vi.hoisted(() => ({
  loadLazyModuleWithRetry: vi.fn<(
    load: () => Promise<unknown>,
  ) => Promise<unknown>>(),
}));

const syncMocks = vi.hoisted(() => ({
  renderAndSyncExcalidrawAssetPair: vi.fn<() => Promise<{ assets: { svg: SVGSVGElement } }>>(),
}));

vi.mock('@tauri-apps/api/core', () => tauriMocks);
vi.mock('mermaid', () => ({ default: mermaidMocks }));
vi.mock('../lib/lazyModule', () => lazyModuleMocks);
vi.mock('../lib/excalidrawAssetSync', () => syncMocks);
vi.mock('@excalidraw/excalidraw', () => ({
  exportToSvg: excalidrawMocks.exportToSvg,
  FONT_FAMILY: { Excalifont: 5 },
  getNonDeletedElements: excalidrawMocks.getNonDeletedElements,
  restore: excalidrawMocks.restore,
}));

const EXCALIDRAW_SCENE = JSON.stringify({
  appState: {
    currentItemFontFamily: 5,
    viewBackgroundColor: 'transparent',
  },
  elements: [{ id: 'shape-1', type: 'rectangle' }],
  files: {},
  source: 'mmd',
  type: 'excalidraw',
  version: 2,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

describe('JinxiuMarkdown document transitions', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    resetImagePreviewCache();
    tauriMocks.invoke.mockReset();
    tauriMocks.invoke.mockImplementation(async (_command, payload) => {
      const imageSrc = (payload as { imageSrc: string }).imageSrc;
      return `/workspace/assets/${imageSrc}`;
    });
    mermaidMocks.initialize.mockReset();
    mermaidMocks.render.mockReset();
    mermaidMocks.render.mockResolvedValue({
      svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>Mermaid diagram</text></svg>',
    });
    excalidrawMocks.exportToSvg.mockReset();
    excalidrawMocks.getNonDeletedElements.mockClear();
    excalidrawMocks.restore.mockReset();
    excalidrawMocks.restore.mockImplementation((input) => {
      const scene = input as { appState: Record<string, unknown>; elements: unknown[]; files: Record<string, unknown> };
      return {
        appState: scene.appState,
        elements: scene.elements,
        files: scene.files,
      };
    });
    excalidrawMocks.exportToSvg.mockImplementation(async () => {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 320 180');
      svg.textContent = 'Excalidraw diagram';
      return svg;
    });
    lazyModuleMocks.loadLazyModuleWithRetry.mockReset();
    lazyModuleMocks.loadLazyModuleWithRetry.mockImplementation(
      async (load: () => Promise<unknown>) => load(),
    );
    syncMocks.renderAndSyncExcalidrawAssetPair.mockReset();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('never resolves an old dirty document image against the next document path', async () => {
    await act(async () => root.render(
      <JinxiuMarkdown
        currentFilePath="/workspace/old/index.md"
        workspaceRoot="/workspace"
      >
        {'![old](old-image.png)'}
      </JinxiuMarkdown>,
    ));
    tauriMocks.invoke.mockClear();

    await act(async () => root.render(
      <JinxiuMarkdown
        currentFilePath="/workspace/new/index.md"
        workspaceRoot="/workspace"
      >
        {'![new](new-image.png)'}
      </JinxiuMarkdown>,
    ));

    expect(tauriMocks.invoke).not.toHaveBeenCalledWith('resolve_markdown_image', {
      currentFilePath: '/workspace/new/index.md',
      imageSrc: 'old-image.png',
      workspaceRoot: '/workspace',
    });
    expect(tauriMocks.invoke).toHaveBeenCalledWith('resolve_markdown_image', {
      currentFilePath: '/workspace/new/index.md',
      imageSrc: 'new-image.png',
      workspaceRoot: '/workspace',
    });
  });

  it('keeps each rendered heading linked to its Markdown source line', async () => {
    await act(async () => root.render(
      <JinxiuMarkdown currentFilePath="/workspace/guide.md" workspaceRoot="/workspace">
        {'# Project\n\n## Install'}
      </JinxiuMarkdown>,
    ));

    expect(container.querySelector('h1')?.getAttribute('data-heading-line')).toBe('1');
    expect(container.querySelector('h2')?.getAttribute('data-heading-line')).toBe('3');
  });

  it('renders math with the stylesheet-compatible KaTeX markup', async () => {
    await act(async () => root.render(
      <JinxiuMarkdown currentFilePath="/workspace/guide.md" workspaceRoot="/workspace">
        {'Inline $x^2$\n\n$$\n\\frac{1}{\\sqrt{2}}\n$$'}
      </JinxiuMarkdown>,
    ));

    const renderedMath = [...container.querySelectorAll('.katex')];
    expect(renderedMath).toHaveLength(2);
    expect(renderedMath.every((element) => (
      element.querySelector('.katex-html > .katex-base .katex-strut') !== null
    ))).toBe(true);
    expect(container.querySelector('.katex-display > .katex')).not.toBeNull();
    expect(container.querySelector('.katex .base, .katex .strut')).toBeNull();
  });

  it('renders Mermaid fences through the Mermaid diagram component', async () => {
    await act(async () => root.render(
      <JinxiuMarkdown currentFilePath="/workspace/guide.md" workspaceRoot="/workspace">
        {'```mermaid\nflowchart LR\nA --> B\n```'}
      </JinxiuMarkdown>,
    ));
    await act(async () => {
      await vi.dynamicImportSettled();
      await Promise.resolve();
    });

    expect(mermaidMocks.render).toHaveBeenCalledWith(
      expect.stringMatching(/^mmd-mermaid-/),
      'flowchart LR\nA --> B',
    );
    expect(container.querySelector('.mmd-mermaid-diagram svg')?.textContent).toContain('Mermaid diagram');
  });

  it('renders a relative HTML page embed as an interactive sandboxed frame', async () => {
    tauriMocks.invoke.mockImplementation(async (command) => {
      if (command === 'prepare_markdown_html_embed') {
        return {
          url: 'http://127.0.0.1:43127/demos/counter.html',
          ownerId: 71,
        };
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    await act(async () => root.render(
      <JinxiuMarkdown currentFilePath="/workspace/guide.md" workspaceRoot="/workspace">
        {'<iframe src="demos/counter.html" title="Counter demo" srcdoc="unsafe" onload="window.bad = true" sandbox="allow-top-navigation" allow="camera" width="999999" height="999999"></iframe>'}
      </JinxiuMarkdown>,
    ));
    await act(async () => {
      await vi.waitFor(() => {
        expect(tauriMocks.invoke).toHaveBeenCalledWith('prepare_markdown_html_embed', {
          htmlSrc: 'demos/counter.html',
          markdownPath: '/workspace/guide.md',
          workspaceRoot: '/workspace',
        });
      });
    });

    const frame = container.querySelector('iframe');
    expect(frame?.getAttribute('src')).toBe('http://127.0.0.1:43127/demos/counter.html');
    expect(frame?.getAttribute('title')).toBe('Counter demo');
    expect(frame?.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin allow-forms');
    expect(frame?.hasAttribute('srcdoc')).toBe(false);
    expect(frame?.hasAttribute('onload')).toBe(false);
    expect(frame?.hasAttribute('allow')).toBe(false);
    expect(frame?.hasAttribute('width')).toBe(false);
    expect(frame?.hasAttribute('height')).toBe(false);
  });

  it('renders an mmd:embed Markdown link as an interactive sandboxed frame', async () => {
    tauriMocks.invoke.mockImplementation(async (command) => {
      if (command === 'prepare_markdown_html_embed') {
        return {
          url: 'http://127.0.0.1:43127/html/cc-switch-flow.html',
          ownerId: 73,
        };
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    await act(async () => root.render(
      <JinxiuMarkdown currentFilePath="/workspace/guide.md" workspaceRoot="/workspace">
        {'**<u>[cc-switch-flow.html](html/cc-switch-flow.html "mmd:embed")</u>**'}
      </JinxiuMarkdown>,
    ));
    await act(async () => {
      await vi.waitFor(() => {
        expect(tauriMocks.invoke).toHaveBeenCalledWith('prepare_markdown_html_embed', {
          htmlSrc: 'html/cc-switch-flow.html',
          markdownPath: '/workspace/guide.md',
          workspaceRoot: '/workspace',
        });
      });
    });

    const frame = container.querySelector('iframe');
    expect(frame?.getAttribute('src')).toBe('http://127.0.0.1:43127/html/cc-switch-flow.html');
    expect(frame?.getAttribute('title')).toBe('cc-switch-flow.html');
    expect(container.querySelector('p .mmd-html-embed-viewport > iframe')).toBe(frame);
    expect(container.querySelector('a')).toBeNull();
  });

  it('renders a parent-relative mmd:embed link that remains inside the workspace', async () => {
    tauriMocks.invoke.mockImplementation(async (command) => {
      if (command === 'prepare_markdown_html_embed') {
        return {
          url: 'http://127.0.0.1:43127/demos/counter.html',
          ownerId: 74,
        };
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    await act(async () => root.render(
      <JinxiuMarkdown currentFilePath="/workspace/docs/guide.md" workspaceRoot="/workspace">
        {'[Counter](../demos/counter.html "mmd:embed")'}
      </JinxiuMarkdown>,
    ));
    await act(async () => {
      await vi.waitFor(() => {
        expect(tauriMocks.invoke).toHaveBeenCalledWith('prepare_markdown_html_embed', {
          htmlSrc: '../demos/counter.html',
          markdownPath: '/workspace/docs/guide.md',
          workspaceRoot: '/workspace',
        });
      });
    });

    expect(container.querySelector('iframe')).not.toBeNull();
    expect(container.querySelector('a')).toBeNull();
  });

  it('renders generated and legacy local Excalidraw links as static previews', async () => {
    tauriMocks.invoke.mockImplementation(async (command) => {
      if (command === 'read_markdown_excalidraw') return EXCALIDRAW_SCENE;
      throw new Error(`Unexpected command: ${command}`);
    });

    await act(async () => root.render(
      <JinxiuMarkdown currentFilePath="/workspace/docs/guide.md" workspaceRoot="/workspace">
        {[
          '[Generated](../diagrams/generated.excalidraw "mmd:embed")',
          '[Legacy](../diagrams/legacy.excalidraw)',
        ].join('\n\n')}
      </JinxiuMarkdown>,
    ));
    await act(async () => {
      await vi.waitFor(() => {
        expect(excalidrawMocks.exportToSvg).toHaveBeenCalledTimes(2);
        expect(lazyModuleMocks.loadLazyModuleWithRetry).toHaveBeenCalledTimes(2);
      });
    });
    expect(container.querySelectorAll('.mmd-excalidraw-embed-viewport > svg')).toHaveLength(2);

    expect(tauriMocks.invoke).toHaveBeenCalledWith('read_markdown_excalidraw', {
      currentFilePath: '/workspace/docs/guide.md',
      excalidrawSrc: '../diagrams/generated.excalidraw',
      workspaceRoot: '/workspace',
    });
    expect(tauriMocks.invoke).toHaveBeenCalledWith('read_markdown_excalidraw', {
      currentFilePath: '/workspace/docs/guide.md',
      excalidrawSrc: '../diagrams/legacy.excalidraw',
      workspaceRoot: '/workspace',
    });
    expect(excalidrawMocks.getNonDeletedElements).toHaveBeenCalledTimes(2);
    expect(excalidrawMocks.exportToSvg).toHaveBeenLastCalledWith(expect.objectContaining({
      appState: expect.objectContaining({
        exportBackground: false,
        exportEmbedScene: false,
        exportWithDarkMode: false,
        viewBackgroundColor: 'transparent',
      }),
      files: {},
      renderEmbeddables: false,
      reuseImages: true,
    }));
    expect(container.querySelector('a')).toBeNull();
    expect([...container.querySelectorAll('.mmd-excalidraw-embed-viewport')].map((preview) => (
      preview.getAttribute('aria-label')
    ))).toEqual(['Generated', 'Legacy']);
  });

  it('refreshes a source-linked Excalidraw sidecar while keeping the live preview', async () => {
    tauriMocks.invoke.mockImplementation(async (command) => {
      if (command === 'read_markdown_excalidraw') return EXCALIDRAW_SCENE;
      throw new Error(`Unexpected command: ${command}`);
    });
    const syncedSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    syncedSvg.setAttribute('width', '320');
    syncedSvg.setAttribute('height', '180');
    syncMocks.renderAndSyncExcalidrawAssetPair.mockResolvedValue({ assets: { svg: syncedSvg } });

    await act(async () => root.render(
      <JinxiuMarkdown
        currentFilePath="/workspace/docs/guide.md"
        documentRelativePath="docs/guide.md"
        excalidrawAssetSync={{
          resourceDirectory: 'assets',
          workspaceRoot: '/workspace',
          workspaceToken: 'workspace-token',
        }}
        workspaceRoot="/workspace"
      >
        {'[![System](../assets/system.svg?mmdSource=abc)](../diagrams/system.excalidraw "mmd:source")'}
      </JinxiuMarkdown>,
    ));
    await act(async () => {
      await vi.waitFor(() => expect(syncMocks.renderAndSyncExcalidrawAssetPair).toHaveBeenCalledOnce());
    });

    expect(syncMocks.renderAndSyncExcalidrawAssetPair).toHaveBeenCalledWith(expect.objectContaining({
      documentPath: '/workspace/docs/guide.md',
      sourceRelativePath: 'diagrams/system.excalidraw',
      sourceContent: EXCALIDRAW_SCENE,
      workspaceToken: 'workspace-token',
    }));
    expect(container.querySelector('.mmd-excalidraw-embed-viewport > svg')).toBe(syncedSvg);
  });

  it('keeps unsafe Excalidraw sources as ordinary links', async () => {
    await act(async () => root.render(
      <JinxiuMarkdown currentFilePath="/workspace/docs/guide.md" workspaceRoot="/workspace">
        {[
          '[Remote](https://example.com/diagram.excalidraw "mmd:embed")',
          '[Outside](../../diagram.excalidraw "mmd:embed")',
          '[Custom link](../diagrams/custom.excalidraw "open source")',
        ].join('\n\n')}
      </JinxiuMarkdown>,
    ));

    expect([...container.querySelectorAll('a')].map((link) => link.getAttribute('href'))).toEqual([
      'https://example.com/diagram.excalidraw',
      '../../diagram.excalidraw',
      '../diagrams/custom.excalidraw',
    ]);
    expect(container.querySelector('.mmd-excalidraw-embed-viewport')).toBeNull();
    expect(tauriMocks.invoke).not.toHaveBeenCalled();
  });

  it('does not read an Excalidraw embed while local assets are disabled', async () => {
    await act(async () => root.render(
      <JinxiuMarkdown
        currentFilePath="/workspace/guide.md"
        localAssetsEnabled={false}
        workspaceRoot="/workspace"
      >
        {'[Diagram](diagrams/system.excalidraw "mmd:embed")'}
      </JinxiuMarkdown>,
    ));

    const status = container.querySelector('.mmd-excalidraw-embed-status');
    expect(status?.getAttribute('aria-busy')).toBe('false');
    expect(status?.textContent).toBe('Excalidraw preview is temporarily unavailable.');
    expect(tauriMocks.invoke).not.toHaveBeenCalled();
  });

  it('reports terminal runtime load failures separately from SVG export failures', async () => {
    const feedback = vi.fn<(event: Event) => void>();
    window.addEventListener(APP_FEEDBACK_ERROR_EVENT, feedback);
    tauriMocks.invoke.mockResolvedValue(EXCALIDRAW_SCENE);
    lazyModuleMocks.loadLazyModuleWithRetry.mockRejectedValue(new Error('chunk is unavailable'));

    try {
      await act(async () => root.render(
        <JinxiuMarkdown currentFilePath="/workspace/guide.md" workspaceRoot="/workspace">
          {'[Diagram](diagram.excalidraw "mmd:embed")'}
        </JinxiuMarkdown>,
      ));
      await act(async () => {
        await vi.waitFor(() => expect(feedback).toHaveBeenCalledOnce());
      });

      expect((feedback.mock.calls[0][0] as CustomEvent<string>).detail).toBe(
        'Failed to load Excalidraw preview module: chunk is unavailable',
      );
      expect(excalidrawMocks.exportToSvg).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener(APP_FEEDBACK_ERROR_EVENT, feedback);
    }
  });

  it('reports SVG export failures as rendering errors', async () => {
    const feedback = vi.fn<(event: Event) => void>();
    window.addEventListener(APP_FEEDBACK_ERROR_EVENT, feedback);
    tauriMocks.invoke.mockResolvedValue(EXCALIDRAW_SCENE);
    excalidrawMocks.exportToSvg.mockRejectedValue(new Error('SVG export failed'));

    try {
      await act(async () => root.render(
        <JinxiuMarkdown currentFilePath="/workspace/guide.md" workspaceRoot="/workspace">
          {'[Diagram](diagram.excalidraw "mmd:embed")'}
        </JinxiuMarkdown>,
      ));
      await act(async () => {
        await vi.waitFor(() => expect(feedback).toHaveBeenCalledOnce());
      });

      expect((feedback.mock.calls[0][0] as CustomEvent<string>).detail).toBe(
        'Excalidraw preview could not be rendered: SVG export failed',
      );
    } finally {
      window.removeEventListener(APP_FEEDBACK_ERROR_EVENT, feedback);
    }
  });

  it('does not export a stale scene after the embed source changes', async () => {
    const firstRequest = deferred<string>();
    tauriMocks.invoke
      .mockReturnValueOnce(firstRequest.promise)
      .mockResolvedValueOnce(EXCALIDRAW_SCENE);

    await act(async () => root.render(
      <JinxiuMarkdown currentFilePath="/workspace/guide.md" workspaceRoot="/workspace">
        {'[First](first.excalidraw "mmd:embed")'}
      </JinxiuMarkdown>,
    ));
    await act(async () => root.render(
      <JinxiuMarkdown currentFilePath="/workspace/guide.md" workspaceRoot="/workspace">
        {'[Second](second.excalidraw "mmd:embed")'}
      </JinxiuMarkdown>,
    ));
    await act(async () => {
      await vi.waitFor(() => expect(container.querySelector('svg')).not.toBeNull());
    });

    await act(async () => firstRequest.resolve(EXCALIDRAW_SCENE));

    expect(excalidrawMocks.exportToSvg).toHaveBeenCalledOnce();
    expect(container.querySelector('.mmd-excalidraw-embed-viewport')?.getAttribute('aria-label'))
      .toBe('Second');
  });

  it('keeps unmarked and unsafe mmd:embed links as ordinary links', async () => {
    await act(async () => root.render(
      <JinxiuMarkdown currentFilePath="/workspace/guide.md" workspaceRoot="/workspace">
        {[
          '[Plain HTML](demos/counter.html)',
          '[Remote HTML](https://example.com/counter.html "mmd:embed")',
          '[Outside HTML](../../counter.html "mmd:embed")',
        ].join('\n\n')}
      </JinxiuMarkdown>,
    ));

    expect([...container.querySelectorAll('a')].map((link) => link.getAttribute('href'))).toEqual([
      'demos/counter.html',
      'https://example.com/counter.html',
      '../../counter.html',
    ]);
    expect(container.querySelector('iframe')).toBeNull();
    expect(tauriMocks.invoke).not.toHaveBeenCalled();
  });

  it('does not grant popup, modal, or download privileges to Markdown HTML embeds', async () => {
    tauriMocks.invoke.mockResolvedValue({
      url: 'http://127.0.0.1:43127/demos/counter.html',
      ownerId: 72,
    });

    await act(async () => root.render(
      <JinxiuMarkdown currentFilePath="/workspace/guide.md" workspaceRoot="/workspace">
        {'<iframe src="demos/counter.html"></iframe>'}
      </JinxiuMarkdown>,
    ));
    await act(async () => {
      await vi.waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());
    });

    const sandbox = container.querySelector('iframe')?.getAttribute('sandbox') ?? '';
    expect(sandbox).not.toContain('allow-popups');
    expect(sandbox).not.toContain('allow-modals');
    expect(sandbox).not.toContain('allow-downloads');
  });

  it('keeps arbitrary raw HTML and remote frames inert', async () => {
    await act(async () => root.render(
      <JinxiuMarkdown currentFilePath="/workspace/guide.md" workspaceRoot="/workspace">
        {'<button onclick="window.bad = true">Run</button>\n\n<iframe src="https://example.com/app.html"></iframe>'}
      </JinxiuMarkdown>,
    ));

    expect(container.querySelector('button, iframe')).toBeNull();
    expect(container.textContent).toContain('<button onclick="window.bad = true">Run</button>');
    expect(tauriMocks.invoke).not.toHaveBeenCalled();
  });

  it('keeps unsupported local HTML path syntax inert', async () => {
    const source = [
      '<iframe src="../outside.html"></iframe>',
      '<iframe src="demo.html?mode=preview"></iframe>',
      '<iframe src="demos\\counter.html"></iframe>',
      '<iframe src="demos%2fencoded.html"></iframe>',
    ].join('\n\n');

    await act(async () => root.render(
      <JinxiuMarkdown currentFilePath="/workspace/guide.md" workspaceRoot="/workspace">
        {source}
      </JinxiuMarkdown>,
    ));

    expect(container.querySelector('iframe')).toBeNull();
    expect(container.textContent).toContain('../outside.html');
    expect(tauriMocks.invoke).not.toHaveBeenCalled();
  });

  it('keeps an unauthorized HTML embed unavailable instead of permanently loading', async () => {
    await act(async () => root.render(
      <JinxiuMarkdown
        currentFilePath="/workspace/guide.md"
        localAssetsEnabled={false}
        workspaceRoot="/workspace"
      >
        {'<iframe src="demos/counter.html"></iframe>'}
      </JinxiuMarkdown>,
    ));

    const status = container.querySelector('output');
    expect(status?.getAttribute('aria-busy')).toBe('false');
    expect(status?.textContent).toBe('HTML preview is temporarily unavailable.');
    expect(tauriMocks.invoke).not.toHaveBeenCalled();
  });
});
