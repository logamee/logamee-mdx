// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_FEEDBACK_ERROR_EVENT } from '../../lib/appFeedback';
import { useAppWindowCommands, type AppWindowCommandDeps } from './appWindowCommands';

const mocks = vi.hoisted(() => ({
  listen: vi.fn<typeof import('@tauri-apps/api/event').listen>(),
  getStartupError: vi.fn<() => Promise<string | null>>(),
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }));
vi.mock('../../lib/tauriCommands/startup', () => ({ getStartupError: mocks.getStartupError }));
vi.mock('../../lib/tauriCommands', () => ({
  setNativeSaveMenuEnabled: vi.fn<(enabled: boolean) => Promise<void>>(async () => undefined),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function Harness({ deps }: { deps: AppWindowCommandDeps }) {
  useAppWindowCommands(deps);
  return null;
}

function createDeps(): AppWindowCommandDeps {
  return {
    isPopout: false, locale: 'zh-CN', modalActive: false,
    nativeSaveMenuEnabled: false, shortcutsConfig: {},
    setError: vi.fn<(message: string | null) => void>(),
    setNotice: vi.fn<(message: string | null) => void>(),
    targets: {
      clearRecentFiles: async () => undefined,
      enqueueNativeMenuIntent: () => undefined,
      increaseEditorFont: () => undefined,
      decreaseEditorFont: () => undefined,
      resetEditorFont: () => undefined,
      openExportDialog: () => undefined,
      openSettings: () => undefined,
      save: async () => undefined,
      saveAs: async () => undefined,
      showQuickOpen: () => undefined,
      showWorkspaceSearch: () => undefined,
    },
  };
}

describe('startup feedback in app window commands', () => {
  let root: Root;
  let container: HTMLDivElement;
  let deps: AppWindowCommandDeps;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    mocks.listen.mockReset().mockResolvedValue(() => undefined);
    mocks.getStartupError.mockReset().mockResolvedValue(null);
    deps = createDeps();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('queries only after the main feedback listener is registered and uses shared feedback', async () => {
    const registration = deferred<() => void>();
    mocks.listen.mockImplementation((event) => event === APP_FEEDBACK_ERROR_EVENT
      ? registration.promise : Promise.resolve(() => undefined));
    mocks.getStartupError.mockResolvedValue('Recent files unavailable at startup');
    await act(async () => root.render(<Harness deps={deps} />));
    expect(mocks.getStartupError).not.toHaveBeenCalled();

    await act(async () => registration.resolve(() => undefined));
    expect(mocks.getStartupError).toHaveBeenCalledOnce();
    expect(deps.setError).toHaveBeenCalledExactlyOnceWith('最近文件历史列表暂不可用。请稍后重新启动 mdx 再试。');
    expect(deps.setNotice).toHaveBeenCalledExactlyOnceWith(null);
  });

  it('does not show a modal when there is no startup error', async () => {
    await act(async () => root.render(<Harness deps={deps} />));
    expect(mocks.getStartupError).toHaveBeenCalledOnce();
    expect(deps.setError).not.toHaveBeenCalled();
    expect(deps.setNotice).not.toHaveBeenCalled();
  });

  it('does not query from popout windows', async () => {
    deps.isPopout = true;
    await act(async () => root.render(<Harness deps={deps} />));
    expect(mocks.getStartupError).not.toHaveBeenCalled();
    expect(mocks.listen).not.toHaveBeenCalled();
  });

  it('releases a listener registered after unmount without querying', async () => {
    const registration = deferred<() => void>();
    const unlisten = vi.fn<() => void>();
    mocks.listen.mockImplementation((event) => event === APP_FEEDBACK_ERROR_EVENT
      ? registration.promise : Promise.resolve(() => undefined));
    await act(async () => root.render(<Harness deps={deps} />));
    await act(async () => root.unmount());
    await act(async () => registration.resolve(unlisten));
    expect(unlisten).toHaveBeenCalledOnce();
    expect(mocks.getStartupError).not.toHaveBeenCalled();
    expect(deps.setError).not.toHaveBeenCalled();
  });

  it.each(['resolve', 'reject'] as const)('ignores a startup query %s after unmount', async (settle) => {
    const query = deferred<string | null>();
    mocks.getStartupError.mockReturnValue(query.promise);
    await act(async () => root.render(<Harness deps={deps} />));
    await act(async () => root.unmount());
    await act(async () => {
      if (settle === 'resolve') query.resolve('Recent files unavailable at startup');
      else query.reject(new Error('invoke failed'));
    });
    expect(deps.setError).not.toHaveBeenCalled();
    expect(deps.setNotice).not.toHaveBeenCalled();
  });

  it('normalizes query failures using the existing error channel', async () => {
    mocks.getStartupError.mockRejectedValue(new Error('Tauri invoke failed: private detail'));
    await act(async () => root.render(<Harness deps={deps} />));
    expect(deps.setError).toHaveBeenCalledExactlyOnceWith('应用窗口通信暂时失败。请重试。');
    expect(deps.setNotice).toHaveBeenCalledExactlyOnceWith(null);
  });

  it('does not query if listener registration fails', async () => {
    mocks.listen.mockImplementation((event) => event === APP_FEEDBACK_ERROR_EVENT
      ? Promise.reject(new Error('Tauri listener failed')) : Promise.resolve(() => undefined));
    await act(async () => root.render(<Harness deps={deps} />));
    expect(mocks.getStartupError).not.toHaveBeenCalled();
    expect(deps.setError).toHaveBeenCalledExactlyOnceWith('应用窗口通信暂时失败。请重试。');
  });

  it('does not reopen dismissed startup feedback when the locale changes', async () => {
    mocks.getStartupError.mockResolvedValue('Recent files unavailable at startup');
    await act(async () => root.render(<Harness deps={deps} />));
    expect(deps.setError).toHaveBeenCalledExactlyOnceWith('最近文件历史列表暂不可用。请稍后重新启动 mdx 再试。');
    vi.mocked(deps.setError).mockClear();
    vi.mocked(deps.setNotice).mockClear();

    await act(async () => root.render(<Harness deps={{ ...deps, locale: 'en' }} />));

    expect(deps.setError).not.toHaveBeenCalled();
    expect(deps.setNotice).not.toHaveBeenCalled();
    expect(mocks.getStartupError).toHaveBeenCalledOnce();
  });

  it('delivers a pending startup error once to the active locale after cleanup', async () => {
    const firstQuery = deferred<string | null>();
    const activeQuery = deferred<string | null>();
    mocks.getStartupError.mockReturnValueOnce(firstQuery.promise).mockReturnValueOnce(activeQuery.promise);
    await act(async () => root.render(<Harness deps={deps} />));
    await act(async () => root.render(<Harness deps={{ ...deps, locale: 'en' }} />));
    await act(async () => firstQuery.resolve('Recent files unavailable at startup'));
    expect(deps.setError).not.toHaveBeenCalled();

    await act(async () => activeQuery.resolve('Recent files unavailable at startup'));
    expect(deps.setError).toHaveBeenCalledExactlyOnceWith('The recent files list is temporarily unavailable. Restart mdx later and try again.');
    vi.mocked(deps.setError).mockClear();
    await act(async () => root.render(<Harness deps={deps} />));
    expect(deps.setError).not.toHaveBeenCalled();
    expect(mocks.getStartupError).toHaveBeenCalledTimes(2);
  });

  it('does not lose startup feedback when StrictMode replays effects', async () => {
    const unlisten = vi.fn<() => void>();
    mocks.listen.mockResolvedValue(unlisten);
    mocks.getStartupError.mockResolvedValue('Recent files unavailable at startup');
    await act(async () => root.render(<StrictMode><Harness deps={deps} /></StrictMode>));
    expect(unlisten).toHaveBeenCalledTimes(2);
    expect(mocks.getStartupError).toHaveBeenCalledOnce();
    expect(deps.setError).toHaveBeenCalledExactlyOnceWith('最近文件历史列表暂不可用。请稍后重新启动 mdx 再试。');
  });
});
