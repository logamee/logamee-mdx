// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PaneResizer } from './PaneResizer';

describe('PaneResizer', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('invokes onDoubleClick to reset the split ratio', () => {
    const onDoubleClick = vi.fn<() => void>();
    act(() => {
      root.render(
        <PaneResizer
          editorPaneRatio={0.35}
          onDoubleClick={onDoubleClick}
          onKeyDown={vi.fn<() => void>()}
          onPointerCancel={vi.fn<() => void>()}
          onPointerDown={vi.fn<() => void>()}
          onPointerMove={vi.fn<() => void>()}
          onPointerUp={vi.fn<() => void>()}
        />,
      );
    });

    const separator = container.querySelector<HTMLButtonElement>('[role="separator"]');
    expect(separator?.getAttribute('aria-valuenow')).toBe('35');
    act(() => {
      separator?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    expect(onDoubleClick).toHaveBeenCalledTimes(1);
  });

  it('forwards key-up and blur so a keyboard resize can end', () => {
    const onBlur = vi.fn<() => void>();
    const onKeyUp = vi.fn<() => void>();
    act(() => {
      root.render(
        <PaneResizer
          editorPaneRatio={0.35}
          onBlur={onBlur}
          onDoubleClick={vi.fn<() => void>()}
          onKeyDown={vi.fn<() => void>()}
          onKeyUp={onKeyUp}
          onPointerCancel={vi.fn<() => void>()}
          onPointerDown={vi.fn<() => void>()}
          onPointerMove={vi.fn<() => void>()}
          onPointerUp={vi.fn<() => void>()}
        />,
      );
    });
    const separator = container.querySelector<HTMLButtonElement>('[role="separator"]');

    act(() => separator?.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'ArrowRight' })));
    act(() => separator?.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));

    expect(onKeyUp).toHaveBeenCalledTimes(1);
    expect(onBlur).toHaveBeenCalledTimes(1);
  });
});
