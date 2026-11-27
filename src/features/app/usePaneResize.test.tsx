// @vitest-environment jsdom

import { act, useState, type Ref } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PaneResizer } from '../../components/PaneResizer';
import { usePaneResize } from './usePaneResize';

function pointerEvent(type: string, input: { clientX: number; pointerId: number }) {
  const event = new MouseEvent(type, {
    bubbles: true,
    button: 0,
    clientX: input.clientX,
  });
  Object.defineProperty(event, 'pointerId', { value: input.pointerId });
  return event;
}

function Pane({ paneRef }: { paneRef: Ref<HTMLElement> }) {
  return <section ref={paneRef} />;
}

function Harness() {
  const [editorPaneRatio, setEditorPaneRatio] = useState(0.5);
  const resize = usePaneResize({ editorPaneRatio, setEditorPaneRatio });
  return (
    <>
      <Pane paneRef={resize.editorPaneRef} />
      <Pane paneRef={resize.previewPaneRef} />
      <PaneResizer
        editorPaneRatio={editorPaneRatio}
        onBlur={resize.endPaneResizeWithKeyboard}
        onDoubleClick={resize.resetPaneRatio}
        onKeyDown={resize.resizePaneWithKeyboard}
        onKeyUp={resize.endPaneResizeWithKeyboard}
        onPointerCancel={resize.stopPaneResize}
        onPointerDown={resize.startPaneResize}
        onPointerMove={resize.movePaneResize}
        onPointerUp={resize.stopPaneResize}
      />
      <output>{String(resize.isResizing)}</output>
    </>
  );
}

describe('usePaneResize', () => {
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

  function renderHarness() {
    act(() => root.render(<Harness />));
    return {
      output: () => container.querySelector('output')?.textContent,
      separator: () => container.querySelector<HTMLButtonElement>('[role="separator"]'),
    };
  }

  it('marks the resize state while an arrow key applies a step and clears it on key-up', () => {
    const { output, separator } = renderHarness();

    act(() => separator()?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowRight' })));
    expect(separator()?.getAttribute('aria-valuenow')).toBe('52');
    expect(output()).toBe('true');

    act(() => separator()?.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'ArrowRight' })));
    expect(output()).toBe('false');
  });

  it('clears the resize state when the resizer loses focus', () => {
    const { output, separator } = renderHarness();

    act(() => separator()?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowLeft' })));
    expect(output()).toBe('true');

    act(() => separator()?.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
    expect(output()).toBe('false');
  });

  it('does not mark the resize state for keys that apply no step', () => {
    const { output, separator } = renderHarness();

    act(() => separator()?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' })));

    expect(separator()?.getAttribute('aria-valuenow')).toBe('50');
    expect(output()).toBe('false');
  });

  it('keeps a pointer drag resizing when a key is released or focus moves mid-drag', () => {
    const { output, separator } = renderHarness();
    for (const pane of container.querySelectorAll('section')) {
      pane.getBoundingClientRect = () => ({ width: 400 }) as DOMRect;
    }
    const target = separator();
    if (!target) throw new Error('pane resizer is missing');
    Object.assign(target, {
      hasPointerCapture: () => true,
      releasePointerCapture: vi.fn<(pointerId: number) => void>(),
      setPointerCapture: vi.fn<(pointerId: number) => void>(),
    });

    act(() => target.dispatchEvent(pointerEvent('pointerdown', { clientX: 300, pointerId: 7 })));
    expect(output()).toBe('true');

    act(() => target.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'ArrowRight' })));
    act(() => target.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
    expect(output()).toBe('true');

    act(() => target.dispatchEvent(pointerEvent('pointerup', { clientX: 300, pointerId: 7 })));
    expect(output()).toBe('false');
  });
});
