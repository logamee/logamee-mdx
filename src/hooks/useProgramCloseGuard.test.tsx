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
