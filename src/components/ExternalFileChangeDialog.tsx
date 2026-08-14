import { AlertTriangle, FileWarning } from 'lucide-react';
import type { ExternalFileActionDialogState } from '../hooks/useDocumentSession';
import { displayName } from '../lib/documentNames';
import { useI18n } from '../lib/i18n';

interface ExternalFileChangeDialogProps {
  action: ExternalFileActionDialogState;
  onCloseDeletedDraft: () => void;
  onKeepCurrent: () => void;
  onSaveDeletedDraftAs: () => void;
  onUseExternal: () => void;
}

export function ExternalFileChangeDialog({
  action,
  onCloseDeletedDraft,
  onKeepCurrent,
  onSaveDeletedDraftAs,
  onUseExternal,
}: ExternalFileChangeDialogProps) {
  const { t } = useI18n();
  const deletedDraft = action.kind === 'deleted-draft';
  const name = displayName(action.path);
  return (
    <div className="unsaved-dialog-backdrop external-file-change-backdrop">
      {/* oxlint-disable jsx-a11y/prefer-tag-over-role -- Shared application modal styling and focus behavior use a section surface. */}
      <section
        className="unsaved-dialog external-file-change-dialog"
        role="alertdialog"
        aria-busy={action.busy || undefined}
        aria-modal="true"
        aria-labelledby="external-file-change-title"
        aria-describedby="external-file-change-message"
      >
        <div className="unsaved-dialog-icon" aria-hidden="true">
          {deletedDraft ? <FileWarning size={24} /> : <AlertTriangle size={24} />}
        </div>
        <div className="unsaved-dialog-content">
          <h2 id="external-file-change-title">
            {deletedDraft ? t('fileDeleted') : t('fileChangedExternally')}
          </h2>
          <p id="external-file-change-message">
            {deletedDraft
              ? `${name}：${t('deletedDraftMessage')}`
              : `${name}：${t('externalChangeMessage')}`}
          </p>
          <div className="unsaved-dialog-actions">
            {deletedDraft ? (
              <>
                <button
                  type="button"
                  className="dialog-button secondary"
                  disabled={action.busy}
                  onClick={onSaveDeletedDraftAs}
                >
                  {t('saveAs')}
                </button>
                <button
                  type="button"
                  className="dialog-button danger"
                  disabled={action.busy}
                  onClick={onCloseDeletedDraft}
                >
                  {t('closeWithoutSaving')}
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="dialog-button secondary"
                  disabled={action.busy}
                  onClick={onUseExternal}
                >
                  {t('useExternalVersion')}
                </button>
                <button
                  type="button"
                  className="dialog-button danger"
                  disabled={action.busy}
                  onClick={onKeepCurrent}
                >
                  {t('keepCurrentEdits')}
                </button>
              </>
            )}
          </div>
        </div>
      </section>
      {/* oxlint-enable jsx-a11y/prefer-tag-over-role */}
    </div>
  );
}
