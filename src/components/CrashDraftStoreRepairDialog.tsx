import { AlertTriangle, RefreshCw, Wrench } from 'lucide-react';
import type { CrashDraftOverflowResetProgress, ProjectedCrashDraftError } from '../lib/crashDrafts';
import type { EffectiveLocale } from '../lib/locale';

interface CrashDraftStoreRepairDialogProps {
  busy: boolean;
  canRepairOverflow: boolean;
  error: ProjectedCrashDraftError | null;
  locale: EffectiveLocale;
  overflowRepairProgress: CrashDraftOverflowResetProgress | null;
  onRepairOverflow: () => unknown;
  onRetry: () => unknown;
}

const copy = {
  en: {
    title: 'Crash Draft Storage Problem',
    retry: 'Retry',
    repair: 'Repair Draft Storage',
    errorMessage: 'Crash draft storage needs attention. Current edits remain in the editor.',
    progress: (removed: number, blocked: number) => (
      `Last repair batch removed ${removed} draft${removed === 1 ? '' : 's'}; ${blocked} could not be removed.`
    ),
  },
  'zh-CN': {
    title: '崩溃恢复草稿存储异常',
    retry: '重试',
    repair: '修复草稿存储',
    errorMessage: '崩溃恢复草稿存储需要处理。当前编辑仍保留在编辑器中。',
    progress: (removed: number, blocked: number) => `上一批已移除 ${removed} 个草稿，${blocked} 个未能移除。`,
  },
};

export function CrashDraftStoreRepairDialog({
  busy,
  canRepairOverflow,
  error,
  locale,
  overflowRepairProgress,
  onRepairOverflow,
  onRetry,
}: CrashDraftStoreRepairDialogProps) {
  if (!error) return null;
  const text = copy[locale];

  return (
    <div className="app-dialog-backdrop crash-draft-store-repair-backdrop">
      {/* oxlint-disable jsx-a11y/prefer-tag-over-role -- Shared application modal surface. */}
      <section
        className="app-dialog error crash-draft-store-repair-dialog"
        role="alertdialog"
        aria-busy={busy || undefined}
        aria-modal="true"
        aria-labelledby="crash-draft-store-repair-title"
        aria-describedby="crash-draft-store-repair-message"
      >
        <div className="app-dialog-icon error" aria-hidden="true">
          <AlertTriangle size={24} />
        </div>
        <div className="app-dialog-content">
          <h2 id="crash-draft-store-repair-title">{text.title}</h2>
          <p id="crash-draft-store-repair-message">
            {locale === 'zh-CN' ? text.errorMessage : error.message}
          </p>
          {overflowRepairProgress && (
            <p className="crash-draft-store-repair-progress" aria-live="polite">
              {text.progress(
                overflowRepairProgress.removedEntries,
                overflowRepairProgress.blockedEntries,
              )}
            </p>
          )}
          <div className="app-dialog-actions">
            <button type="button" className="dialog-button secondary" disabled={busy} onClick={() => void onRetry()}>
              <RefreshCw size={15} aria-hidden="true" />
              {text.retry}
            </button>
            {canRepairOverflow && (
              <button type="button" className="dialog-button danger" disabled={busy} onClick={() => void onRepairOverflow()}>
                <Wrench size={15} aria-hidden="true" />
                {text.repair}
              </button>
            )}
          </div>
        </div>
      </section>
      {/* oxlint-enable jsx-a11y/prefer-tag-over-role */}
    </div>
  );
}
