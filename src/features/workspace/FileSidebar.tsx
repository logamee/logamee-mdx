import { useI18n } from '../../lib/i18n';
import { useFileSidebarController } from './fileSidebarController';
import { FileSidebarRail } from './fileSidebarChromeView';
import { FileSidebarExpanded } from './fileSidebarPanelsView';
import type { FileSidebarProps } from './fileSidebarTypes';

export type { FileSidebarProps } from './fileSidebarTypes';

// 工作区侧栏：控制器聚合交互状态，视图区块按标题/选项卡/文件树/大纲分拆渲染。
export function FileSidebar(props: FileSidebarProps) {
  const ctrl = useFileSidebarController(props);
  const { t } = useI18n();
  const toggleLabel = props.collapsed ? t('expandFileTree') : t('collapseFileTree');
  return (
    <aside
      ref={ctrl.menuState.sidebarRef}
      className={props.collapsed ? 'sidebar is-collapsed' : 'sidebar'}
      onClickCapture={ctrl.drag.handleSidebarClickCapture}
      onPointerDown={ctrl.drag.handlePointerDown}
    >
      {props.collapsed
        ? (
          <FileSidebarRail
            onCollapseChange={props.onCollapseChange}
            toggleLabel={toggleLabel}
          />
        )
        : <FileSidebarExpanded ctrl={ctrl} />}
    </aside>
  );
}
