import { createPortal } from 'react-dom';
import {
  getFileTreeContextMenuItems,
  type FileTreeContextAction,
  type FileTreeContextTarget } from '../../lib/fileTreeContextMenu';
import type { Translate } from '../../lib/i18n';

import type { WorkspaceFileEntry } from '../../types';
import type { WorkspaceFileTreeNode } from '../../lib/fileTree';
import type { WorkspaceTreeTarget } from './fileSidebarPointerDragTypes';
import { isMarkdownWorkspaceReferenceKind } from '../../lib/markdownMedia';
import { findWorkspaceFileEntry } from './fileSidebarTargets';
import { ContextMenuIcon, type MenuPosition } from './fileSidebarIcon';

export interface FileTreeContextMenuState {
  target: FileTreeContextTarget;
}

// 右键上下文菜单门户：视口内定位、键盘可达（role=menu）与动作列表（图标/文案/快捷键）。
export function FileTreeContextMenuPortal(props: {
  contextMenu: FileTreeContextMenuState | null;
  contextMenuCanPaste: (target: FileTreeContextTarget) => boolean;
  contextMenuPosition: MenuPosition | null;
  contextMenuRef: React.RefObject<HTMLDivElement | null>;
  disabled: boolean;
  onInsertWorkspaceAssetAvailable: boolean;
  runContextAction: (action: FileTreeContextAction) => void;
  t: Translate;
}): React.ReactNode {
  const { contextMenu, contextMenuPosition } = props;
  if (!contextMenu || typeof document === 'undefined') return null;
  return createPortal(
    <div
      ref={props.contextMenuRef}
      className="file-tree-context-menu"
      role="menu"
      tabIndex={-1}
      style={{
        left: contextMenuPosition?.x ?? 0,
        top: contextMenuPosition?.y ?? 0,
        visibility: contextMenuPosition ? 'visible' : 'hidden',
      }}
      onContextMenu={(event) => event.preventDefault()}
    >
      {getFileTreeContextMenuItems(contextMenu.target, {
        canInsertWorkspaceAsset: props.onInsertWorkspaceAssetAvailable,
        canPaste: props.contextMenuCanPaste(contextMenu.target),
      }).map((item) => (
        <button
          key={item.action}
          type="button"
          role="menuitem"
          className={[
            'context-menu-item',
            item.danger ? 'danger' : '',
            item.separatorBefore ? 'separator-before' : '',
          ].filter(Boolean).join(' ')}
          disabled={props.disabled}
          onClick={() => props.runContextAction(item.action)}
        >
          <ContextMenuIcon action={item.action} />
          <span>{contextMenuActionLabel(item.action, props.t)}</span>
          {item.shortcut && <kbd>{item.shortcut}</kbd>}
        </button>
      ))}
    </div>,
    document.body,
  );
}

function contextMenuActionLabel(action: FileTreeContextAction, t: Translate): string {
  const labels: Record<FileTreeContextAction, () => string> = {
    'create-file': () => t('newMarkdownFile'),
    'create-folder': () => t('newFolder'),
    'open': () => t('openDocument'),
    'insert-at-cursor': () => t('insertAtCurrentCursor'),
    'refresh': () => t('refreshWorkspace'),
    'rename': () => t('rename'),
    'move': () => `${t('move')}…`,
    'delete': () => t('delete'),
    'copy': () => t('copy'),
    'cut': () => t('cut'),
    'paste': () => t('paste'),
    'reveal': () => t('revealInFileManager'),
  };
  return labels[action]();
}

export function contextActionHandlers(handles: ContextActionHandles): Partial<Record<FileTreeContextAction, (target: FileTreeContextTarget) => void>> {
  return {
    'create-file': (target) => handles.beginCreate('file', target),
    'create-folder': (target) => handles.beginCreate('folder', target),
    'open': openAction(handles),
    'insert-at-cursor': insertAtCursorAction(handles),
    'refresh': () => { handles.closeMenus(); handles.onRefreshWorkspace(); },
    'rename': guardTreeTarget(handles.beginRename),
    'move': guardTreeTarget(handles.requestMove),
    'delete': guardTreeTarget(handles.requestDelete),
    'copy': clipboardAction(handles, handles.onCopyEntry),
    'cut': clipboardAction(handles, handles.onCutEntry),
    'paste': pasteAction(handles),
    'reveal': revealAction(handles),
  };
}

export interface ContextActionHandles {
  beginCreate: (kind: 'file' | 'folder', target: FileTreeContextTarget) => void;
  beginRename: (target: WorkspaceTreeTarget) => void;
  closeMenus: () => void;
  contextMenuPasteDestination: (target: FileTreeContextTarget) => string;
  fileTreeRef: { current: WorkspaceFileTreeNode[] };
  onCopyEntry: ((target: WorkspaceTreeTarget) => void) | undefined;
  onCutEntry: ((target: WorkspaceTreeTarget) => void) | undefined;
  onInsertWorkspaceAssetRef: { current: ((asset: WorkspaceFileEntry, target: { kind: 'cursor' }) => void) | undefined };
  onOpenFile: (path: string) => void;
  onPasteEntry: ((destinationParentPath: string) => void) | undefined;
  onRefreshWorkspace: () => void;
  onRevealEntry: ((target: FileTreeContextTarget) => void) | undefined;
  requestDelete: (target: WorkspaceTreeTarget) => void;
  requestMove: (target: WorkspaceTreeTarget) => void;
}

// 打开：仅文件目标有效。
function openAction(handles: ContextActionHandles) {
  return (target: FileTreeContextTarget) => {
    if (target.kind !== 'file') return;
    handles.closeMenus();
    handles.onOpenFile(target.path);
  };
}

// 光标处插入：文件目标解析为资产且属于可引用类型时下发。
function insertAtCursorAction(handles: ContextActionHandles) {
  return (target: FileTreeContextTarget) => {
    if (target.kind !== 'file') return;
    const asset = findWorkspaceFileEntry(handles.fileTreeRef.current, target.path);
    handles.closeMenus();
    if (asset && isMarkdownWorkspaceReferenceKind(asset.kind)) {
      handles.onInsertWorkspaceAssetRef.current?.(asset, { kind: 'cursor' });
    }
  };
}

// 树内目标守卫：根目标不允许重命名/移动/删除。
function guardTreeTarget(run: (target: WorkspaceTreeTarget) => void) {
  return (target: FileTreeContextTarget) => {
    if (target.kind !== 'root') run(target);
  };
}

// 粘贴：目的地为空（无法解析父目录）时忽略。
function pasteAction(handles: ContextActionHandles) {
  return (target: FileTreeContextTarget) => {
    const destination = handles.contextMenuPasteDestination(target);
    handles.closeMenus();
    if (destination) handles.onPasteEntry?.(destination);
  };
}

// 在文件管理器中显示：收起菜单后下发。
function revealAction(handles: ContextActionHandles) {
  return (target: FileTreeContextTarget) => {
    handles.closeMenus();
    handles.onRevealEntry?.(target);
  };
}

function clipboardAction(
  handles: ContextActionHandles,
  action: ((target: WorkspaceTreeTarget) => void) | undefined,
): (target: FileTreeContextTarget) => void {
  return (target) => {
    if (target.kind === 'root') return;
    handles.closeMenus();
    action?.(target);
  };
}
