// @vitest-environment jsdom

import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceSidebarResizer } from '../components/WorkspaceSidebarResizer';
import { DEFAULT_WORKSPACE_SIDEBAR_WIDTH } from '../lib/sidebarLayout';
import { useWorkspaceSidebarResize } from './useWorkspaceSidebarResize';

function pointerEvent(type: string, input: { clientX: number; pointerId: number }) {
  const event = new MouseEvent(type, {
    bubbles: true,
    button: 0,
    clientX: input.clientX,
  });
  Object.defineProperty(event, 'pointerId', { value: input.pointerId });
  return event;
}

function Harness() {
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_WORKSPACE_SIDEBAR_WIDTH);
  const resize = useWorkspaceSidebarResize({ setSidebarWidth, sidebarWidth });
  return (
    <>
      <WorkspaceSidebarResizer
        sidebarWidth={sidebarWidth}
        onKeyDown={resize.resizeWorkspaceSidebarWithKeyboard}
        onPointerCancel={resize.stopWorkspaceSidebarResize}
        onPointerDown={resize.startWorkspaceSidebarResize}
        onPointerMove={resize.moveWorkspaceSidebarResize}
        onPointerUp={resize.stopWorkspaceSidebarResize}
      />
      <output>{sidebarWidth}</output>
    </>
  );
}

describe('useWorkspaceSidebarResize', () => {
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

  it('tracks a captured pointer and keeps the ARIA value synchronized', () => {
    act(() => root.render(<Harness />));
    const separator = container.querySelector<HTMLButtonElement>('.workspace-sidebar-resizer');
    const setPointerCapture = vi.fn<(pointerId: number) => void>();
    const releasePointerCapture = vi.fn<(pointerId: number) => void>();
    Object.assign(separator ?? {}, {
      hasPointerCapture: () => true,
      releasePointerCapture,
      setPointerCapture,
    });

    act(() => separator?.dispatchEvent(pointerEvent('pointerdown', { clientX: 300, pointerId: 7 })));
    act(() => separator?.dispatchEvent(pointerEvent('pointermove', { clientX: 380, pointerId: 7 })));
    expect(container.querySelector('output')?.textContent).toBe('344');
    expect(separator?.getAttribute('aria-valuenow')).toBe('344');
    expect(setPointerCapture).toHaveBeenCalledWith(7);

    act(() => separator?.dispatchEvent(pointerEvent('pointerup', { clientX: 380, pointerId: 7 })));
    expect(releasePointerCapture).toHaveBeenCalledWith(7);
  });

  it('resizes with arrows and jumps to both boundaries', () => {
    act(() => root.render(<Harness />));
    const separator = container.querySelector<HTMLButtonElement>('.workspace-sidebar-resizer');

    act(() => separator?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowRight' })));
    expect(container.querySelector('output')?.textContent).toBe('280');
    act(() => separator?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Home' })));
    expect(container.querySelector('output')?.textContent).toBe('180');
    act(() => separator?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'End' })));
    expect(container.querySelector('output')?.textContent).toBe('420');
  });
});
