// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppToolbar } from '../components/AppToolbar';
import { LocaleProvider, translate } from './i18n';
import type { LocalePreference } from './locale';
import type { LocaleRuntime, LocaleRuntimeSnapshot } from './localeRuntime';

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
      snapshot = {
        preference: next,
        effectiveLocale: next.mode,
        revision: snapshot.revision + 1,
      };
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

describe('UI translations', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

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

  it('keeps catalog interpolation consistent in Chinese and English', () => {
    expect(translate('zh-CN', 'unsavedSwitchMessage', { name: '草稿.md', target: '发布.md' }))
      .toBe('“草稿.md” 尚未保存。切换到“发布.md”前要保存吗？');
    expect(translate('en', 'unsavedSwitchMessage', { name: 'draft.md', target: 'release.md' }))
      .toBe('“draft.md” has not been saved. Save before switching to “release.md”?');
  });

  it('updates visible chrome immediately when the runtime language changes', () => {
    const runtime = createTestLocaleRuntime('zh-CN');
    act(() => root.render(
      <LocaleProvider runtime={runtime}>
        <AppToolbar
          activePath="/workspace/draft.md"
          busy={false}
          canSearch
          dirty
          onQuickOpen={() => undefined}
          onWorkspaceSearch={() => undefined}
        />
      </LocaleProvider>,
    ));

    expect(container.querySelector('.document-status')?.textContent).toContain('已编辑');
    expect(container.querySelector('.toolbar-document')?.getAttribute('aria-label')).toBe('当前文档');

    act(() => runtime.setPreference({ version: 1, mode: 'en' }));

    expect(container.querySelector('.document-status')?.textContent).toContain('Edited');
    expect(container.querySelector('.toolbar-document')?.getAttribute('aria-label')).toBe('Current document');
  });
});
