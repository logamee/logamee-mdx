// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceEntryDialog, type WorkspaceEntryOperation } from './WorkspaceEntryDialog';

function escapeKey(isComposing: boolean) {
  return new KeyboardEvent('keydown', { bubbles: true, cancelable: true, isComposing, key: 'Escape' });
}

const createFile: WorkspaceEntryOperation = {
  fileKind: 'markdown', kind: 'create-file', parentName: 'notes', parentPath: '/workspace/notes',
};

describe('WorkspaceEntryDialog', () => {
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

  const render = (operation: WorkspaceEntryOperation, onCancel = vi.fn<() => void>(), onConfirm = vi.fn<(name?: string) => void>()) => {
    act(() => {
      root.render(
        <WorkspaceEntryDialog
          busy={false}
          operation={operation}
          onCancel={onCancel}
          onConfirm={onConfirm}
        />,
      );
    });
    return { onCancel, onConfirm };
  };

  it('ignores a composing Escape and still cancels on a plain Escape', () => {
    const { onCancel } = render(createFile);
    const input = container.querySelector<HTMLInputElement>('.workspace-entry-dialog-field input');
    const composing = escapeKey(true);

    act(() => input?.dispatchEvent(composing));

    expect(onCancel).not.toHaveBeenCalled();
    expect(composing.defaultPrevented).toBe(false);

    act(() => input?.dispatchEvent(escapeKey(false)));

    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('selects the whole current name for a rename and submits the edited name', async () => {
    const { onConfirm } = render({ currentName: 'guide.md', entryKind: 'file', kind: 'rename', path: '/workspace/guide.md' });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const input = container.querySelector<HTMLInputElement>('.workspace-entry-dialog-field input');

    expect(input?.value).toBe('guide.md');
    expect(document.activeElement).toBe(input);
    expect([input?.selectionStart, input?.selectionEnd]).toEqual([0, 8]);

    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'renamed.md');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => {
      container.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(onConfirm).toHaveBeenCalledOnce();
    expect(onConfirm).toHaveBeenCalledWith('renamed.md');
  });

  it('focuses a new file name with only its extension left out of the selection', async () => {
    render({ ...createFile, fileKind: 'excalidraw' });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const input = container.querySelector<HTMLInputElement>('.workspace-entry-dialog-field input');

    expect(input?.value).toBe('Untitled.excalidraw');
    expect(document.activeElement).toBe(input);
    expect([input?.selectionStart, input?.selectionEnd]).toEqual([0, 8]);
  });

  it('confirms a delete as an alert dialog without asking for a name', () => {
    const { onConfirm } = render({ currentName: 'notes', entryKind: 'folder', kind: 'delete', path: '/workspace/notes' });

    expect(container.querySelector('[role="alertdialog"]')).not.toBeNull();
    expect(container.querySelector('.workspace-entry-dialog-field input')).toBeNull();

    act(() => {
      container.querySelector<HTMLButtonElement>('button[type="submit"]')?.click();
    });

    expect(onConfirm).toHaveBeenCalledWith(undefined);
  });
});
