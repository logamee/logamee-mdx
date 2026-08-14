// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const highlighterMocks = vi.hoisted(() => ({
  loaded: vi.fn<() => void>(),
}));

const clipboardMocks = vi.hoisted(() => ({
  writeText: vi.fn<(text: string) => Promise<void>>(),
}));

vi.mock('react-syntax-highlighter', async () => {
  highlighterMocks.loaded();
  return vi.importActual('react-syntax-highlighter');
});

describe('fenced code block rendering', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    highlighterMocks.loaded.mockClear();
    clipboardMocks.writeText.mockReset();
    clipboardMocks.writeText.mockResolvedValue();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: clipboardMocks.writeText },
    });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.documentElement.removeAttribute('data-appearance');
    document.documentElement.removeAttribute('data-skin');
  });

  it('loads syntax highlighting only after the first non-Mermaid fence and keeps plain text soft wraps aligned', async () => {
    const { default: JinxiuMarkdown } = await import('../JinxiuMarkdown');

    act(() => root.render(
      <JinxiuMarkdown currentFilePath={null} workspaceRoot={null}>Plain Markdown</JinxiuMarkdown>,
    ));
    expect(highlighterMocks.loaded).not.toHaveBeenCalled();

    act(() => root.render(
      <JinxiuMarkdown currentFilePath={null} workspaceRoot={null}>{'```plain\na-very-long-unbroken-plain-text-line-that-must-wrap-inside-the-preview\nsecond line\n```'}</JinxiuMarkdown>,
    ));

    const fallback = container.querySelector('.jinxiu-code-surface pre[aria-busy="true"]');
    expect(fallback?.querySelector('code')?.textContent).toBe('a-very-long-unbroken-plain-text-line-that-must-wrap-inside-the-preview\nsecond line');

    await act(async () => {
      await vi.dynamicImportSettled();
      await Promise.resolve();
    });

    expect(highlighterMocks.loaded).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.jinxiu-code-surface [aria-busy="true"]')).toBeNull();
    const fencedCode = container.querySelector<HTMLElement>('pre.jinxiu-code-block-pre code.jinxiu-fenced-code-inner');
    const codeLines = container.querySelectorAll<HTMLElement>('.jinxiu-code-line');
    const firstLineNumber = codeLines[0]?.querySelector<HTMLElement>('.react-syntax-highlighter-line-number');
    expect(fencedCode?.style.whiteSpace).toBe('pre-wrap');
    expect(fencedCode?.style.overflowWrap).toBe('break-word');
    expect(codeLines[0]?.style.display).not.toBe('flex');
    expect(firstLineNumber).not.toBeNull();
    expect(container.querySelectorAll('.react-syntax-highlighter-line-number')).toHaveLength(2);
    const copyButton = container.querySelector<HTMLButtonElement>('.code-copy-button');
    expect(copyButton?.getAttribute('aria-label')).toBe('Copy code');
    await act(async () => copyButton?.click());
    expect(clipboardMocks.writeText).toHaveBeenCalledWith('a-very-long-unbroken-plain-text-line-that-must-wrap-inside-the-preview\nsecond line');
    expect(container.querySelector('pre')?.style.backgroundColor).toBe('rgb(255, 255, 255)');
  }, 15_000);

  it('selects the dark Prism base from the effective root appearance', async () => {
    document.documentElement.setAttribute('data-skin', 'original');
    document.documentElement.setAttribute('data-appearance', 'dark');
    const { default: JinxiuMarkdown } = await import('../JinxiuMarkdown');

    act(() => root.render(
      <JinxiuMarkdown currentFilePath={null} workspaceRoot={null}>{'```javascript\nconst active = true;\n```'}</JinxiuMarkdown>,
    ));
    await act(async () => {
      await vi.dynamicImportSettled();
      await Promise.resolve();
    });

    expect(container.querySelector<HTMLElement>('pre.jinxiu-code-block-pre')?.style.backgroundColor)
      .toBe('rgb(13, 17, 23)');
  });
});
