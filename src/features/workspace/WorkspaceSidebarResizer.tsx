import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from 'react';
import {
  MAX_WORKSPACE_SIDEBAR_WIDTH,
  MIN_WORKSPACE_SIDEBAR_WIDTH,
} from '../../lib/sidebarLayout';
import { useI18n } from '../../lib/i18n';

interface WorkspaceSidebarResizerProps {
  onBlur?: () => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
  onKeyUp?: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
  onPointerCancel: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  sidebarWidth: number;
}

export function WorkspaceSidebarResizer({
  onBlur,
  onKeyDown,
  onKeyUp,
  onPointerCancel,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  sidebarWidth,
}: WorkspaceSidebarResizerProps) {
  const { t } = useI18n();
  return (
    <>
      {/* oxlint-disable jsx-a11y/prefer-tag-over-role -- An adjustable separator needs button pointer and keyboard semantics. */}
      <button
        type="button"
        className="workspace-sidebar-resizer"
        role="separator"
        aria-label={t('resizeSidebar')}
        aria-orientation="vertical"
        aria-valuemax={MAX_WORKSPACE_SIDEBAR_WIDTH}
        aria-valuemin={MIN_WORKSPACE_SIDEBAR_WIDTH}
        aria-valuenow={sidebarWidth}
        title={t('resizeSidebar')}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onPointerCancel={onPointerCancel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      />
      {/* oxlint-enable jsx-a11y/prefer-tag-over-role */}
    </>
  );
}
