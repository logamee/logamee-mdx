import {
  ChevronLeft,
  ChevronRight,
  Ellipsis,
  FilePlus2,
  FolderOpen,
  FolderPlus,
  PencilRuler,
  Plus,
  RefreshCw,
} from 'lucide-react';
import { createPortal } from 'react-dom';
import { useI18n, type Translate } from '../../lib/i18n';
import type { FileSidebarController } from './fileSidebarController';
import type { MenuPosition } from './fileSidebarIcon';

interface SidebarSectionProps {
  ctrl: FileSidebarController;
}

// 收起态侧栏轨道：仅保留展开按钮与文件标签。
export function FileSidebarRail(props: {
  onCollapseChange: (collapsed: boolean) => void;
  toggleLabel: string;
}) {
  const { t } = useI18n();
  return (
    <div className="sidebar-rail">
      <button
        type="button"
        className="sidebar-icon-button sidebar-collapse-toggle"
        aria-label={props.toggleLabel}
        title={props.toggleLabel}
        onClick={() => props.onCollapseChange(false)}
      >
        <ChevronRight size={16} />
      </button>
      <div className="sidebar-rail-label" title={t('workspaceFiles')}>
        <FolderOpen size={18} />
        <span>{t('files')}</span>
      </div>
    </div>
  );
}

// 添加菜单门户：三个创建入口（Markdown/Excalidraw/文件夹），按按钮锚点定位。
function FileSidebarAddMenuPortal(props: {
  addMenuRef: FileSidebarController['menuState']['addMenuRef'];
  beginCreate: FileSidebarController['actions']['beginCreate'];
  position: MenuPosition | null;
  t: Translate;
}) {
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div
      ref={props.addMenuRef}
      className="sidebar-add-menu"
      role="menu"
      tabIndex={-1}
      style={{
        left: props.position?.x ?? 0,
        top: props.position?.y ?? 0,
        visibility: props.position ? 'visible' : 'hidden',
      }}
    >
      <button type="button" role="menuitem" onClick={() => props.beginCreate('file')}>
        <FilePlus2 size={14} />
        <span>{props.t('newMarkdownFile')}</span>
      </button>
      <button type="button" role="menuitem" onClick={() => props.beginCreate('excalidraw')}>
        <PencilRuler size={14} />
        <span>{props.t('newExcalidrawFile')}</span>
      </button>
      <button type="button" role="menuitem" onClick={() => props.beginCreate('folder')}>
        <FolderPlus size={14} />
        <span>{props.t('newFolder')}</span>
      </button>
    </div>,
    document.body,
  );
}

function FileSidebarAddMenuButton({ ctrl }: SidebarSectionProps) {
  const { t } = useI18n();
  const { addMenuButtonRef, addMenuOpen, addMenuPosition, addMenuRef } = ctrl.menuState;
  const label = t('addWorkspaceItem');
  return (
    <div className="sidebar-add-menu-wrap">
      <button
        ref={addMenuButtonRef}
        type="button"
        className="sidebar-icon-button"
        aria-label={label}
        aria-expanded={addMenuOpen}
        aria-haspopup="menu"
        disabled={ctrl.props.disabled}
        title={label}
        onClick={ctrl.menus.toggleAddMenu}
      >
        <Plus size={16} />
      </button>
      {addMenuOpen && (
        <FileSidebarAddMenuPortal
          addMenuRef={addMenuRef}
          beginCreate={ctrl.actions.beginCreate}
          position={addMenuPosition}
          t={t}
        />
      )}
    </div>
  );
}

// 选中目标的"更多"菜单按钮：仅在树内目标（非根）选中时出现。
function FileSidebarSelectedMenuButton({ ctrl }: SidebarSectionProps) {
  const { t } = useI18n();
  const selected = ctrl.selection.selectedTarget;
  const label = t('moreActions', { name: selected?.name ?? '' });
  return (
    <button
      type="button"
      className="sidebar-icon-button"
      aria-label={label}
      aria-expanded={ctrl.menuState.contextMenu?.target.path === selected?.path}
      aria-haspopup="menu"
      disabled={ctrl.props.disabled}
      title={label}
      onClick={ctrl.menus.openSelectedTargetMenu}
    >
      <Ellipsis size={16} />
    </button>
  );
}

// 侧栏标题：工作区名 + 当前视图 + 添加/更多/刷新/收起工具条。
export function FileSidebarHeading({ ctrl }: SidebarSectionProps) {
  const { t } = useI18n();
  const { disabled, onCollapseChange, onRefreshWorkspace, workspaceRoot } = ctrl.props;
  const { selectedTarget } = ctrl.selection;
  const { sidebarView } = ctrl.views;
  return (
    <div className="sidebar-heading" aria-label={t('workspaceFiles')}>
      <div className="sidebar-heading-title">
        <strong>{t('workspace')}</strong>
        <span>{sidebarView === 'files' ? t('files') : t('outline')}</span>
      </div>
      <div className="sidebar-heading-actions">
        {sidebarView === 'files' && (
          <>
            {workspaceRoot && <FileSidebarAddMenuButton ctrl={ctrl} />}
            {selectedTarget && selectedTarget.kind !== 'root' && (
              <FileSidebarSelectedMenuButton ctrl={ctrl} />
            )}
            {workspaceRoot && (
              <button
                type="button"
                className="sidebar-icon-button"
                aria-label={t('refreshWorkspace')}
                disabled={disabled}
                title={t('refreshWorkspace')}
                onClick={onRefreshWorkspace}
              >
                <RefreshCw size={14} />
              </button>
            )}
          </>
        )}
        <button
          type="button"
          className="sidebar-icon-button sidebar-collapse-toggle"
          aria-label={t('collapseFileTree')}
          title={t('collapseFileTree')}
          onClick={() => onCollapseChange(true)}
        >
          <ChevronLeft size={15} />
        </button>
      </div>
    </div>
  );
}
