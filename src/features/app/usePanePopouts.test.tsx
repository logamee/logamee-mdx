import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { controllerOpen } = vi.hoisted(() => ({
  controllerOpen: vi.fn<(pane: string) => Promise<{ status: 'created'; pane: string }>>(
    async (pane) => ({ status: 'created', pane }),
  ),
}));

vi.mock('../../lib/paneWindow', () => ({
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

vi.mock('../../lib/tauriPaneWindowBackend', () => ({
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

describe('usePanePopouts tracking and close', () => {
  it('tracks open state, closes all popouts, and reports open failures', async () => {
    let api: ReturnType<typeof usePanePopouts> | undefined;
    const setError = vi.fn<(message: string | null) => void>();
    const setNotice = vi.fn<(message: string | null) => void>();

    function Harness() {
      api = usePanePopouts({
        broadcastPaneState: vi.fn<() => Promise<void>>(async () => undefined),
        isPopout: false,
        setError,
        setNotice,
      });
      return null;
    }

    const testContainer = document.createElement('div');
    document.body.append(testContainer);
    const testRoot = createRoot(testContainer);
    await act(async () => testRoot.render(<Harness />));
    await act(async () => { await Promise.resolve(); });

    expect(api?.editorPopoutButton?.isPoppedOut).toBe(false);
    expect(api?.previewPopoutButton?.isPoppedOut).toBe(false);

    await act(async () => { await api?.closePopoutWindows(); });
    expect(api?.editorPopoutButton?.isPoppedOut).toBe(false);

    controllerOpen.mockRejectedValueOnce(new Error('lookup failed'));
    let outcome: Awaited<ReturnType<Extract<typeof api, object>['openPanePopout']>> | undefined;
    await act(async () => {
      outcome = await api!.openPanePopout('editor');
    });
    expect(outcome?.status).toBe('failed');
    const lastError = setError.mock.calls[setError.mock.calls.length - 1]?.[0];
    expect(typeof lastError === 'string' && lastError.length > 0).toBe(true);

    act(() => testRoot.unmount());
    testContainer.remove();
    controllerOpen.mockReset();
    controllerOpen.mockImplementation(async (pane) => ({ status: 'created', pane }));
  });
});
