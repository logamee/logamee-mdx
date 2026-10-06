// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceFileEntry } from '../../types';
import { contextActionHandlers, type ContextActionHandles } from './fileSidebarContextMenu';

function buildHandles(overrides: Partial<ContextActionHandles> = {}): ContextActionHandles {
  return {
    beginCreate: vi.fn<(...args: unknown[]) => void>(),
    beginRename: vi.fn<(...args: unknown[]) => void>(),
    closeMenus: vi.fn<() => void>(),
    contextMenuPasteDestination: vi.fn<(target: { kind: string; path: string }) => string>(
      (target) => target.kind === 'file' ? '/ws' : target.path,
    ),
    fileTreeRef: { current: [{
      absolutePath: '/ws/pic.png',
      kind: 'file',
      name: 'pic.png',
      path: '/ws/pic.png',
      relativePath: 'pic.png',
      file: { kind: 'image', name: 'pic.png', path: '/ws/pic.png', relative_path: 'pic.png' },
    }] },
    onCopyEntry: vi.fn<(...args: unknown[]) => void>(),
    onCutEntry: vi.fn<(...args: unknown[]) => void>(),
    onInsertWorkspaceAssetRef: { current: vi.fn<(...args: unknown[]) => void>() },
    onOpenFile: vi.fn<(...args: unknown[]) => void>(),
    onPasteEntry: vi.fn<(...args: unknown[]) => void>(),
    onRefreshWorkspace: vi.fn<() => void>(),
    onRevealEntry: vi.fn<(...args: unknown[]) => void>(),
    requestDelete: vi.fn<(...args: unknown[]) => void>(),
    requestMove: vi.fn<(...args: unknown[]) => void>(),
    ...overrides,
  };
}

const fileTarget = { fileKind: 'markdown', kind: 'file', name: 'draft.md', path: '/ws/draft.md' } as const;
const folderTarget = { kind: 'folder', name: 'notes', path: '/ws/notes' } as const;
const rootTarget = { kind: 'root', name: 'ws', path: '/ws' } as const;

describe('file sidebar context action handlers', () => {
  it('creates files and folders at the chosen target', () => {
    const handles = buildHandles();
    const handlers = contextActionHandlers(handles);
    handlers['create-file']?.(folderTarget);
    handlers['create-folder']?.(folderTarget);
    expect(handles.beginCreate).toHaveBeenNthCalledWith(1, 'file', folderTarget);
    expect(handles.beginCreate).toHaveBeenNthCalledWith(2, 'folder', folderTarget);
  });

  it('opens only file targets and closes menus first', () => {
    const handles = buildHandles();
    const handlers = contextActionHandlers(handles);
    handlers['open']?.(fileTarget);
    handlers['open']?.(folderTarget);
    expect(handles.closeMenus).toHaveBeenCalledTimes(1);
    expect(handles.onOpenFile).toHaveBeenCalledWith('/ws/draft.md');
  });

  it('inserts a markdown-referencable asset at the cursor', () => {
    const handles = buildHandles();
    const handlers = contextActionHandlers(handles);
    const imageTarget = { fileKind: 'image', kind: 'file', name: 'pic.png', path: '/ws/pic.png' } as const;
    handlers['insert-at-cursor']?.(imageTarget);
    expect(handles.onInsertWorkspaceAssetRef.current).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/ws/pic.png' }),
      { kind: 'cursor' },
    );
  });

  it('skips insertion for assets that are not markdown-referencable', () => {
    const handles = buildHandles();
    handles.fileTreeRef = { current: [] };
    const handlers = contextActionHandlers(handles);
    handlers['insert-at-cursor']?.(fileTarget);
    expect(handles.onInsertWorkspaceAssetRef.current).not.toHaveBeenCalled();
  });

  it('guards rename/move/delete against the workspace root', () => {
    const handles = buildHandles();
    const handlers = contextActionHandlers(handles);
    handlers['rename']?.(rootTarget);
    handlers['move']?.(rootTarget);
    handlers['delete']?.(rootTarget);
    expect(handles.beginRename).not.toHaveBeenCalled();
    expect(handles.requestMove).not.toHaveBeenCalled();
    expect(handles.requestDelete).not.toHaveBeenCalled();
    handlers['rename']?.(folderTarget as never);
    expect(handles.beginRename).toHaveBeenCalledWith(folderTarget);
  });

  it('copies and cuts non-root targets, ignoring the root', () => {
    const handles = buildHandles();
    const handlers = contextActionHandlers(handles);
    handlers['copy']?.(rootTarget);
    expect(handles.onCopyEntry).not.toHaveBeenCalled();
    handlers['cut']?.(folderTarget as never);
    expect(handles.onCutEntry).toHaveBeenCalledWith(folderTarget);
  });

  it('pastes into the computed destination when resolvable', () => {
    const handles = buildHandles();
    const handlers = contextActionHandlers(handles);
    handlers['paste']?.(fileTarget);
    expect(handles.onPasteEntry).toHaveBeenCalledWith('/ws');
  });

  it('reveals entries and refreshes the workspace after closing menus', () => {
    const handles = buildHandles();
    const handlers = contextActionHandlers(handles);
    handlers['reveal']?.(folderTarget);
    handlers['refresh']?.(rootTarget);
    expect(handles.onRevealEntry).toHaveBeenCalledWith(folderTarget);
    expect(handles.onRefreshWorkspace).toHaveBeenCalledTimes(1);
    expect(handles.closeMenus).toHaveBeenCalled();
  });
});

describe('insertion asset resolution', () => {
  it('resolves the tree entry for the requested path', () => {
    const handles = buildHandles();
    const handlers = contextActionHandlers(handles);
    const imageTarget = { fileKind: 'image', kind: 'file', name: 'pic.png', path: '/ws/pic.png' } as const;
    handlers['insert-at-cursor']?.(imageTarget);
    const [asset] = (handles.onInsertWorkspaceAssetRef.current as ReturnType<typeof vi.fn>).mock.calls[0] as [WorkspaceFileEntry, unknown];
    expect(asset.kind).toBe('image');
  });
});
