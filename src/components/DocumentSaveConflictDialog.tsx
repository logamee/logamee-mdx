import { AlertTriangle } from 'lucide-react';
import type { DocumentSaveConflictDialogState } from '../hooks/useDocumentSession';
import { displayName } from '../lib/documentNames';
import { useI18n } from '../lib/i18n';

interface DocumentSaveConflictDialogProps {
  conflict: DocumentSaveConflictDialogState;
  onCancel: () => void;
  onOverwrite: () => void;
}

export function DocumentSaveConflictDialog({
  conflict,
  onCancel,
  onOverwrite,
}: DocumentSaveConflictDialogProps) {
  const { locale } = useI18n();
  const chinese = locale === 'zh-CN';
  return (
    <div className="unsaved-dialog-backdrop document-save-conflict-backdrop">
      {/* oxlint-disable jsx-a11y/prefer-tag-over-role -- Shared application modal surface. */}
      <section
        className="unsaved-dialog document-save-conflict-dialog"
        role="alertdialog"
        aria-busy={conflict.busy || undefined}
        aria-modal="true"
        aria-labelledby="document-save-conflict-title"
        aria-describedby="document-save-conflict-message"
      >
        <div className="unsaved-dialog-icon" aria-hidden="true"><AlertTriangle size={24} /></div>
        <div className="unsaved-dialog-content">
          <h2 id="document-save-conflict-title">
            {chinese ? '文件已在其他位置更改' : 'File Changed on Disk'}
          </h2>
          <p id="document-save-conflict-message">
            {chinese
              ? `${displayName(conflict.path)} 已被外部修改。是否用当前编辑覆盖磁盘版本？`
              : `${displayName(conflict.path)} was modified outside mdx. Overwrite the disk version with your current edits?`}
          </p>
          <div className="unsaved-dialog-actions">
            <button type="button" className="dialog-button ghost" disabled={conflict.busy} onClick={onCancel}>
              {chinese ? '取消' : 'Cancel'}
            </button>
            <button type="button" className="dialog-button danger" disabled={conflict.busy} onClick={onOverwrite}>
              {chinese ? '覆盖' : 'Overwrite'}
            </button>
          </div>
        </div>
      </section>
      {/* oxlint-enable jsx-a11y/prefer-tag-over-role */}
    </div>
  );
}
