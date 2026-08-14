import { AlertTriangle } from 'lucide-react';
import type { UnsavedExitPrompt } from '../lib/closeGuard';
import { useI18n } from '../lib/i18n';

interface UnsavedExitDialogProps {
  busy: boolean;
  prompt: UnsavedExitPrompt;
  onCancelExit: () => void;
  onQuitWithoutSaving: () => void;
  onSaveAndQuit: () => void;
}

export function UnsavedExitDialog({ busy, prompt, onCancelExit, onQuitWithoutSaving, onSaveAndQuit }: UnsavedExitDialogProps) {
  const { t } = useI18n();
  return (
    <div className="unsaved-dialog-backdrop">
      {/* oxlint-disable jsx-a11y/prefer-tag-over-role -- Existing styled modal uses section; switching to native dialog changes runtime semantics. */}
      <section
        className="unsaved-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="unsaved-exit-title"
        aria-describedby="unsaved-exit-message"
      >
        <div className="unsaved-dialog-icon" aria-hidden="true">
          <AlertTriangle size={24} />
        </div>
        <div className="unsaved-dialog-content">
          <h2 id="unsaved-exit-title">{prompt.title}</h2>
          <p id="unsaved-exit-message">{prompt.message}</p>
          <div className="unsaved-dialog-actions">
            <button type="button" className="dialog-button secondary" disabled={busy} onClick={onSaveAndQuit}>
              {busy ? t('saving') : prompt.saveLabel}
            </button>
            <button type="button" className="dialog-button ghost" disabled={busy} onClick={onCancelExit}>
              {prompt.cancelLabel}
            </button>
            <button type="button" className="dialog-button danger" disabled={busy} onClick={onQuitWithoutSaving}>
              {prompt.quitLabel}
            </button>
          </div>
        </div>
      </section>
      {/* oxlint-enable jsx-a11y/prefer-tag-over-role */}
    </div>
  );
}
