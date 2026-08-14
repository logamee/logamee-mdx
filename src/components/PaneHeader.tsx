import { ExternalLink } from 'lucide-react';
import type { ReactNode } from 'react';
import type { PanePopoutButtonState } from '../lib/paneLayout';

interface PaneHeaderProps {
  beforePopout?: ReactNode;
  onPopout?: () => void;
  popoutButton?: PanePopoutButtonState;
  subtitle: string;
  title: string;
}

export function PaneHeader({ beforePopout, onPopout, popoutButton, subtitle, title }: PaneHeaderProps) {
  const showPopoutButton = Boolean(popoutButton && onPopout);

  return (
    <div className="pane-title">
      <span className="pane-title-main">{title} <span>{subtitle}</span></span>
      {(beforePopout || showPopoutButton) && (
        <div className="pane-title-actions">
          {beforePopout}
          {popoutButton && onPopout && (
            <button
              type="button"
              className={popoutButton.isPoppedOut ? 'pane-popout-button is-popped-out' : 'pane-popout-button'}
              title={popoutButton.title}
              aria-label={popoutButton.ariaLabel}
              aria-pressed={popoutButton.isPoppedOut}
              onClick={onPopout}
            >
              <ExternalLink size={14} />
              {popoutButton.statusLabel && <span className="pane-popout-button-label">{popoutButton.statusLabel}</span>}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
