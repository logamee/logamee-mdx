import { beforeEach, describe, expect, it, vi } from 'vitest';

const tauriMocks = vi.hoisted(() => {
  const once = vi.fn<(event: string, listener: () => void) => Promise<() => void>>(
    async () => () => undefined,
  );
  const setFocus = vi.fn<() => Promise<void>>(async () => undefined);
  const destroy = vi.fn<() => Promise<void>>(async () => undefined);
  const getByLabel = vi.fn<(label: string) => Promise<null>>(async () => null);
  const webviewWindow = vi.fn<(label: string, options: unknown) => {
    once: typeof once;
    setFocus: typeof setFocus;
    destroy: typeof destroy;
  }>(function MockWebviewWindow() {
    return { once, setFocus, destroy };
  });
  const listen = vi.fn<() => Promise<() => void>>(async () => () => undefined);

  return { destroy, getByLabel, listen, once, setFocus, webviewWindow };
});

vi.mock('@tauri-apps/api/event', () => ({
  TauriEvent: { WINDOW_DESTROYED: 'tauri://destroyed' },
  listen: tauriMocks.listen,
}));

vi.mock('@tauri-apps/api/webviewWindow', () => ({
  WebviewWindow: Object.assign(tauriMocks.webviewWindow, { getByLabel: tauriMocks.getByLabel }),
}));

import { TauriPaneWindowBackend } from './tauriPaneWindowBackend';

function resolveCreatedWindow() {
  const listener = tauriMocks.once.mock.calls.find(([event]) => event === 'tauri://created')?.[1];
  if (!listener) throw new Error('Created listener was not registered');
  listener();
}

describe('TauriPaneWindowBackend', () => {
  beforeEach(() => {
    tauriMocks.destroy.mockClear();
    tauriMocks.getByLabel.mockClear();
    tauriMocks.listen.mockClear();
    tauriMocks.once.mockClear();
    tauriMocks.setFocus.mockClear();
    tauriMocks.webviewWindow.mockClear();
  });

  it('creates an editor popout with its encoded instance ID in the URL', async () => {
    const backend = new TauriPaneWindowBackend();
    const created = backend.create('editor', 'editor:instance-1');

    await Promise.resolve();
    expect(tauriMocks.webviewWindow).toHaveBeenCalledWith('mmd-editor-popout', expect.objectContaining({
      title: 'mdx Editor',
      url: '/?pane=editor&instance=editor%3Ainstance-1',
    }));
    resolveCreatedWindow();
    await expect(created).resolves.toEqual(expect.objectContaining({
      focus: expect.any(Function),
      destroy: expect.any(Function),
    }));
  });

  it('keeps preview popout URLs backward compatible', async () => {
    const backend = new TauriPaneWindowBackend();
    const created = backend.create('preview', 'editor:instance-1');

    await Promise.resolve();
    expect(tauriMocks.webviewWindow).toHaveBeenCalledWith('mmd-preview-popout', expect.objectContaining({
      title: 'mdx Live Preview',
      url: '/?pane=preview',
    }));
    resolveCreatedWindow();
    await created;
  });
});
