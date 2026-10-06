// @vitest-environment jsdom

import { act } from 'react';
import type { ComponentProps, KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceFileTreeNode } from '../../lib/fileTree';
import { FileTreeRows } from './FileTreeRows';
import { handleTreeRowKeyDown, type TreeRowKeyActions } from './fileTreeRowInteractions';
import { commitTreeRowRename } from './fileTreeRowRename';

const fileNode: WorkspaceFileTreeNode = {
  absolutePath: '/workspace/guide.md',
  kind: 'file',
  name: 'guide.md',
  path: '/workspace/guide.md',
  relativePath: 'guide.md',
  file: { kind: 'markdown', name: 'guide.md', path: '/workspace/guide.md', relative_path: 'guide.md' },
};

const folderNode: WorkspaceFileTreeNode = {
  absolutePath: '/workspace/notes',
  kind: 'folder',
  name: 'notes',
  path: 'notes',
  children: [fileNode],
};

function pressKey(acts: TreeRowKeyActions, key: string, init: KeyboardEventInit = {}): void {
  const element = document.createElement('div');
  document.body.append(element);
  element.addEventListener('keydown', (event) => {
    handleTreeRowKeyDown(event as unknown as ReactKeyboardEvent<HTMLDivElement>, acts);
  });
  element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }));
  element.remove();
}

describe('FileTreeRows document presentation', () => {
  it('renders distinct PDF, DOCX, and Excalidraw icons and carries file kind into context policy', () => {
    const targets: unknown[] = [];
    type RowsProps = ComponentProps<typeof FileTreeRows>;
    const html = renderToStaticMarkup(
      <FileTreeRows
        activePath={null}
        collapsedFolders={new Set()}
        draggingPath={null}
        dropTargetPath={null}
        nodes={[
          {
            absolutePath: '/workspace/guide.pdf',
            kind: 'file',
            name: 'guide.pdf',
            path: '/workspace/guide.pdf',
            relativePath: 'guide.pdf',
            file: { kind: 'pdf', name: 'guide.pdf', path: '/workspace/guide.pdf', relative_path: 'guide.pdf' },
          },
          {
            absolutePath: '/workspace/report.docx',
            kind: 'file',
            name: 'report.docx',
            path: '/workspace/report.docx',
            relativePath: 'report.docx',
            file: { kind: 'docx', name: 'report.docx', path: '/workspace/report.docx', relative_path: 'report.docx' },
          },
          {
            absolutePath: '/workspace/architecture.excalidraw',
            kind: 'file',
            name: 'architecture.excalidraw',
            path: '/workspace/architecture.excalidraw',
            relativePath: 'architecture.excalidraw',
            file: { kind: 'excalidraw', name: 'architecture.excalidraw', path: '/workspace/architecture.excalidraw', relative_path: 'architecture.excalidraw' },
          },
        ]}
        onBeginRename={vi.fn<RowsProps['onBeginRename']>()}
        onCancelRename={vi.fn<RowsProps['onCancelRename']>()}
        onCommitRename={vi.fn<RowsProps['onCommitRename']>()}
        onDeleteEntry={vi.fn<RowsProps['onDeleteEntry']>()}
        onOpenContextMenu={(_x, _y, target) => targets.push(target)}
        onOpenFile={vi.fn<(path: string) => void>()}
        onSelectTarget={vi.fn<RowsProps['onSelectTarget']>()}
        onToggleFolder={vi.fn<(path: string) => void>()}
        renamingPath={null}
        selectedPath={null}
      />,
    );

    expect(html).toContain('tree-icon pdf-icon');
    expect(html).toContain('tree-icon docx-icon');
    expect(html).toContain('tree-icon excalidraw-icon');
  });
});

describe('tree row keyboard interactions', () => {
  const contextTarget = { kind: 'file', fileKind: 'markdown', name: 'guide.md', path: '/workspace/guide.md' } as const;

  function actions(overrides: Partial<TreeRowKeyActions> = {}): TreeRowKeyActions {
    return {
      collapsed: false,
      contextTarget,
      disabled: false,
      node: fileNode,
      onBeginRename: vi.fn<(...args: unknown[]) => void>(),
      onDeleteEntry: vi.fn<(...args: unknown[]) => void>(),
      onOpenContextMenu: vi.fn<(...args: unknown[]) => void>(),
      onOpenFile: vi.fn<(...args: unknown[]) => void>(),
      onToggleFolder: vi.fn<(...args: unknown[]) => void>(),
      ...overrides,
    } as TreeRowKeyActions;
  }

  it('starts rename on Enter and F2', () => {
    const acts = actions();
    pressKey(acts, 'Enter');
    pressKey(acts, 'F2');
    expect(acts.onBeginRename).toHaveBeenCalledTimes(2);
  });

  it('deletes with meta+backspace and opens with meta+o or space', () => {
    const acts = actions();
    pressKey(acts, 'Backspace', { metaKey: true });
    pressKey(acts, 'o', { metaKey: true });
    pressKey(acts, ' ');
    expect(acts.onDeleteEntry).toHaveBeenCalledTimes(1);
    expect(acts.onOpenFile).toHaveBeenCalledTimes(2);
  });

  it('opens the context menu with the keyboard shortcut and ignores keys while disabled', () => {
    const acts = actions();
    pressKey(acts, 'ContextMenu');
    expect(acts.onOpenContextMenu).toHaveBeenCalledTimes(1);
    const blocked = actions({ disabled: true });
    pressKey(blocked, 'ContextMenu');
    expect(blocked.onOpenContextMenu).not.toHaveBeenCalled();
  });

  it('toggles folders with arrow keys only in the matching collapse state', () => {
    const folderActions = actions({
      contextTarget: { kind: 'folder', name: 'notes', path: 'notes' },
      collapsed: true,
      node: folderNode,
    });
    pressKey(folderActions, 'ArrowRight');
    expect(folderActions.onToggleFolder).toHaveBeenCalledWith('notes');
    const expanded = actions({
      contextTarget: { kind: 'folder', name: 'notes', path: 'notes' },
      collapsed: false,
      node: folderNode,
    });
    pressKey(expanded, 'ArrowLeft');
    pressKey(expanded, 'ArrowRight');
    expect(expanded.onToggleFolder).toHaveBeenCalledTimes(1);
  });
});

describe('tree row rename commit', () => {
  it('commits a changed name once and treats empty or unchanged names as cancel', () => {
    const onCommitRename = vi.fn<(...args: unknown[]) => void>();
    const onCancelRename = vi.fn<(...args: unknown[]) => void>();
    const finished = { current: false };
    const deps = {
      contextTarget: { kind: 'file', fileKind: 'markdown', name: 'guide.md', path: '/workspace/guide.md' } as never,
      draftName: 'renamed.md',
      node: fileNode,
      onCancelRename,
      onCommitRename,
      renameFinishedRef: finished,
    };
    commitTreeRowRename(deps);
    commitTreeRowRename(deps);
    expect(onCommitRename).toHaveBeenCalledTimes(1);
    expect(onCancelRename).not.toHaveBeenCalled();

    commitTreeRowRename({ ...deps, draftName: '   ', renameFinishedRef: { current: false } });
    commitTreeRowRename({ ...deps, draftName: 'guide.md', renameFinishedRef: { current: false } });
    expect(onCancelRename).toHaveBeenCalledTimes(2);
  });
});

describe('FileTreeRows rename input rendering', () => {
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

  it('focuses and commits the inline rename input', () => {
    const onCommitRename = vi.fn<(...args: unknown[]) => void>();
    act(() => root.render(
      <FileTreeRows
        activePath={null}
        collapsedFolders={new Set()}
        draggingPath={null}
        dropTargetPath={null}
        nodes={[fileNode]}
        onBeginRename={vi.fn<(...args: unknown[]) => void>()}
        onCancelRename={vi.fn<(...args: unknown[]) => void>()}
        onCommitRename={onCommitRename}
        onDeleteEntry={vi.fn<(...args: unknown[]) => void>()}
        onOpenContextMenu={vi.fn<(...args: unknown[]) => void>()}
        onOpenFile={vi.fn<(...args: unknown[]) => void>()}
        onSelectTarget={vi.fn<(...args: unknown[]) => void>()}
        onToggleFolder={vi.fn<(...args: unknown[]) => void>()}
        renamingPath="/workspace/guide.md"
        selectedPath="/workspace/guide.md"
      />,
    ));

    const input = container.querySelector<HTMLInputElement>('.tree-inline-rename');
    expect(input).not.toBeNull();
    act(() => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      valueSetter?.call(input, 'renamed.md');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => {
      input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onCommitRename).toHaveBeenCalledTimes(1);
  });

  it('cancels via Escape and stops click propagation on the input', () => {
    const onCancelRename = vi.fn<(...args: unknown[]) => void>();
    act(() => root.render(
      <FileTreeRows
        activePath={null}
        collapsedFolders={new Set()}
        draggingPath={null}
        dropTargetPath={null}
        nodes={[fileNode]}
        onBeginRename={vi.fn<(...args: unknown[]) => void>()}
        onCancelRename={onCancelRename}
        onCommitRename={vi.fn<(...args: unknown[]) => void>()}
        onDeleteEntry={vi.fn<(...args: unknown[]) => void>()}
        onOpenContextMenu={vi.fn<(...args: unknown[]) => void>()}
        onOpenFile={vi.fn<(...args: unknown[]) => void>()}
        onSelectTarget={vi.fn<(...args: unknown[]) => void>()}
        onToggleFolder={vi.fn<(...args: unknown[]) => void>()}
        renamingPath="/workspace/guide.md"
        selectedPath="/workspace/guide.md"
      />,
    ));
    const input = container.querySelector<HTMLInputElement>('.tree-inline-rename');
    act(() => {
      input?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      input?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onCancelRename).toHaveBeenCalledTimes(1);
  });

  it('falls back to setTimeout focus when requestAnimationFrame is unavailable and cleans up on unmount', async () => {
    const originalRaf = globalThis.requestAnimationFrame;
    (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = undefined;
    try {
      act(() => root.render(
        <FileTreeRows
          activePath={null}
          collapsedFolders={new Set()}
          draggingPath={null}
          dropTargetPath={null}
          nodes={[fileNode]}
          onBeginRename={vi.fn<(...args: unknown[]) => void>()}
          onCancelRename={vi.fn<(...args: unknown[]) => void>()}
          onCommitRename={vi.fn<(...args: unknown[]) => void>()}
          onDeleteEntry={vi.fn<(...args: unknown[]) => void>()}
          onOpenContextMenu={vi.fn<(...args: unknown[]) => void>()}
          onOpenFile={vi.fn<(...args: unknown[]) => void>()}
          onSelectTarget={vi.fn<(...args: unknown[]) => void>()}
          onToggleFolder={vi.fn<(...args: unknown[]) => void>()}
          renamingPath="/workspace/guide.md"
          selectedPath="/workspace/guide.md"
        />,
      ));
      await act(async () => {
        await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
      });
      expect(container.querySelector('.tree-inline-rename')).not.toBeNull();
      act(() => root.render(null));
    } finally {
      (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = originalRaf;
    }
  });
});
