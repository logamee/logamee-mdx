// @vitest-environment jsdom

import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TreeRowRenameInput } from './fileTreeRowRename';

function key(key: string, init: KeyboardEventInit = {}) {
  return new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key, ...init });
}

describe('TreeRowRenameInput', () => {
  let container: HTMLDivElement;
  let root: Root;
  let input: HTMLInputElement | null;
  let onCancelRename: ReturnType<typeof vi.fn<() => void>>;
  let commitRename: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    onCancelRename = vi.fn<() => void>();
    commitRename = vi.fn<() => void>();
    act(() => {
      root.render(
        <TreeRowRenameInput
          draftName="指南.md"
          node={{ name: 'guide.md' }}
          renameInputRef={createRef<HTMLInputElement>()}
          setDraftName={vi.fn<(name: string) => void>()}
          onCancelRename={onCancelRename}
          commitRename={commitRename}
          renameFinishedRef={{ current: false }}
        />,
      );
    });
    input = container.querySelector<HTMLInputElement>('.tree-inline-rename');
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('ignores Enter and Escape while an IME composition is active', () => {
    const composingEnter = key('Enter', { isComposing: true });
    const composingEscape = key('Escape', { isComposing: true });

    act(() => input?.dispatchEvent(composingEnter));
    act(() => input?.dispatchEvent(composingEscape));

    expect(commitRename).not.toHaveBeenCalled();
    expect(onCancelRename).not.toHaveBeenCalled();
    expect(composingEnter.defaultPrevented).toBe(false);
    expect(composingEscape.defaultPrevented).toBe(false);
  });

  it('ignores the Enter WebKit reports with keyCode 229 after the composition ends', () => {
    const lateComposeEnter = key('Enter', { keyCode: 229 });

    act(() => input?.dispatchEvent(lateComposeEnter));

    expect(commitRename).not.toHaveBeenCalled();
    expect(lateComposeEnter.defaultPrevented).toBe(false);
  });

  it('commits on a plain Enter and cancels on a plain Escape', () => {
    act(() => input?.dispatchEvent(key('Enter')));
    act(() => input?.dispatchEvent(key('Escape')));

    expect(commitRename).toHaveBeenCalledOnce();
    expect(onCancelRename).toHaveBeenCalledOnce();
  });
});
