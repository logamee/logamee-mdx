// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useProgramCloseGuard } from './useProgramCloseGuard';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const windowMocks = vi.hoisted(() => ({
  destroy: vi.fn<() => Promise<void>>(),
  onCloseRequested: vi.fn<() => Promise<() => void>>(),
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => windowMocks,
}));

let forceCloseProgram: (() => Promise<void>) | null = null;

function Harness({ flushWorkspaceSession }: { flushWorkspaceSession: () => Promise<void> }) {
  forceCloseProgram = useProgramCloseGuard({
    closePopoutWindows: async () => undefined,
    dirty: false,
    flushWorkspaceSession,
    isPopout: false,
    setError: () => undefined,
    setNotice: () => undefined,
    setShowUnsavedExitPrompt: () => undefined,
  }).forceCloseProgram;
  return null;
}

describe('useProgramCloseGuard', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    forceCloseProgram = null;
    windowMocks.destroy.mockReset();
    windowMocks.onCloseRequested.mockReset();
    windowMocks.destroy.mockResolvedValue(undefined);
    windowMocks.onCloseRequested.mockResolvedValue(() => undefined);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    forceCloseProgram = null;
  });

  it('waits for the latest workspace session before destroying the program window', async () => {
    const flush = deferred<void>();
    act(() => root.render(<Harness flushWorkspaceSession={() => flush.promise} />));
    if (!forceCloseProgram) throw new Error('Expected close handler');

    let closing!: Promise<void>;
    await act(async () => {
      closing = forceCloseProgram!();
      await Promise.resolve();
    });
    expect(windowMocks.destroy).not.toHaveBeenCalled();

    flush.resolve(undefined);
    await act(async () => closing);

    expect(windowMocks.destroy).toHaveBeenCalledOnce();
  });
});

describe('useProgramCloseGuard close-request branches', () => {
  let container: HTMLDivElement;
  let root: Root;
  let closeHandler: ((event: { preventDefault: () => void }) => Promise<void>) | null = null;
  let showUnsavedPrompt: (show: boolean) => void;
  let errorSink: (message: string | null) => void;

  beforeEach(() => {
    windowMocks.destroy.mockReset();
    windowMocks.onCloseRequested.mockReset();
    windowMocks.onCloseRequested.mockImplementation(
      async (...args: unknown[]) => {
        closeHandler = args[0] as typeof closeHandler;
        return () => undefined;
      },
    );
    showUnsavedPrompt = vi.fn<(show: boolean) => void>();
    errorSink = vi.fn<(message: string | null) => void>();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function renderGuard(overrides: { dirty?: boolean; flush?: () => Promise<void>; closePopouts?: () => Promise<void> } = {}): void {
    function Harness(): null {
      useProgramCloseGuard({
        closePopoutWindows: overrides.closePopouts ?? (async () => undefined),
        dirty: overrides.dirty ?? false,
        flushWorkspaceSession: overrides.flush ?? (async () => undefined),
        isPopout: false,
        setError: errorSink,
        setNotice: vi.fn<(...args: unknown[]) => void>(),
        setShowUnsavedExitPrompt: showUnsavedPrompt,
      });
      return null;
    }
    act(() => root.render(<Harness />));
  }

  it('prevents close and shows the unsaved prompt for dirty documents', async () => {
    renderGuard({ dirty: true });
    const event = { preventDefault: vi.fn<() => void>() };
    await act(async () => { await closeHandler?.(event); });
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(showUnsavedPrompt).toHaveBeenCalledWith(true);
  });

  it('reports a flush failure and prevents close', async () => {
    renderGuard({ flush: async () => { throw new Error('disk full'); } });
    const event = { preventDefault: vi.fn<() => void>() };
    await act(async () => { await closeHandler?.(event); });
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(errorSink).toHaveBeenCalledWith(expect.any(String));
  });

  it('flushes then lets the default close proceed on success', async () => {
    renderGuard();
    const event = { preventDefault: vi.fn<() => void>() };
    await act(async () => { await closeHandler?.(event); });
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});
