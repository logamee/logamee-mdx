// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodeBlock } from './CodeBlock';

vi.mock('./SyntaxHighlightedCode', () => {
  throw new Error('syntax highlighter chunk failed');
});

describe('fenced code block loading failure', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    consoleError.mockRestore();
    container.remove();
  });

  it('keeps an accessible plain code fallback when the highlighter chunk rejects', async () => {
    act(() => root.render(<CodeBlock code="const answer = 42;" language="typescript" />));

    await act(async () => {
      await vi.dynamicImportSettled();
      await Promise.resolve();
    });

    const fallback = container.querySelector('.jinxiu-code-surface pre[aria-busy="false"]');
    const fallbackCode = fallback?.querySelector('code.jinxiu-fenced-code-inner');
    expect(fallback?.classList.contains('jinxiu-code-block-pre')).toBe(true);
    expect(fallbackCode?.textContent).toBe('const answer = 42;');
    expect(container.querySelector('.code-copy-button')).not.toBeNull();
  });
});
