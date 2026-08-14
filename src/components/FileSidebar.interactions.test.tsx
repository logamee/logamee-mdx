// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MarkdownOutlineItem } from '../lib/markdownOutline';
import type { MarkdownMediaInsertionTarget } from '../lib/markdownMedia';
import type { WorkspaceFileEntry } from '../types';
import { FileSidebar } from './FileSidebar';

function dispatchPointerEvent(
  target: EventTarget,
  type: string,
  x: number,
  y: number,
  pointerId = 7,
) {
  const event = new MouseEvent(type, {
    bubbles: true,
    button: 0,
    cancelable: true,
    clientX: x,
    clientY: y,
  });
  Object.defineProperty(event, 'pointerId', { value: pointerId });
  target.dispatchEvent(event);
}

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    bottom: top + height,
    height,
    left,
    right: left + width,
    top,
    width,
    x: left,
    y: top,
    toJSON: () => ({}),
  };
}

describe('FileSidebar native workspace interactions', () => {
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

  it('renames a selected file inline with Return and commits with Return', () => {
    const onRenameEntry = vi.fn<(path: string, name: string, kind: 'file' | 'folder') => void>();
    act(() => root.render(
      <FileSidebar
        activePath="/workspace/draft.md"
        collapsed={false}
        collapsedFolders={new Set()}
        fileTree={[{
          absolutePath: '/workspace/draft.md',
          kind: 'file',
          name: 'draft.md',
          path: '/workspace/draft.md',
          relativePath: 'draft.md',
          file: {
            kind: 'markdown',
            name: 'draft.md',
            path: '/workspace/draft.md',
            relative_path: 'draft.md',
          },
        }]}
        onCollapseChange={vi.fn<() => void>()}
        onCreateFile={vi.fn<() => void>()}
        onCreateFolder={vi.fn<() => void>()}
        onDeleteEntry={vi.fn<() => void>()}
        onMoveEntry={vi.fn<() => void>()}
        onOpenFile={vi.fn<() => void>()}
        onRefreshWorkspace={vi.fn<() => void>()}
        onRenameEntry={onRenameEntry}
        onRequestMove={vi.fn<() => void>()}
        onToggleFolder={vi.fn<() => void>()}
        workspaceRoot="/workspace"
      />,
    ));

    const row = container.querySelector<HTMLButtonElement>('.tree-row-main');
    expect(row).not.toBeNull();
    act(() => row?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' })));

    const input = container.querySelector<HTMLInputElement>('.tree-inline-rename');
    expect(input?.value).toBe('draft.md');
    act(() => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set;
      valueSetter?.call(input, 'renamed.md');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => {
      input?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
      input?.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });

    expect(onRenameEntry).toHaveBeenCalledWith('/workspace/draft.md', 'renamed.md', 'file');
    expect(onRenameEntry).toHaveBeenCalledTimes(1);
  });

  it('exposes compact add, refresh, move, and pointer-drag tree affordances', () => {
    act(() => root.render(
      <FileSidebar
        activePath={null}
        collapsed={false}
        collapsedFolders={new Set()}
        fileTree={[{
          absolutePath: '/workspace/notes',
          kind: 'folder',
          name: 'notes',
          path: 'notes',
          children: [],
        }]}
        onCollapseChange={vi.fn<() => void>()}
        onCreateFile={vi.fn<() => void>()}
        onCreateFolder={vi.fn<() => void>()}
        onDeleteEntry={vi.fn<() => void>()}
        onMoveEntry={vi.fn<() => void>()}
        onOpenFile={vi.fn<() => void>()}
        onRefreshWorkspace={vi.fn<() => void>()}
        onRenameEntry={vi.fn<() => void>()}
        onRequestMove={vi.fn<() => void>()}
        onToggleFolder={vi.fn<() => void>()}
        workspaceRoot="/workspace"
      />,
    ));

    expect(container.querySelector('[aria-label="Add workspace item"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Refresh workspace"]')).not.toBeNull();
    expect(container.querySelector('[draggable="true"]')).toBeNull();
    expect(container.querySelector('[draggable="false"]')).not.toBeNull();
  });

  it('renders pointer context menus in the viewport layer at the pointer position', () => {
    act(() => root.render(
      <FileSidebar
        activePath="/workspace/draft.md"
        collapsed={false}
        collapsedFolders={new Set()}
        fileTree={[{
          absolutePath: '/workspace/draft.md',
          kind: 'file',
          name: 'draft.md',
          path: '/workspace/draft.md',
          relativePath: 'draft.md',
          file: {
            kind: 'markdown',
            name: 'draft.md',
            path: '/workspace/draft.md',
            relative_path: 'draft.md',
          },
        }]}
        onCollapseChange={vi.fn<() => void>()}
        onCreateFile={vi.fn<() => void>()}
        onCreateFolder={vi.fn<() => void>()}
        onDeleteEntry={vi.fn<() => void>()}
        onMoveEntry={vi.fn<() => void>()}
        onOpenFile={vi.fn<() => void>()}
        onRefreshWorkspace={vi.fn<() => void>()}
        onRenameEntry={vi.fn<() => void>()}
        onRequestMove={vi.fn<() => void>()}
        onToggleFolder={vi.fn<() => void>()}
        workspaceRoot="/workspace"
      />,
    ));

    const row = container.querySelector<HTMLElement>('[data-tree-entry-path="/workspace/draft.md"]');
    act(() => row?.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 180,
      clientY: 240,
    })));

    const menu = document.body.querySelector<HTMLElement>('.file-tree-context-menu');
    expect(menu).not.toBeNull();
    expect(menu?.parentElement).toBe(document.body);
    expect(menu?.closest('.sidebar')).toBeNull();
    expect(menu?.style.left).toBe('180px');
    expect(menu?.style.top).toBe('240px');
  });

  it('inserts a context-menu image at the current editor cursor', () => {
    const onInsertWorkspaceAsset = vi.fn<(
      asset: WorkspaceFileEntry,
      target: MarkdownMediaInsertionTarget,
    ) => void>();
    act(() => root.render(
      <FileSidebar
        activePath="/workspace/draft.md"
        collapsed={false}
        collapsedFolders={new Set()}
        fileTree={[{
          absolutePath: '/workspace/cover.png',
          kind: 'file',
          name: 'cover.png',
          path: '/workspace/cover.png',
          relativePath: 'cover.png',
          file: { kind: 'image', name: 'cover.png', path: '/workspace/cover.png', relative_path: 'cover.png' },
        }]}
        onCollapseChange={vi.fn<() => void>()}
        onCreateFile={vi.fn<() => void>()}
        onCreateFolder={vi.fn<() => void>()}
        onDeleteEntry={vi.fn<() => void>()}
        onInsertWorkspaceAsset={onInsertWorkspaceAsset}
        onMoveEntry={vi.fn<() => void>()}
        onOpenFile={vi.fn<() => void>()}
        onRefreshWorkspace={vi.fn<() => void>()}
        onRenameEntry={vi.fn<() => void>()}
        onRequestMove={vi.fn<() => void>()}
        onToggleFolder={vi.fn<() => void>()}
        workspaceRoot="/workspace"
      />,
    ));

    const row = container.querySelector<HTMLElement>('[data-tree-entry-path="/workspace/cover.png"]');
    act(() => row?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
    const insertItem = Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
      .find((button) => button.textContent?.includes('Insert at Current Cursor'));
    expect(insertItem).not.toBeUndefined();
    act(() => insertItem?.click());

    expect(onInsertWorkspaceAsset).toHaveBeenCalledWith({
      kind: 'image',
      name: 'cover.png',
      path: '/workspace/cover.png',
      relative_path: 'cover.png',
    }, { kind: 'cursor' });
  });

  it.each([
    ['html', 'demo.html'],
    ['excalidraw', 'diagram.excalidraw'],
  ] as const)('inserts a context-menu %s file at the current editor cursor', (fileKind, name) => {
    const onInsertWorkspaceAsset = vi.fn<(
      asset: WorkspaceFileEntry,
      target: MarkdownMediaInsertionTarget,
    ) => void>();
    const path = `/workspace/${name}`;
    act(() => root.render(
      <FileSidebar
        activePath="/workspace/draft.md"
        collapsed={false}
        collapsedFolders={new Set()}
        fileTree={[{
          absolutePath: path,
          kind: 'file',
          name,
          path,
          relativePath: name,
          file: { kind: fileKind, name, path, relative_path: name },
        }]}
        onCollapseChange={vi.fn<() => void>()}
        onCreateFile={vi.fn<() => void>()}
        onCreateFolder={vi.fn<() => void>()}
        onDeleteEntry={vi.fn<() => void>()}
        onInsertWorkspaceAsset={onInsertWorkspaceAsset}
        onMoveEntry={vi.fn<() => void>()}
        onOpenFile={vi.fn<() => void>()}
        onRefreshWorkspace={vi.fn<() => void>()}
        onRenameEntry={vi.fn<() => void>()}
        onRequestMove={vi.fn<() => void>()}
        onToggleFolder={vi.fn<() => void>()}
        workspaceRoot="/workspace"
      />,
    ));

    const row = container.querySelector<HTMLElement>(`[data-tree-entry-path="${path}"]`);
    act(() => row?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
    const insertItem = Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
      .find((button) => button.textContent?.includes('Insert at Current Cursor'));
    expect(insertItem).not.toBeUndefined();
    act(() => insertItem?.click());

    expect(onInsertWorkspaceAsset).toHaveBeenCalledWith({
      kind: fileKind,
      name,
      path,
      relative_path: name,
    }, { kind: 'cursor' });
  });

  it('insets the add menu from the sidebar divider and leaves a trigger gap', () => {
    const getBoundingClientRect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function mockRect(this: HTMLElement) {
        if (this.classList.contains('sidebar')) return rect(0, 48, 264, 672);
        if (this.getAttribute('aria-label') === 'Add workspace item') return rect(168, 56, 28, 28);
        if (this.classList.contains('sidebar-add-menu')) return rect(0, 0, 204, 112);
        return rect(0, 0, 0, 0);
      });

    try {
      act(() => root.render(
        <FileSidebar
          activePath={null}
          collapsed={false}
          collapsedFolders={new Set()}
          fileTree={[]}
          onCollapseChange={vi.fn<() => void>()}
          onCreateFile={vi.fn<() => void>()}
          onCreateFolder={vi.fn<() => void>()}
          onDeleteEntry={vi.fn<() => void>()}
          onMoveEntry={vi.fn<() => void>()}
          onOpenFile={vi.fn<() => void>()}
          onRefreshWorkspace={vi.fn<() => void>()}
          onRenameEntry={vi.fn<() => void>()}
          onRequestMove={vi.fn<() => void>()}
          onToggleFolder={vi.fn<() => void>()}
          workspaceRoot="/workspace"
        />,
      ));

      act(() => container.querySelector<HTMLButtonElement>('[aria-label="Add workspace item"]')?.click());

      const menu = document.body.querySelector<HTMLElement>('.sidebar-add-menu');
      expect(menu?.style.left).toBe('52px');
      expect(menu?.style.top).toBe('88px');
    } finally {
      getBoundingClientRect.mockRestore();
    }
  });

  it('creates an Excalidraw scene from the workspace add menu', () => {
    const onCreateFile = vi.fn<(
      parentPath: string,
      parentName: string,
      kind: 'markdown' | 'excalidraw',
    ) => void>();
    act(() => root.render(
      <FileSidebar
        activePath={null}
        collapsed={false}
        collapsedFolders={new Set()}
        fileTree={[]}
        onCollapseChange={vi.fn<() => void>()}
        onCreateFile={onCreateFile}
        onCreateFolder={vi.fn<() => void>()}
        onDeleteEntry={vi.fn<() => void>()}
        onMoveEntry={vi.fn<() => void>()}
        onOpenFile={vi.fn<() => void>()}
        onRefreshWorkspace={vi.fn<() => void>()}
        onRenameEntry={vi.fn<() => void>()}
        onRequestMove={vi.fn<() => void>()}
        onToggleFolder={vi.fn<() => void>()}
        workspaceRoot="/workspace"
      />,
    ));

    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Add workspace item"]')?.click());
    const createDrawing = Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
      .find((button) => button.textContent?.includes('New Excalidraw File'));
    act(() => createDrawing?.click());

    expect(onCreateFile).toHaveBeenCalledWith('/workspace', 'workspace', 'excalidraw');
  });

  it.each([
    ['image', 'cover.png', 'assets/cover.png'],
    ['audio', 'intro.mp3', 'audio/intro.mp3'],
  ] as const)('sends a workspace %s dropped on the Markdown editor to the insert callback', (fileKind, name, relativePath) => {
    const onInsertWorkspaceAsset = vi.fn<(
      asset: WorkspaceFileEntry,
      target: MarkdownMediaInsertionTarget,
    ) => void>();
    const onMoveEntry = vi.fn<(path: string, destinationParentPath: string) => void>();
    const path = `/workspace/${relativePath}`;
    const dropTarget = document.createElement('div');
    dropTarget.dataset.markdownMediaDropTarget = 'true';
    document.body.append(dropTarget);
    act(() => root.render(
      <FileSidebar
        activePath="/workspace/draft.md"
        collapsed={false}
        collapsedFolders={new Set()}
        fileTree={[{
          absolutePath: path,
          kind: 'file',
          name,
          path,
          relativePath,
          file: {
            kind: fileKind,
            name,
            path,
            relative_path: relativePath,
          },
        }]}
        onCollapseChange={vi.fn<() => void>()}
        onCreateFile={vi.fn<() => void>()}
        onCreateFolder={vi.fn<() => void>()}
        onDeleteEntry={vi.fn<() => void>()}
        onInsertWorkspaceAsset={onInsertWorkspaceAsset}
        onMoveEntry={onMoveEntry}
        onOpenFile={vi.fn<() => void>()}
        onRefreshWorkspace={vi.fn<() => void>()}
        onRenameEntry={vi.fn<() => void>()}
        onRequestMove={vi.fn<() => void>()}
        onToggleFolder={vi.fn<() => void>()}
        workspaceRoot="/workspace"
      />,
    ));

    const source = container.querySelector<HTMLElement>(`[data-tree-entry-path="${path}"]`);
    const originalElementFromPoint = document.elementFromPoint;
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn<() => Element | null>(() => dropTarget),
    });
    try {
      act(() => dispatchPointerEvent(source!, 'pointerdown', 20, 80));
      act(() => dispatchPointerEvent(window, 'pointermove', 80, 20));
      act(() => dispatchPointerEvent(window, 'pointerup', 80, 20));
    } finally {
      Object.defineProperty(document, 'elementFromPoint', {
        configurable: true,
        value: originalElementFromPoint,
      });
      dropTarget.remove();
    }

    expect(onInsertWorkspaceAsset).toHaveBeenCalledWith({
      kind: fileKind,
      name,
      path,
      relative_path: relativePath,
    }, { kind: 'coordinates', clientX: 80, clientY: 20 });
    expect(onMoveEntry).not.toHaveBeenCalled();
  });

  it.each([
    ['html', 'demo.html'],
    ['excalidraw', 'diagram.excalidraw'],
  ] as const)('does not treat a dragged %s file as Markdown media', (fileKind, name) => {
    const onInsertWorkspaceAsset = vi.fn<(
      asset: WorkspaceFileEntry,
      target: MarkdownMediaInsertionTarget,
    ) => void>();
    const onMoveEntry = vi.fn<(path: string, destinationParentPath: string) => void>();
    const path = `/workspace/${name}`;
    const dropTarget = document.createElement('div');
    dropTarget.dataset.markdownMediaDropTarget = 'true';
    document.body.append(dropTarget);
    act(() => root.render(
      <FileSidebar
        activePath="/workspace/draft.md"
        collapsed={false}
        collapsedFolders={new Set()}
        fileTree={[{
          absolutePath: path,
          kind: 'file',
          name,
          path,
          relativePath: name,
          file: { kind: fileKind, name, path, relative_path: name },
        }]}
        onCollapseChange={vi.fn<() => void>()}
        onCreateFile={vi.fn<() => void>()}
        onCreateFolder={vi.fn<() => void>()}
        onDeleteEntry={vi.fn<() => void>()}
        onInsertWorkspaceAsset={onInsertWorkspaceAsset}
        onMoveEntry={onMoveEntry}
        onOpenFile={vi.fn<() => void>()}
        onRefreshWorkspace={vi.fn<() => void>()}
        onRenameEntry={vi.fn<() => void>()}
        onRequestMove={vi.fn<() => void>()}
        onToggleFolder={vi.fn<() => void>()}
        workspaceRoot="/workspace"
      />,
    ));

    const source = container.querySelector<HTMLElement>(`[data-tree-entry-path="${path}"]`);
    const originalElementFromPoint = document.elementFromPoint;
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn<() => Element | null>(() => dropTarget),
    });
    try {
      act(() => dispatchPointerEvent(source!, 'pointerdown', 20, 80));
      act(() => dispatchPointerEvent(window, 'pointermove', 80, 20));
      act(() => dispatchPointerEvent(window, 'pointerup', 80, 20));
    } finally {
      Object.defineProperty(document, 'elementFromPoint', {
        configurable: true,
        value: originalElementFromPoint,
      });
      dropTarget.remove();
    }

    expect(onInsertWorkspaceAsset).not.toHaveBeenCalled();
  });

  it('switches to a hierarchical document outline and selects its heading', () => {
    const onSelectOutlineItem = vi.fn<(item: MarkdownOutlineItem) => void>();
    const outlineItems: MarkdownOutlineItem[] = [
      {
        depth: 0,
        id: 'heading-0',
        level: 1,
        line: 1,
        offset: 0,
        ordinal: 0,
        text: 'Project',
      },
      {
        depth: 1,
        id: 'heading-11',
        level: 2,
        line: 3,
        offset: 11,
        ordinal: 1,
        text: 'Install',
      },
    ];

    act(() => root.render(
      <FileSidebar
        activePath="/workspace/draft.md"
        collapsed={false}
        collapsedFolders={new Set()}
        fileTree={[{
          absolutePath: '/workspace/draft.md',
          kind: 'file',
          name: 'draft.md',
          path: '/workspace/draft.md',
          relativePath: 'draft.md',
          file: {
            kind: 'markdown',
            name: 'draft.md',
            path: '/workspace/draft.md',
            relative_path: 'draft.md',
          },
        }]}
        onCollapseChange={vi.fn<() => void>()}
        onCreateFile={vi.fn<() => void>()}
        onCreateFolder={vi.fn<() => void>()}
        onDeleteEntry={vi.fn<() => void>()}
        onMoveEntry={vi.fn<() => void>()}
        onOpenFile={vi.fn<() => void>()}
        onRefreshWorkspace={vi.fn<() => void>()}
        onRenameEntry={vi.fn<() => void>()}
        onRequestMove={vi.fn<() => void>()}
        onSelectOutlineItem={onSelectOutlineItem}
        onToggleFolder={vi.fn<() => void>()}
        outlineItems={outlineItems}
        workspaceRoot="/workspace"
      />,
    ));

    const filesTab = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
      .find((tab) => tab.textContent === 'Files');
    const outlineTab = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
      .find((tab) => tab.textContent === 'Outline');
    expect(filesTab?.tabIndex).toBe(0);
    expect(outlineTab?.tabIndex).toBe(-1);
    expect(outlineTab?.getAttribute('aria-selected')).toBe('false');
    expect(container.querySelector('[aria-label="Workspace file tree"]')).not.toBeNull();

    act(() => filesTab?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowRight' })));

    expect(outlineTab?.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(outlineTab);
    expect(container.querySelector('#workspace-files-panel')?.hasAttribute('hidden')).toBe(true);
    const outlineTree = container.querySelector('[role="tree"][aria-label="Document outline"]');
    expect(outlineTree).not.toBeNull();
    expect(outlineTree?.querySelector('[role="treeitem"][aria-level="1"]')?.textContent)
      .toContain('Project');
    const installButton = Array.from(outlineTree?.querySelectorAll<HTMLButtonElement>('[role="treeitem"]') ?? [])
      .find((item) => item.textContent?.includes('Install'));
    expect(installButton?.getAttribute('aria-level')).toBe('2');

    act(() => installButton?.click());

    expect(onSelectOutlineItem).toHaveBeenCalledWith(outlineItems[1]);
  });

  it('moves a file with pointer events when the webview never delivers HTML drag events', () => {
    const onMoveEntry = vi.fn<(path: string, destinationParentPath: string) => void>();
    act(() => root.render(
      <FileSidebar
        activePath="/workspace/draft.md"
        collapsed={false}
        collapsedFolders={new Set()}
        fileTree={[
          {
            absolutePath: '/workspace/Archive',
            kind: 'folder',
            name: 'Archive',
            path: 'Archive',
            children: [],
          },
          {
            absolutePath: '/workspace/draft.md',
            kind: 'file',
            name: 'draft.md',
            path: '/workspace/draft.md',
            relativePath: 'draft.md',
            file: {
              kind: 'markdown',
              name: 'draft.md',
              path: '/workspace/draft.md',
              relative_path: 'draft.md',
            },
          },
        ]}
        onCollapseChange={vi.fn<() => void>()}
        onCreateFile={vi.fn<() => void>()}
        onCreateFolder={vi.fn<() => void>()}
        onDeleteEntry={vi.fn<() => void>()}
        onMoveEntry={onMoveEntry}
        onOpenFile={vi.fn<() => void>()}
        onRefreshWorkspace={vi.fn<() => void>()}
        onRenameEntry={vi.fn<() => void>()}
        onRequestMove={vi.fn<() => void>()}
        onToggleFolder={vi.fn<() => void>()}
        workspaceRoot="/workspace"
      />,
    ));

    const source = container.querySelector<HTMLElement>('[data-tree-entry-path="/workspace/draft.md"]');
    const destination = container.querySelector<HTMLElement>('[data-tree-entry-path="/workspace/Archive"]');
    const originalElementFromPoint = document.elementFromPoint;
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn<() => Element | null>(() => destination),
    });
    try {
      act(() => dispatchPointerEvent(source!, 'pointerdown', 20, 80));
      act(() => dispatchPointerEvent(window, 'pointermove', 80, 20));
      expect(destination?.classList.contains('drop-target')).toBe(true);
      act(() => dispatchPointerEvent(window, 'pointerup', 80, 20));
    } finally {
      Object.defineProperty(document, 'elementFromPoint', {
        configurable: true,
        value: originalElementFromPoint,
      });
    }

    expect(onMoveEntry).toHaveBeenCalledWith('/workspace/draft.md', '/workspace/Archive');
  });

  it('keeps the pointer drag active when a parent render replaces the move callback', () => {
    const firstMoveEntry = vi.fn<(path: string, destinationParentPath: string) => void>();
    const latestMoveEntry = vi.fn<(path: string, destinationParentPath: string) => void>();
    const renderSidebar = (onMoveEntry: (path: string, destinationParentPath: string) => void) => (
      <FileSidebar
        activePath="/workspace/draft.md"
        collapsed={false}
        collapsedFolders={new Set()}
        fileTree={[
          { absolutePath: '/workspace/Archive', kind: 'folder', name: 'Archive', path: 'Archive', children: [] },
          {
            absolutePath: '/workspace/draft.md',
            kind: 'file',
            name: 'draft.md',
            path: '/workspace/draft.md',
            relativePath: 'draft.md',
            file: { kind: 'markdown', name: 'draft.md', path: '/workspace/draft.md', relative_path: 'draft.md' },
          },
        ]}
        onCollapseChange={vi.fn<() => void>()}
        onCreateFile={vi.fn<() => void>()}
        onCreateFolder={vi.fn<() => void>()}
        onDeleteEntry={vi.fn<() => void>()}
        onMoveEntry={onMoveEntry}
        onOpenFile={vi.fn<() => void>()}
        onRefreshWorkspace={vi.fn<() => void>()}
        onRenameEntry={vi.fn<() => void>()}
        onRequestMove={vi.fn<() => void>()}
        onToggleFolder={vi.fn<() => void>()}
        workspaceRoot="/workspace"
      />
    );
    act(() => root.render(renderSidebar(firstMoveEntry)));

    const source = container.querySelector<HTMLElement>('[data-tree-entry-path="/workspace/draft.md"]');
    const destination = container.querySelector<HTMLElement>('[data-tree-entry-path="/workspace/Archive"]');
    const originalElementFromPoint = document.elementFromPoint;
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn<() => Element | null>(() => destination),
    });
    try {
      act(() => dispatchPointerEvent(source!, 'pointerdown', 20, 80, 9));
      act(() => dispatchPointerEvent(window, 'pointermove', 80, 20, 9));
      act(() => root.render(renderSidebar(latestMoveEntry)));
      expect(container.querySelector('[data-tree-entry-path="/workspace/draft.md"]')?.classList.contains('dragging')).toBe(true);
      expect(container.querySelector('[data-tree-entry-path="/workspace/Archive"]')?.classList.contains('drop-target')).toBe(true);
      act(() => dispatchPointerEvent(window, 'pointerup', 80, 20, 9));
    } finally {
      Object.defineProperty(document, 'elementFromPoint', {
        configurable: true,
        value: originalElementFromPoint,
      });
    }

    expect(firstMoveEntry).not.toHaveBeenCalled();
    expect(latestMoveEntry).toHaveBeenCalledWith('/workspace/draft.md', '/workspace/Archive');
  });

  it('uses an expanded folder as the destination when released in its child-list gap', () => {
    const onMoveEntry = vi.fn<(path: string, destinationParentPath: string) => void>();
    act(() => root.render(
      <FileSidebar
        activePath="/workspace/draft.md"
        collapsed={false}
        collapsedFolders={new Set()}
        fileTree={[
          {
            absolutePath: '/workspace/Archive',
            kind: 'folder',
            name: 'Archive',
            path: 'Archive',
            children: [{
              absolutePath: '/workspace/Archive/inside.md',
              kind: 'file',
              name: 'inside.md',
              path: '/workspace/Archive/inside.md',
              relativePath: 'Archive/inside.md',
              file: {
                kind: 'markdown',
                name: 'inside.md',
                path: '/workspace/Archive/inside.md',
                relative_path: 'Archive/inside.md',
              },
            }],
          },
          {
            absolutePath: '/workspace/draft.md',
            kind: 'file',
            name: 'draft.md',
            path: '/workspace/draft.md',
            relativePath: 'draft.md',
            file: { kind: 'markdown', name: 'draft.md', path: '/workspace/draft.md', relative_path: 'draft.md' },
          },
        ]}
        onCollapseChange={vi.fn<() => void>()}
        onCreateFile={vi.fn<() => void>()}
        onCreateFolder={vi.fn<() => void>()}
        onDeleteEntry={vi.fn<() => void>()}
        onMoveEntry={onMoveEntry}
        onOpenFile={vi.fn<() => void>()}
        onRefreshWorkspace={vi.fn<() => void>()}
        onRenameEntry={vi.fn<() => void>()}
        onRequestMove={vi.fn<() => void>()}
        onToggleFolder={vi.fn<() => void>()}
        workspaceRoot="/workspace"
      />,
    ));

    const source = container.querySelector<HTMLElement>('[data-tree-entry-path="/workspace/draft.md"]');
    const childListGap = container.querySelector<HTMLElement>('.tree-branch-children');
    const originalElementFromPoint = document.elementFromPoint;
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn<() => Element | null>(() => childListGap),
    });

    try {
      act(() => dispatchPointerEvent(source!, 'pointerdown', 20, 100, 10));
      act(() => dispatchPointerEvent(window, 'pointermove', 60, 55, 10));
      expect(container.querySelector('[data-tree-entry-path="/workspace/Archive"]')?.classList.contains('drop-target')).toBe(true);
      act(() => dispatchPointerEvent(window, 'pointerup', 60, 55, 10));
    } finally {
      Object.defineProperty(document, 'elementFromPoint', {
        configurable: true,
        value: originalElementFromPoint,
      });
    }

    expect(onMoveEntry).toHaveBeenCalledWith('/workspace/draft.md', '/workspace/Archive');
  });

  it('moves a nested file to the workspace root without opening it after the drag', () => {
    const onMoveEntry = vi.fn<(path: string, destinationParentPath: string) => void>();
    const onOpenFile = vi.fn<(path: string) => void>();
    vi.useFakeTimers();
    act(() => root.render(
      <FileSidebar
        activePath="/workspace/Archive/draft.md"
        collapsed={false}
        collapsedFolders={new Set()}
        fileTree={[{
          absolutePath: '/workspace/Archive',
          kind: 'folder',
          name: 'Archive',
          path: 'Archive',
          children: [{
            absolutePath: '/workspace/Archive/draft.md',
            kind: 'file',
            name: 'draft.md',
            path: '/workspace/Archive/draft.md',
            relativePath: 'Archive/draft.md',
            file: {
              kind: 'markdown',
              name: 'draft.md',
              path: '/workspace/Archive/draft.md',
              relative_path: 'Archive/draft.md',
            },
          }],
        }]}
        onCollapseChange={vi.fn<() => void>()}
        onCreateFile={vi.fn<() => void>()}
        onCreateFolder={vi.fn<() => void>()}
        onDeleteEntry={vi.fn<() => void>()}
        onMoveEntry={onMoveEntry}
        onOpenFile={onOpenFile}
        onRefreshWorkspace={vi.fn<() => void>()}
        onRenameEntry={vi.fn<() => void>()}
        onRequestMove={vi.fn<() => void>()}
        onToggleFolder={vi.fn<() => void>()}
        workspaceRoot="/workspace"
      />,
    ));

    const source = container.querySelector<HTMLElement>('[data-tree-entry-path="/workspace/Archive/draft.md"]');
    const sourceLabel = source?.querySelector<HTMLElement>('.tree-label');
    const destination = container.querySelector<HTMLElement>('.workspace-root');
    const suppressedClick = new MouseEvent('click', { bubbles: true, cancelable: true });
    const originalElementFromPoint = document.elementFromPoint;
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn<() => Element | null>(() => destination),
    });

    try {
      act(() => dispatchPointerEvent(source!, 'pointerdown', 40, 80, 12));
      act(() => dispatchPointerEvent(window, 'pointermove', 40, 20, 12));
      expect(destination?.classList.contains('drop-target')).toBe(true);
      act(() => {
        dispatchPointerEvent(window, 'pointerup', 40, 20, 12);
        sourceLabel?.dispatchEvent(suppressedClick);
      });
      act(() => vi.runAllTimers());
      act(() => sourceLabel?.click());
    } finally {
      Object.defineProperty(document, 'elementFromPoint', {
        configurable: true,
        value: originalElementFromPoint,
      });
      vi.useRealTimers();
    }

    expect(onMoveEntry).toHaveBeenCalledWith('/workspace/Archive/draft.md', '/workspace');
    expect(suppressedClick.defaultPrevented).toBe(true);
    expect(onOpenFile).toHaveBeenCalledTimes(1);
    expect(onOpenFile).toHaveBeenCalledWith('/workspace/Archive/draft.md');
  });

  it.each(['blur', 'lostpointercapture'])('cancels an active pointer drag on %s', (cancelEvent) => {
    const onMoveEntry = vi.fn<(path: string, destinationParentPath: string) => void>();
    const onOpenFile = vi.fn<(path: string) => void>();
    act(() => root.render(
      <FileSidebar
        activePath="/workspace/draft.md"
        collapsed={false}
        collapsedFolders={new Set()}
        fileTree={[
          { absolutePath: '/workspace/Archive', kind: 'folder', name: 'Archive', path: 'Archive', children: [] },
          {
            absolutePath: '/workspace/draft.md',
            kind: 'file',
            name: 'draft.md',
            path: '/workspace/draft.md',
            relativePath: 'draft.md',
            file: { kind: 'markdown', name: 'draft.md', path: '/workspace/draft.md', relative_path: 'draft.md' },
          },
        ]}
        onCollapseChange={vi.fn<() => void>()}
        onCreateFile={vi.fn<() => void>()}
        onCreateFolder={vi.fn<() => void>()}
        onDeleteEntry={vi.fn<() => void>()}
        onMoveEntry={onMoveEntry}
        onOpenFile={onOpenFile}
        onRefreshWorkspace={vi.fn<() => void>()}
        onRenameEntry={vi.fn<() => void>()}
        onRequestMove={vi.fn<() => void>()}
        onToggleFolder={vi.fn<() => void>()}
        workspaceRoot="/workspace"
      />,
    ));

    const source = container.querySelector<HTMLElement>('[data-tree-entry-path="/workspace/draft.md"]');
    const sourceLabel = source?.querySelector<HTMLElement>('.tree-label');
    const destination = container.querySelector<HTMLElement>('[data-tree-entry-path="/workspace/Archive"]');
    const suppressedClick = new MouseEvent('click', { bubbles: true, cancelable: true });
    const originalElementFromPoint = document.elementFromPoint;
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn<() => Element | null>(() => destination),
    });

    try {
      act(() => dispatchPointerEvent(source!, 'pointerdown', 20, 80, 11));
      act(() => dispatchPointerEvent(window, 'pointermove', 80, 20, 11));
      expect(source?.classList.contains('dragging')).toBe(true);
      expect(destination?.classList.contains('drop-target')).toBe(true);
      act(() => {
        if (cancelEvent === 'blur') window.dispatchEvent(new Event('blur'));
        else dispatchPointerEvent(source!, cancelEvent, 80, 20, 11);
      });
      expect(source?.classList.contains('dragging')).toBe(false);
      expect(destination?.classList.contains('drop-target')).toBe(false);
      act(() => sourceLabel?.dispatchEvent(suppressedClick));
      act(() => dispatchPointerEvent(window, 'pointerup', 80, 20, 11));
    } finally {
      Object.defineProperty(document, 'elementFromPoint', {
        configurable: true,
        value: originalElementFromPoint,
      });
    }

    expect(suppressedClick.defaultPrevented).toBe(true);
    expect(onOpenFile).not.toHaveBeenCalled();
    expect(onMoveEntry).not.toHaveBeenCalled();
  });

  it('moves the roving tree selection with ArrowDown and ArrowUp', () => {
    act(() => root.render(
      <FileSidebar
        activePath="/workspace/first.md"
        collapsed={false}
        collapsedFolders={new Set()}
        fileTree={[
          {
            absolutePath: '/workspace/first.md',
            kind: 'file',
            name: 'first.md',
            path: '/workspace/first.md',
            relativePath: 'first.md',
            file: { kind: 'markdown', name: 'first.md', path: '/workspace/first.md', relative_path: 'first.md' },
          },
          {
            absolutePath: '/workspace/second.md',
            kind: 'file',
            name: 'second.md',
            path: '/workspace/second.md',
            relativePath: 'second.md',
            file: { kind: 'markdown', name: 'second.md', path: '/workspace/second.md', relative_path: 'second.md' },
          },
        ]}
        onCollapseChange={vi.fn<() => void>()}
        onCreateFile={vi.fn<() => void>()}
        onCreateFolder={vi.fn<() => void>()}
        onDeleteEntry={vi.fn<() => void>()}
        onMoveEntry={vi.fn<() => void>()}
        onOpenFile={vi.fn<() => void>()}
        onRefreshWorkspace={vi.fn<() => void>()}
        onRenameEntry={vi.fn<() => void>()}
        onRequestMove={vi.fn<() => void>()}
        onToggleFolder={vi.fn<() => void>()}
        workspaceRoot="/workspace"
      />,
    ));

    const rows = container.querySelectorAll<HTMLElement>('[role="treeitem"]');
    act(() => {
      rows[0]?.focus();
      rows[0]?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowDown' }));
    });
    expect(document.activeElement).toBe(rows[1]);
    expect(rows[1]?.getAttribute('aria-selected')).toBe('true');

    act(() => rows[1]?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowUp' })));
    expect(document.activeElement).toBe(rows[0]);
    expect(rows[0]?.getAttribute('aria-selected')).toBe('true');
  });

  it('offers rename, move, and Move to Trash from the selected-entry action menu', () => {
    act(() => root.render(
      <FileSidebar
        activePath="/workspace/draft.md"
        collapsed={false}
        collapsedFolders={new Set()}
        fileTree={[{
          absolutePath: '/workspace/draft.md',
          kind: 'file',
          name: 'draft.md',
          path: '/workspace/draft.md',
          relativePath: 'draft.md',
          file: { kind: 'markdown', name: 'draft.md', path: '/workspace/draft.md', relative_path: 'draft.md' },
        }]}
        onCollapseChange={vi.fn<() => void>()}
        onCreateFile={vi.fn<() => void>()}
        onCreateFolder={vi.fn<() => void>()}
        onDeleteEntry={vi.fn<() => void>()}
        onMoveEntry={vi.fn<() => void>()}
        onOpenFile={vi.fn<() => void>()}
        onRefreshWorkspace={vi.fn<() => void>()}
        onRenameEntry={vi.fn<() => void>()}
        onRequestMove={vi.fn<() => void>()}
        onToggleFolder={vi.fn<() => void>()}
        workspaceRoot="/workspace"
      />,
    ));

    const moreButton = container.querySelector<HTMLButtonElement>('[aria-label="More actions for draft.md"]');
    expect(moreButton).not.toBeNull();
    act(() => moreButton?.click());

    const menuText = document.body.querySelector('[role="menu"]')?.textContent;
    expect(menuText).toContain('Rename');
    expect(menuText).toContain('Move…');
    expect(menuText).toContain('Move to Trash');
    expect(menuText).not.toContain('Delete');
  });

  it('disables workspace mutation controls and dragging while an operation is busy', () => {
    act(() => root.render(
      <FileSidebar
        activePath="/workspace/draft.md"
        collapsed={false}
        collapsedFolders={new Set()}
        disabled
        fileTree={[{
          absolutePath: '/workspace/draft.md',
          kind: 'file',
          name: 'draft.md',
          path: '/workspace/draft.md',
          relativePath: 'draft.md',
          file: { kind: 'markdown', name: 'draft.md', path: '/workspace/draft.md', relative_path: 'draft.md' },
        }]}
        onCollapseChange={vi.fn<() => void>()}
        onCreateFile={vi.fn<() => void>()}
        onCreateFolder={vi.fn<() => void>()}
        onDeleteEntry={vi.fn<() => void>()}
        onMoveEntry={vi.fn<() => void>()}
        onOpenFile={vi.fn<() => void>()}
        onRefreshWorkspace={vi.fn<() => void>()}
        onRenameEntry={vi.fn<() => void>()}
        onRequestMove={vi.fn<() => void>()}
        onToggleFolder={vi.fn<() => void>()}
        workspaceRoot="/workspace"
      />,
    ));

    expect(container.querySelector<HTMLButtonElement>('[aria-label="Add workspace item"]')?.disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('[aria-label="Refresh workspace"]')?.disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('[aria-label="More actions for draft.md"]')?.disabled).toBe(true);
    expect(container.querySelector<HTMLElement>('[role="treeitem"]')?.getAttribute('draggable')).toBe('false');
    expect(container.querySelector<HTMLElement>('[role="treeitem"]')?.getAttribute('aria-disabled')).toBe('true');
  });
});
