// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_FEEDBACK_ERROR_EVENT } from '../lib/appFeedback';
import type { LocalePreference } from '../lib/locale';
import type { LocaleRuntime, LocaleRuntimeSnapshot } from '../lib/localeRuntime';
import { LocaleProvider } from '../lib/i18n';
import { MarkdownHtmlFrame } from './MarkdownHtmlFrame';

const frameMocks = vi.hoisted(() => ({
  prepare: vi.fn<(markdownPath: string, htmlSrc: string) => Promise<{ url: string; ownerId: number }>>(),
  release: vi.fn<(ownerId: number) => Promise<void>>(),
}));

vi.mock('../lib/tauriCommands', () => ({
  prepareMarkdownHtmlEmbed: frameMocks.prepare,
  releaseMarkdownHtmlEmbed: frameMocks.release,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

function createTestLocaleRuntime(initialMode: LocalePreference['mode']): LocaleRuntime {
  let snapshot: LocaleRuntimeSnapshot = {
    preference: { version: 1, mode: initialMode },
    effectiveLocale: initialMode === 'zh-CN' ? 'zh-CN' : 'en',
    revision: 1,
  };
  const listeners = new Set<() => void>();
  return {
    async start() {},
    stop() { listeners.clear(); },
    setPreference(value) {
      const next = value as LocalePreference;
      if (next.version !== 1 || (next.mode !== 'zh-CN' && next.mode !== 'en')) return false;
      snapshot = { preference: next, effectiveLocale: next.mode, revision: snapshot.revision + 1 };
      listeners.forEach((listener) => listener());
      return true;
    },
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

describe('MarkdownHtmlFrame', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    frameMocks.prepare.mockReset();
    frameMocks.release.mockReset();
    frameMocks.release.mockResolvedValue(undefined);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('does not reload an interactive page when the application locale changes', async () => {
    const runtime = createTestLocaleRuntime('en');
    frameMocks.prepare.mockResolvedValue({
      url: 'http://127.0.0.1:43127/demo.html',
      ownerId: 11,
    });
    await act(async () => root.render(
      <LocaleProvider runtime={runtime}>
        <MarkdownHtmlFrame
          currentFilePath="/workspace/guide.md"
          enabled
          htmlSrc="demo.html"
        />
      </LocaleProvider>,
    ));
    await act(async () => {
      await vi.waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());
    });
    const frame = container.querySelector('iframe');

    act(() => runtime.setPreference({ version: 1, mode: 'zh-CN' }));

    expect(frameMocks.prepare).toHaveBeenCalledOnce();
    expect(container.querySelector('iframe')).toBe(frame);
    expect(frame?.getAttribute('title')).toBe('HTML 预览：demo.html');
  });

  it('loads an embed eagerly inside a horizontally scrollable viewport', async () => {
    frameMocks.prepare.mockResolvedValue({
      url: 'http://127.0.0.1:43127/demo.html',
      ownerId: 12,
    });
    await act(async () => root.render(
      <MarkdownHtmlFrame currentFilePath="/workspace/guide.md" enabled htmlSrc="demo.html" />,
    ));
    await act(async () => {
      await vi.waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());
    });

    const viewport = container.querySelector('.mmd-html-embed-viewport');
    const frame = viewport?.querySelector('iframe');
    expect(viewport).not.toBeNull();
    expect(viewport?.tagName).toBe('SPAN');
    expect(viewport?.getAttribute('role')).toBe('region');
    expect(viewport?.getAttribute('tabindex')).toBe('0');
    expect(viewport?.getAttribute('aria-label')).toBe('HTML Preview: demo.html');
    expect(frame?.getAttribute('loading')).toBe('eager');
  });

  it('does not show the previous page after the embed source changes', async () => {
    frameMocks.prepare.mockResolvedValueOnce({
      url: 'http://127.0.0.1:43127/first.html',
      ownerId: 21,
    });
    await act(async () => root.render(
      <MarkdownHtmlFrame currentFilePath="/workspace/guide.md" enabled htmlSrc="first.html" />,
    ));
    await act(async () => {
      await vi.waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());
    });
    frameMocks.prepare.mockImplementation(() => new Promise(() => undefined));

    await act(async () => root.render(
      <MarkdownHtmlFrame currentFilePath="/workspace/guide.md" enabled htmlSrc="second.html" />,
    ));

    expect(container.querySelector('iframe')).toBeNull();
    expect(container.querySelector('output')?.getAttribute('aria-busy')).toBe('true');
    expect(frameMocks.release).toHaveBeenCalledWith(21);
  });

  it('releases a resolved embed owner when the frame unmounts', async () => {
    frameMocks.prepare.mockResolvedValue({
      url: 'http://127.0.0.1:43127/demo.html',
      ownerId: 31,
    });
    await act(async () => root.render(
      <MarkdownHtmlFrame currentFilePath="/workspace/guide.md" enabled htmlSrc="demo.html" />,
    ));
    await act(async () => {
      await vi.waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());
    });

    act(() => root.unmount());

    expect(frameMocks.release).toHaveBeenCalledWith(31);
    root = createRoot(container);
  });

  it('immediately releases a late stale response without showing its iframe', async () => {
    const firstRequest = deferred<{ url: string; ownerId: number }>();
    frameMocks.prepare
      .mockReturnValueOnce(firstRequest.promise)
      .mockImplementation(() => new Promise(() => undefined));
    await act(async () => root.render(
      <MarkdownHtmlFrame currentFilePath="/workspace/guide.md" enabled htmlSrc="first.html" />,
    ));

    await act(async () => root.render(
      <MarkdownHtmlFrame currentFilePath="/workspace/guide.md" enabled htmlSrc="second.html" />,
    ));
    await act(async () => firstRequest.resolve({
      url: 'http://127.0.0.1:43127/first.html',
      ownerId: 41,
    }));

    expect(frameMocks.release).toHaveBeenCalledWith(41);
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.querySelector('output')?.getAttribute('aria-busy')).toBe('true');
  });

  it('ignores a stale failure after the embed source changes', async () => {
    const firstRequest = deferred<{ url: string; ownerId: number }>();
    const feedback = vi.fn<(event: Event) => void>();
    window.addEventListener(APP_FEEDBACK_ERROR_EVENT, feedback);
    frameMocks.prepare
      .mockReturnValueOnce(firstRequest.promise)
      .mockResolvedValueOnce({
        url: 'http://127.0.0.1:43127/second.html',
        ownerId: 42,
      });

    try {
      await act(async () => root.render(
        <MarkdownHtmlFrame currentFilePath="/workspace/guide.md" enabled htmlSrc="first.html" />,
      ));
      await act(async () => root.render(
        <MarkdownHtmlFrame currentFilePath="/workspace/guide.md" enabled htmlSrc="second.html" />,
      ));
      await act(async () => {
        await vi.waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());
      });

      await act(async () => firstRequest.reject(new Error('first embed failed')));

      expect(container.querySelector('iframe')?.getAttribute('src')).toBe(
        'http://127.0.0.1:43127/second.html',
      );
      expect(feedback).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener(APP_FEEDBACK_ERROR_EVENT, feedback);
    }
  });

  it('releases the ready owner and shows a non-busy unavailable state when disabled', async () => {
    frameMocks.prepare.mockResolvedValue({
      url: 'http://127.0.0.1:43127/demo.html',
      ownerId: 43,
    });
    await act(async () => root.render(
      <MarkdownHtmlFrame currentFilePath="/workspace/guide.md" enabled htmlSrc="demo.html" />,
    ));
    await act(async () => {
      await vi.waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());
    });

    await act(async () => root.render(
      <MarkdownHtmlFrame currentFilePath="/workspace/guide.md" enabled={false} htmlSrc="demo.html" />,
    ));

    expect(frameMocks.release).toHaveBeenCalledWith(43);
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.querySelector('output')?.getAttribute('aria-busy')).toBe('false');
  });

  it('emits one raw feedback event and shows a non-busy unavailable state for the current failure', async () => {
    const feedback = vi.fn<(event: Event) => void>();
    window.addEventListener(APP_FEEDBACK_ERROR_EVENT, feedback);
    frameMocks.prepare.mockRejectedValue(new Error('HTML embed target is not accessible'));

    try {
      await act(async () => root.render(
        <MarkdownHtmlFrame currentFilePath="/workspace/guide.md" enabled htmlSrc="missing.html" />,
      ));
      await act(async () => {
        await vi.waitFor(() => expect(feedback).toHaveBeenCalledOnce());
      });

      expect(container.querySelector('iframe')).toBeNull();
      expect(container.querySelector('output')?.getAttribute('aria-busy')).toBe('false');
      expect((feedback.mock.calls[0][0] as CustomEvent<string>).detail).toBe(
        'HTML embed target is not accessible',
      );
    } finally {
      window.removeEventListener(APP_FEEDBACK_ERROR_EVENT, feedback);
    }
  });

  it('silently ignores embed release cleanup failures', async () => {
    frameMocks.prepare.mockResolvedValue({
      url: 'http://127.0.0.1:43127/demo.html',
      ownerId: 51,
    });
    frameMocks.release.mockRejectedValue(new Error('cleanup failed'));
    await act(async () => root.render(
      <MarkdownHtmlFrame currentFilePath="/workspace/guide.md" enabled htmlSrc="demo.html" />,
    ));
    await act(async () => {
      await vi.waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());
    });

    await act(async () => root.render(
      <MarkdownHtmlFrame currentFilePath="/workspace/guide.md" enabled htmlSrc="next.html" />,
    ));

    expect(frameMocks.release).toHaveBeenCalledWith(51);
  });
});
