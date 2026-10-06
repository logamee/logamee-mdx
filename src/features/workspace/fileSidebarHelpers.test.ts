// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import type { WorkspaceTreeTarget } from './fileSidebarPointerDragTypes';
import {
  draggableTreeRow,
  getMenuSize,
  mediaAssetAtPointer,
  navigateOutlineTree,
  nextSidebarView,
  pathName,
  pointerDropDestination,
} from './fileSidebarHelpers';

const originalElementFromPoint = document.elementFromPoint;

function mockElementFromPoint(hit: Element | null): void {
  Object.defineProperty(document, 'elementFromPoint', {
    configurable: true,
    value: vi.fn<() => Element | null>(() => hit),
  });
}

afterEach(() => {
  Object.defineProperty(document, 'elementFromPoint', {
    configurable: true,
    value: originalElementFromPoint,
  });
});

describe('pathName', () => {
  it('extracts the trailing segment from windows and posix paths', () => {
    expect(pathName('/workspace/notes')).toBe('notes');
    expect(pathName('D:\\work\\日志.md')).toBe('日志.md');
    expect(pathName('/workspace/folder/')).toBe('folder');
  });
});

describe('getMenuSize', () => {
  it('prefers offset dimensions and falls back to the bounding rect', () => {
    const menu = document.createElement('div');
    Object.defineProperties(menu, {
      offsetHeight: { configurable: true, value: 0 },
      offsetWidth: { configurable: true, value: 120 },
    });
    menu.getBoundingClientRect = () => ({
      bottom: 40, height: 40, left: 0, right: 80, top: 0, width: 80, x: 0, y: 0, toJSON: () => ({}),
    });
    expect(getMenuSize(menu)).toEqual({ height: 40, width: 120 });
  });
});

describe('pointerDropDestination', () => {
  it('returns the folder path when dropping onto a folder tree row', () => {
    const row = document.createElement('div');
    row.className = 'tree-row';
    row.dataset.contextMenuTarget = 'folder';
    row.dataset.treeEntryPath = '/workspace/notes';
    mockElementFromPoint(row);
    expect(pointerDropDestination(10, 10, '/workspace')).toBe('/workspace/notes');
  });

  it('rejects file rows and resolves branch children to their parent path', () => {
    const fileRow = document.createElement('div');
    fileRow.className = 'tree-row';
    fileRow.dataset.contextMenuTarget = 'file';
    mockElementFromPoint(fileRow);
    expect(pointerDropDestination(10, 10, '/workspace')).toBeNull();

    const branch = document.createElement('div');
    branch.className = 'tree-branch-children';
    branch.dataset.treeParentPath = '/workspace/notes';
    mockElementFromPoint(branch);
    expect(pointerDropDestination(10, 10, '/workspace')).toBe('/workspace/notes');
  });

  it('resolves the workspace root for root and tree background areas', () => {
    const rootArea = document.createElement('div');
    rootArea.className = 'workspace-root';
    mockElementFromPoint(rootArea);
    expect(pointerDropDestination(10, 10, '/workspace')).toBe('/workspace');

    const treeArea = document.createElement('div');
    treeArea.className = 'file-tree';
    mockElementFromPoint(treeArea);
    expect(pointerDropDestination(10, 10, '/workspace')).toBe('/workspace');
  });

  it('returns null without a hit element or elementFromPoint support', () => {
    mockElementFromPoint(null);
    expect(pointerDropDestination(10, 10, '/workspace')).toBeNull();

    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: undefined,
    });
    expect(pointerDropDestination(10, 10, '/workspace')).toBeNull();
  });
});

describe('nextSidebarView', () => {
  it('maps Home/End and arrow keys between the two sidebar views', () => {
    expect(nextSidebarView('Home', 'outline')).toBe('files');
    expect(nextSidebarView('End', 'files')).toBe('outline');
    expect(nextSidebarView('ArrowRight', 'files')).toBe('outline');
    expect(nextSidebarView('ArrowUp', 'outline')).toBe('files');
    expect(nextSidebarView('Enter', 'files')).toBeNull();
  });
});

describe('navigateOutlineTree', () => {
  function setupOutline(): HTMLDivElement {
    const tree = document.createElement('div');
    for (let index = 0; index < 3; index += 1) {
      const item = document.createElement('button');
      item.setAttribute('role', 'treeitem');
      item.textContent = `H${index}`;
      tree.append(item);
    }
    document.body.append(tree);
    return tree;
  }

  function press(tree: HTMLDivElement, key: string): void {
    tree.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key }));
  }

  it('moves focus down, up, and jumps to both ends', () => {
    const tree = setupOutline();
    const handled = vi.fn<(event: Event) => void>((event: Event) => navigateOutlineTree(
      event as unknown as ReactKeyboardEvent<HTMLDivElement>,
    ));
    tree.addEventListener('keydown', handled);
    const items = Array.from(tree.querySelectorAll('button'));

    items[0].focus();
    press(tree, 'ArrowDown');
    expect(document.activeElement).toBe(items[1]);

    press(tree, 'ArrowUp');
    expect(document.activeElement).toBe(items[0]);

    press(tree, 'End');
    expect(document.activeElement).toBe(items[2]);

    press(tree, 'Home');
    expect(document.activeElement).toBe(items[0]);

    tree.remove();
  });

  it('ignores unrelated keys and stops at the boundaries', () => {
    const tree = setupOutline();
    const items = Array.from(tree.querySelectorAll('button'));
    items[0].focus();
    press(tree, 'ArrowUp');
    expect(document.activeElement).toBe(items[0]);

    const preventDefault = vi.fn<() => void>();
    navigateOutlineTree({
      key: 'Enter',
      preventDefault,
    } as unknown as ReactKeyboardEvent<HTMLDivElement>);
    expect(preventDefault).not.toHaveBeenCalled();
    tree.remove();
  });
});

describe('draggableTreeRow and mediaAssetAtPointer guards', () => {
  it('rejects pointer events on interactive controls', () => {
    const row = document.createElement('div');
    row.className = 'tree-row';
    row.dataset.treeEntryPath = '/workspace/draft.md';
    const button = document.createElement('button');
    row.append(button);
    const event = {
      button: 0,
      isPrimary: true,
      target: button,
    } as unknown as ReactPointerEvent<HTMLElement>;
    const result = draggableTreeRow(event, false, [{
      absolutePath: '/workspace/draft.md',
      file: { kind: 'markdown', name: 'draft.md', path: '/workspace/draft.md', relative_path: 'draft.md' },
      kind: 'file',
      name: 'draft.md',
      path: '/workspace/draft.md',
      relativePath: 'draft.md',
    }]);
    expect(result).toBeNull();
  });

  it('rejects media insertion when the pointer misses the drop target', () => {
    const source = {
      kind: 'file',
      fileKind: 'image',
      name: 'pic.png',
      path: '/workspace/pic.png',
    } as unknown as WorkspaceTreeTarget;
    mockElementFromPoint(document.createElement('div'));
    expect(mediaAssetAtPointer(source, 10, 10, { canInsert: true, fileTree: [] })).toBeNull();
  });
});
