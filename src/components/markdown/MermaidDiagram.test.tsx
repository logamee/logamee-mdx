// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getMermaidThemeConfig } from '../../lib/mermaidTheme';
import { MermaidDiagram } from './MermaidDiagram';

const mermaidMocks = vi.hoisted(() => ({
  initialize: vi.fn<(config: unknown) => void>(),
  render: vi.fn<(id: string, source: string) => Promise<{ svg: string }>>(),
}));

vi.mock('mermaid', () => ({
  default: mermaidMocks,
}));

const SAFE_SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 40">',
  '<style>.node { fill: #fff; stroke: #222; }</style>',
  '<g class="node"><rect width="80" height="30"/><text x="8" y="20">Current</text></g>',
  '</svg>',
].join('');

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function flushMermaid() {
  await act(async () => {
    await vi.dynamicImportSettled();
    await Promise.resolve();
  });
}

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('MermaidDiagram', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    mermaidMocks.initialize.mockReset();
    mermaidMocks.render.mockReset();
    mermaidMocks.render.mockResolvedValue({ svg: SAFE_SVG });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    document.documentElement.setAttribute('data-skin', 'jinxiu-zhusha');
    document.documentElement.setAttribute('data-appearance', 'light');
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('renders through a strict local Mermaid configuration without HTML labels', async () => {
    await act(async () => {
      root.render(<MermaidDiagram code={'flowchart LR\nA --> B'} />);
    });
    await flushMermaid();

    expect(mermaidMocks.initialize).toHaveBeenCalledWith(expect.objectContaining({
      flowchart: { htmlLabels: false },
      htmlLabels: false,
      securityLevel: 'strict',
      startOnLoad: false,
      theme: 'base',
      themeVariables: getMermaidThemeConfig('jinxiu-zhusha', 'light').themeVariables,
    }));
    expect(mermaidMocks.render).toHaveBeenCalledWith(
      expect.stringMatching(/^mmd-mermaid-/),
      'flowchart LR\nA --> B',
    );
    expect(container.querySelector('.mmd-mermaid-diagram svg')?.textContent).toContain('Current');
    expect(container.querySelector('.mmd-mermaid-diagram style')?.textContent).toContain('.node');
  });

  it('re-renders unchanged source when the effective skin changes', async () => {
    await act(async () => {
      root.render(<MermaidDiagram code="flowchart LR\nA --> B" />);
    });
    await flushMermaid();

    document.documentElement.setAttribute('data-skin', 'shanshui-yemo');
    document.documentElement.setAttribute('data-appearance', 'dark');
    await act(async () => Promise.resolve());
    await flushMermaid();

    expect(mermaidMocks.render).toHaveBeenCalledTimes(2);
    expect(mermaidMocks.initialize).toHaveBeenLastCalledWith(expect.objectContaining(
      getMermaidThemeConfig('shanshui-yemo', 'dark'),
    ));
    expect(container.querySelector('.mmd-mermaid-diagram svg')).not.toBeNull();
  });

  it('serializes concurrent Mermaid jobs so each uses its own configuration', async () => {
    const firstRender = deferred<{ svg: string }>();
    mermaidMocks.render
      .mockReturnValueOnce(firstRender.promise)
      .mockResolvedValueOnce({ svg: SAFE_SVG.replace('Current', 'Second') });

    await act(async () => {
      root.render(
        <>
          <MermaidDiagram code="flowchart LR\nA --> B" />
          <MermaidDiagram code="flowchart LR\nC --> D" />
        </>,
      );
    });
    await flushMicrotasks();

    expect(mermaidMocks.render).toHaveBeenCalledTimes(1);
    firstRender.resolve({ svg: SAFE_SVG.replace('Current', 'First') });
    await flushMermaid();

    expect(mermaidMocks.render).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('First');
    expect(container.textContent).toContain('Second');
  });

  it('inserts only a sanitized SVG fragment', async () => {
    mermaidMocks.render.mockResolvedValue({
      svg: [
        '<svg xmlns="http://www.w3.org/2000/svg" onload="window.bad = true" style="fill: url(https://example.com/evil.svg)">',
        '<script>window.bad = true</script>',
        '<foreignObject><div onclick="window.bad = true">bad</div></foreignObject>',
        '<a href="javascript:window.bad = true"><text>linked</text></a>',
        '<style>@import url(https://example.com/evil.css);</style>',
        '<g onclick="window.bad = true" style="fill: url(https://example.com/evil.svg)"><text>Safe node</text></g>',
        '</svg>',
      ].join(''),
    });

    await act(async () => {
      root.render(<MermaidDiagram code={'flowchart LR\nA --> B'} />);
    });
    await flushMermaid();

    const svg = container.querySelector('.mmd-mermaid-diagram svg');
    expect(svg).not.toBeNull();
    expect(container.querySelector('script, foreignObject, a')).toBeNull();
    expect(container.querySelector('style')).toBeNull();
    expect(svg?.hasAttribute('onload')).toBe(false);
    expect(svg?.hasAttribute('style')).toBe(false);
    expect(container.querySelector('g')?.hasAttribute('onclick')).toBe(false);
    expect(container.querySelector('g')?.hasAttribute('style')).toBe(false);
    expect(container.textContent).toContain('Safe node');
  });

  it('does not let a stale render replace newer Markdown source', async () => {
    const oldRender = deferred<{ svg: string }>();
    const newRender = deferred<{ svg: string }>();
    mermaidMocks.render.mockImplementation((_id: string, source: string) => (
      source === 'old' ? oldRender.promise : newRender.promise
    ));

    await act(async () => {
      root.render(<MermaidDiagram code="old" />);
    });
    await flushMicrotasks();

    await act(async () => {
      root.render(<MermaidDiagram code="new" />);
    });
    await flushMicrotasks();

    oldRender.resolve({ svg: SAFE_SVG.replace('Current', 'Old') });
    await flushMicrotasks();
    expect(mermaidMocks.render).toHaveBeenCalledTimes(2);

    newRender.resolve({ svg: SAFE_SVG.replace('Current', 'New') });
    await flushMicrotasks();

    expect(container.textContent).toContain('New');
    expect(container.textContent).not.toContain('Old');
  });

  it('falls back to the regular code block when Mermaid cannot render', async () => {
    mermaidMocks.render.mockRejectedValue(new Error('invalid diagram'));

    await act(async () => {
      root.render(<MermaidDiagram code="this is not Mermaid" />);
    });
    await flushMermaid();

    expect(container.querySelector('.markdown-code-block-copy-wrap')).not.toBeNull();
    expect(container.textContent).toContain('this is not Mermaid');
  });
});
