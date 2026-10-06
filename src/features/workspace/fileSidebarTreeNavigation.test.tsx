// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import type { FileTreeClipboardItem } from '../../lib/fileTreeClipboard';
import type { WorkspaceFileTreeNode } from '../../lib/fileTree';
import { handleTreeNavigationBody, type TreeNavigationContext } from './fileSidebarTreeNavigation';

const fileTree: WorkspaceFileTreeNode[] = [
  {
    absolutePath: '/ws/notes',
    kind: 'folder',
    name: 'notes',
    path: 'notes',
    children: [],
  },
  {
    absolutePath: '/ws/draft.md',
    kind: 'file',
    name: 'draft.md',
    path: '/ws/draft.md',
    relativePath: 'draft.md',
    file: { kind: 'markdown', name: 'draft.md', path: '/ws/draft.md', relative_path: 'draft.md' },
  },
];

function buildTree(ctx: TreeNavigationContext): HTMLElement {
  const tree = document.createElement('div');
  for (const node of fileTree) {
    const row = document.createElement('div');
    row.setAttribute('role', 'treeitem');
    row.dataset.treeEntryPath = node.kind === 'folder' ? node.absolutePath : node.path;
    row.dataset.contextMenuTarget = node.kind === 'folder' ? 'folder' : 'file';
    row.tabIndex = -1;
    tree.append(row);
  }
  tree.addEventListener('keydown', (event) => {
    handleTreeNavigationBody(event as never, ctx);
  });
  document.body.append(tree);
  return tree;
}

function press(target: HTMLElement, key: string, init: { metaKey?: boolean } = {}): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }));
}

function buildContext(overrides: Partial<TreeNavigationContext> = {}): TreeNavigationContext {
  return {
    clipboard: null,
    fileTreeRef: { current: fileTree },
    onCopyEntry: vi.fn<(...args: unknown[]) => void>(),
    onCutEntry: vi.fn<(...args: unknown[]) => void>(),
    onPasteEntry: vi.fn<(...args: unknown[]) => void>(),
    rootButtonRef: { current: null },
    ...overrides,
  };
}

describe('file sidebar tree navigation', () => {
  it('copies, cuts and pastes through clipboard shortcuts on tree rows', () => {
    const clipboard = { kind: 'copy', path: '/ws/draft.md', name: 'draft.md' } as unknown as FileTreeClipboardItem;
    const ctx = buildContext({ clipboard });
    const tree = buildTree(ctx);
    const folderRow = tree.children[0] as HTMLElement;
    const fileRow = tree.children[1] as HTMLElement;

    press(fileRow, 'c', { metaKey: true });
    press(fileRow, 'x', { metaKey: true });
    expect(ctx.onCopyEntry).toHaveBeenCalledTimes(1);
    expect(ctx.onCutEntry).toHaveBeenCalledTimes(1);

    press(folderRow, 'v', { metaKey: true });
    expect(ctx.onPasteEntry).toHaveBeenCalledWith('/ws/notes');
    press(fileRow, 'v', { metaKey: true });
    expect(ctx.onPasteEntry).toHaveBeenCalledWith('/ws');
    tree.remove();
  });

  it('ignores clipboard shortcuts outside tree rows and unknown keys', () => {
    const ctx = buildContext();
    const tree = buildTree(ctx);
    press(tree, 'c', { metaKey: true });
    press(tree.children[1] as HTMLElement, 'z', { metaKey: true });
    expect(ctx.onCopyEntry).not.toHaveBeenCalled();
    expect(ctx.onPasteEntry).not.toHaveBeenCalled();
    tree.remove();
  });

  it('moves focus through rows and falls back to the root button above the first row', () => {
    const rootButton = document.createElement('button');
    document.body.append(rootButton);
    const ctx = buildContext({ rootButtonRef: { current: rootButton } });
    const tree = buildTree(ctx);
    const first = tree.children[0] as HTMLElement;
    const second = tree.children[1] as HTMLElement;
    first.focus();

    press(first, 'ArrowDown');
    expect(document.activeElement).toBe(second);
    press(second, 'ArrowUp');
    expect(document.activeElement).toBe(first);
    press(first, 'End');
    expect(document.activeElement).toBe(second);
    press(second, 'Home');
    expect(document.activeElement).toBe(first);
    press(first, 'ArrowUp');
    expect(document.activeElement).toBe(rootButton);

    const input = document.createElement('input');
    tree.append(input);
    press(input, 'ArrowDown');
    expect(document.activeElement).toBe(rootButton);
    tree.remove();
    rootButton.remove();
  });
});
