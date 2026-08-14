import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { controllerOpen } = vi.hoisted(() => ({
  controllerOpen: vi.fn<(pane: string) => Promise<{ status: 'created'; pane: string }>>(
    async (pane) => ({ status: 'created', pane }),
  ),
}));

vi.mock('../lib/paneWindow', () => ({
  PanePopoutController: class {
    open = controllerOpen;
    closeAll = vi.fn<() => Promise<never[]>>(async () => []);
    track = vi.fn<() => Promise<{
      status: 'succeeded';
      value: { isOpen: boolean; unlisten: () => void };
    }>>(async () => ({
      status: 'succeeded',
      value: { isOpen: false, unlisten: vi.fn<() => void>() },
    }));
  },
  PaneWindowAdapter: class {},
}));

vi.mock('../lib/tauriPaneWindowBackend', () => ({
  TauriPaneWindowBackend: class {},
}));

import { usePanePopouts } from './usePanePopouts';

describe('usePanePopouts', () => {
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    controllerOpen.mockClear();
  });

  it('forwards an optional popout instance ID to the pane controller', async () => {
    let openPanePopout: ReturnType<typeof usePanePopouts>['openPanePopout'] | undefined;
    const broadcastPaneState = vi.fn<() => Promise<void>>(async () => undefined);

    function Harness() {
      openPanePopout = usePanePopouts({
        broadcastPaneState,
        isPopout: true,
        setError: vi.fn<(message: string | null) => void>(),
        setNotice: vi.fn<(message: string | null) => void>(),
      }).openPanePopout;
      return null;
    }

    const testContainer = document.createElement('div');
    container = testContainer;
    document.body.append(testContainer);
    const testRoot = createRoot(testContainer);
    root = testRoot;
    await act(async () => testRoot.render(<Harness />));
    const open = openPanePopout;
    if (!open) throw new Error('Popout callback was not initialized');
    let outcome: Awaited<ReturnType<typeof open>> | undefined;
    await act(async () => {
      outcome = await open('preview', 'preview:document-42');
    });
    expect(outcome).toEqual({
      status: 'created',
      pane: 'preview',
    });

    expect(controllerOpen).toHaveBeenCalledWith('preview', broadcastPaneState, 'preview:document-42');
  });
});
// @vitest-environment jsdom
