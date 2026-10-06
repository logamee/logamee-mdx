import { FolderOpen, ListTree } from 'lucide-react';
import { useI18n, type Translate } from '../../lib/i18n';
import type { FileSidebarController } from './fileSidebarController';
import { FileSidebarHeading } from './fileSidebarChromeView';
import { FileTreeContextMenuPortal } from './fileSidebarContextMenu';
import { FileTreeRows } from './FileTreeRows';

interface SidebarSectionProps {
  ctrl: FileSidebarController;
}

// 文件/大纲选项卡：roving tabIndex + Home/End/方向键往返切换。
function FileSidebarTabs({ ctrl }: SidebarSectionProps) {
  const { t } = useI18n();
  const { handleSidebarTabNavigation, selectSidebarView, sidebarTabRefs, sidebarView } = ctrl.views;
  return (
    <div className="sidebar-tabs" role="tablist" aria-label={t('workspaceViews')}>
      <button
        ref={(element) => { sidebarTabRefs.current.files = element; }}
        id="workspace-files-tab"
        type="button"
        role="tab"
        className={sidebarView === 'files' ? 'sidebar-tab is-active' : 'sidebar-tab'}
        aria-controls="workspace-files-panel"
        aria-selected={sidebarView === 'files'}
        tabIndex={sidebarView === 'files' ? 0 : -1}
        onClick={() => selectSidebarView('files')}
        onKeyDown={(event) => handleSidebarTabNavigation(event, 'files')}
      >
        <FolderOpen size={14} />
        <span>{t('files')}</span>
      </button>
      <button
        ref={(element) => { sidebarTabRefs.current.outline = element; }}
        id="document-outline-tab"
        type="button"
        role="tab"
        className={sidebarView === 'outline' ? 'sidebar-tab is-active' : 'sidebar-tab'}
        aria-controls="document-outline-panel"
        aria-selected={sidebarView === 'outline'}
        tabIndex={sidebarView === 'outline' ? 0 : -1}
        onClick={() => selectSidebarView('outline')}
        onKeyDown={(event) => handleSidebarTabNavigation(event, 'outline')}
      >
        <ListTree size={14} />
        <span>{t('outline')}</span>
      </button>
    </div>
  );
}

// 工作区根按钮：始终定位到根，支持右键/键盘菜单与 ArrowDown 进入树。
function FileSidebarRootButton({ ctrl }: SidebarSectionProps) {
  const { rootButtonRef, rootTarget, selectedTarget, setSelectedTarget } = ctrl.selection;
  const { dropTargetPath } = ctrl.drag;
  const { openRootContextMenu, openRootContextMenuFromKeyboard } = ctrl.menus;
  const { focusTreeRow } = ctrl.tree;
  if (!rootTarget) return null;
  return (
    <button
      ref={rootButtonRef}
      type="button"
      className={[
        'workspace-root',
        selectedTarget?.kind === 'root' ? 'selected' : '',
        dropTargetPath === rootTarget.path ? 'drop-target' : '',
      ].filter(Boolean).join(' ')}
      data-context-menu-target="workspace-root"
      title={ctrl.props.workspaceRoot ?? undefined}
      aria-haspopup="menu"
      onClick={() => setSelectedTarget(rootTarget)}
      onContextMenu={openRootContextMenu}
      onFocus={() => setSelectedTarget(rootTarget)}
      onKeyDown={(event) => {
        openRootContextMenuFromKeyboard(event);
        if (!event.defaultPrevented && event.key === 'ArrowDown') {
          event.preventDefault();
          focusTreeRow('first');
        }
      }}
    >
      <FolderOpen size={15} />
      <span>{rootTarget.name}</span>
    </button>
  );
}

function FileSidebarEmptyTree(props: {
  disabled: boolean;
  hasRoot: boolean;
  onOpenDirectory?: () => void;
  t: Translate;
}) {
  const label = props.hasRoot ? props.t('folderEmpty') : props.t('noFolderOpen');
  if (!props.onOpenDirectory) {
    return (
      <div className="empty-sidebar">
        <FolderOpen size={20} />
        <span>{label}</span>
      </div>
    );
  }
  return (
    <button
      type="button"
      className="empty-sidebar"
      disabled={props.disabled}
      title={props.t('openWorkspaceFolder')}
      onClick={props.onOpenDirectory}
    >
      <FolderOpen size={20} />
      <span>{label}</span>
    </button>
  );
}

// 文件树区域：背景点击选中根、背景右键根菜单、键盘导航与树行渲染。
function FileSidebarTreeArea({ ctrl }: SidebarSectionProps) {
  const { t } = useI18n();
  const { activePath, collapsedFolders, fileTree, onOpenDirectory, onOpenFile, onRenameEntry, onToggleFolder, workspaceRoot } = ctrl.props;
  const disabled = ctrl.props.disabled ?? false;
  const { renamingPath, rootTarget, selectedTarget, setRenamingPath, setSelectedTarget, treeRef } = ctrl.selection;
  const { draggedTarget, dropTargetPath } = ctrl.drag;
  return (
    <div
      ref={treeRef}
      className="file-tree"
      role="tree"
      tabIndex={-1}
      aria-label={t('workspaceFileTree')}
      onClick={(event) => { if (event.target === event.currentTarget && rootTarget) setSelectedTarget(rootTarget); }}
      onContextMenu={ctrl.tree.handleTreeBackgroundContextMenu}
      onKeyDown={ctrl.tree.handleTreeNavigation}
    >
      {fileTree.length === 0 ? (
        <FileSidebarEmptyTree
          disabled={disabled}
          hasRoot={Boolean(workspaceRoot)}
          onOpenDirectory={onOpenDirectory}
          t={t}
        />
      ) : (
        <FileTreeRows
          activePath={activePath}
          collapsedFolders={collapsedFolders}
          disabled={disabled}
          draggingPath={draggedTarget?.path ?? null}
          dropTargetPath={dropTargetPath}
          nodes={fileTree}
          onBeginRename={ctrl.actions.beginRename}
          onCancelRename={() => setRenamingPath(null)}
          onCommitRename={(target, name) => {
            setRenamingPath(null);
            onRenameEntry(target.path, name, target.kind);
          }}
          onDeleteEntry={ctrl.actions.requestDelete}
          onOpenContextMenu={ctrl.menuState.openContextMenu}
          onOpenFile={onOpenFile}
          onSelectTarget={setSelectedTarget}
          onToggleFolder={onToggleFolder}
          renamingPath={renamingPath}
          selectedPath={selectedTarget?.path ?? activePath ?? workspaceRoot}
        />
      )}
    </div>
  );
}

// 文件面板：根按钮 + 文件树 + 右键上下文菜单门户。
function FileSidebarFilesPanel({ ctrl }: SidebarSectionProps) {
  const { t } = useI18n();
  const { contextMenu, contextMenuPosition, contextMenuRef } = ctrl.menuState;
  return (
    <div
      id="workspace-files-panel"
      className="sidebar-panel"
      role="tabpanel"
      aria-labelledby="workspace-files-tab"
      hidden={ctrl.views.sidebarView !== 'files'}
    >
      <FileSidebarRootButton ctrl={ctrl} />
      <FileSidebarTreeArea ctrl={ctrl} />
      <FileTreeContextMenuPortal
        contextMenu={contextMenu}
        contextMenuCanPaste={ctrl.actions.contextMenuCanPaste}
        contextMenuPosition={contextMenuPosition}
        contextMenuRef={contextMenuRef}
        disabled={ctrl.props.disabled ?? false}
        onInsertWorkspaceAssetAvailable={Boolean(ctrl.props.onInsertWorkspaceAsset)}
        runContextAction={ctrl.actions.runContextAction}
        t={t}
      />
    </div>
  );
}

// 大纲面板：无标题空态或可导航大纲树，按深度缩进并保持 roving tabIndex。
function FileSidebarOutlinePanel({ ctrl }: SidebarSectionProps) {
  const { t } = useI18n();
  const outlineItems = ctrl.props.outlineItems ?? [];
  const { handleOutlineTreeNavigation, selectOutlineItem, selectedOutlineId, sidebarView } = ctrl.views;
  return (
    <div
      id="document-outline-panel"
      className="sidebar-panel outline-panel"
      role="tabpanel"
      aria-labelledby="document-outline-tab"
      hidden={sidebarView !== 'outline'}
    >
      {outlineItems.length === 0 ? (
        <div className="empty-sidebar">
          <ListTree size={20} />
          <span>{t('noHeadings')}</span>
        </div>
      ) : (
        <div
          className="outline-tree"
          role="tree"
          tabIndex={-1}
          aria-label={t('documentOutline')}
          onKeyDown={handleOutlineTreeNavigation}
        >
          {outlineItems.map((item) => (
            <button
              key={item.id}
              type="button"
              role="treeitem"
              className={selectedOutlineId === item.id ? 'outline-item is-selected' : 'outline-item'}
              aria-level={item.depth + 1}
              aria-selected={selectedOutlineId === item.id}
              data-outline-heading-id={item.id}
              style={{ paddingLeft: `${7 + item.depth * 14}px` }}
              tabIndex={selectedOutlineId === item.id || (!selectedOutlineId && item.ordinal === 0) ? 0 : -1}
              onClick={() => selectOutlineItem(item)}
            >
              <span className="outline-item-level">H{item.level}</span>
              <span className="outline-item-label">{item.text}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// 展开态侧栏：标题工具条 + 选项卡 + 文件/大纲面板。
export function FileSidebarExpanded({ ctrl }: SidebarSectionProps) {
  return (
    <>
      <FileSidebarHeading ctrl={ctrl} />
      <FileSidebarTabs ctrl={ctrl} />
      <FileSidebarFilesPanel ctrl={ctrl} />
      <FileSidebarOutlinePanel ctrl={ctrl} />
    </>
  );
}
