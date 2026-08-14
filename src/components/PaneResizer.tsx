import { GripVertical } from 'lucide-react';
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from 'react';
import { useI18n } from '../lib/i18n';

interface PaneResizerProps {
  editorPaneRatio: number;
  onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
  onPointerCancel: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLButtonElement>) => void;
}

export function PaneResizer({ editorPaneRatio, onKeyDown, onPointerCancel, onPointerDown, onPointerMove, onPointerUp }: PaneResizerProps) {
  const { t } = useI18n();
  return (
    <>
      {/* oxlint-disable jsx-a11y/prefer-tag-over-role -- An adjustable separator needs button pointer and keyboard semantics. */}
      <button
        type="button"
        className="pane-resizer"
        role="separator"
        aria-label={t('resizePanes')}
        aria-orientation="vertical"
        aria-valuemin={25}
        aria-valuemax={75}
        aria-valuenow={Math.round(editorPaneRatio * 100)}
        title={t('resizePanes')}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
      >
        <GripVertical size={16} />
      </button>
      {/* oxlint-enable jsx-a11y/prefer-tag-over-role */}
    </>
  );
}
