// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceMoveDialog } from './WorkspaceMoveDialog';

function escapeKey(isComposing: boolean) {
  return new KeyboardEvent('keydown', { bubbles: true, cancelable: true, isComposing, key: 'Escape' });
}

describe('WorkspaceMoveDialog', () => {
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

  it('ignores a composing Escape and still cancels on a plain Escape', () => {
    const onCancel = vi.fn<() => void>();
    act(() => {
      root.render(
        <WorkspaceMoveDialog
          busy={false}
          destinations={[{ label: 'archive', path: '/workspace/archive' }]}
          onCancel={onCancel}
          onConfirm={vi.fn<(destinationParentPath: string) => void>()}
          operation={{ currentName: 'notes.md', entryKind: 'file', path: '/workspace/notes.md' }}
        />,
      );
    });
    const select = container.querySelector<HTMLSelectElement>('.workspace-entry-dialog-field select');
    const composing = escapeKey(true);

    act(() => select?.dispatchEvent(composing));

    expect(onCancel).not.toHaveBeenCalled();
    expect(composing.defaultPrevented).toBe(false);

    act(() => select?.dispatchEvent(escapeKey(false)));

    expect(onCancel).toHaveBeenCalledOnce();
  });
});
