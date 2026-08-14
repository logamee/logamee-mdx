import { AlertTriangle, FileClock, Trash2 } from 'lucide-react';
import type {
  CrashDraftCatalog,
  CrashDraftCatalogEntry,
  RecoverableCrashDraftEntry,
} from '../lib/crashDrafts';
import type { EffectiveLocale } from '../lib/locale';

interface CrashDraftRecoveryDialogProps {
  busy: boolean;
  catalog: CrashDraftCatalog;
  locale: EffectiveLocale;
  onRecover: (entry: RecoverableCrashDraftEntry) => void;
  onDiscard: (entry: CrashDraftCatalogEntry) => void;
  onDiscardAll: (catalogToken: string) => void;
}

const copy = {
  en: {
    title: 'Recover Unsaved Work',
    message: 'mdx found edits from an earlier session. Recover the drafts you need or discard them.',
    recoverable: 'Unsaved draft',
    corrupt: 'Damaged draft',
    unsupportedVersion: 'Draft from a newer mdx version',
    recover: 'Recover',
    discard: 'Discard',
    discardAll: 'Discard All',
  },
  'zh-CN': {
    title: '恢复未保存内容',
    message: 'mdx 找到了上次会话留下的编辑内容。请恢复需要的草稿，或将其丢弃。',
    recoverable: '未保存的草稿',
    corrupt: '已损坏的草稿',
    unsupportedVersion: '由更新版本 mdx 创建的草稿',
    recover: '恢复',
    discard: '丢弃',
    discardAll: '全部丢弃',
  },
};

export function CrashDraftRecoveryDialog({
  busy,
  catalog,
  locale,
  onRecover,
  onDiscard,
  onDiscardAll,
}: CrashDraftRecoveryDialogProps) {
  if (catalog.entries.length === 0) return null;
  const text = copy[locale];

  return (
    <div className="unsaved-dialog-backdrop crash-draft-recovery-backdrop">
      {/* oxlint-disable jsx-a11y/prefer-tag-over-role -- Shared application modal styling uses a section surface. */}
      <section
        className="unsaved-dialog crash-draft-recovery-dialog"
        role="alertdialog"
        aria-busy={busy || undefined}
        aria-modal="true"
        aria-labelledby="crash-draft-recovery-title"
        aria-describedby="crash-draft-recovery-message"
      >
        <div className="unsaved-dialog-icon" aria-hidden="true">
          <FileClock size={24} />
        </div>
        <div className="unsaved-dialog-content">
          <h2 id="crash-draft-recovery-title">{text.title}</h2>
          <p id="crash-draft-recovery-message">{text.message}</p>
          <ul className="crash-draft-recovery-list">
            {catalog.entries.map((entry) => (
              <li key={entry.documentId} className={`crash-draft-recovery-entry ${entry.status}`}>
                <span className="crash-draft-recovery-label">
                  {entry.status === 'recoverable'
                    ? <FileClock size={16} aria-hidden="true" />
                    : <AlertTriangle size={16} aria-hidden="true" />}
                  {text[entry.status]}
                </span>
                <span className="crash-draft-recovery-entry-actions">
                  {entry.status === 'recoverable' && (
                    <button
                      type="button"
                      className="dialog-button secondary"
                      disabled={busy}
                      onClick={() => onRecover(entry)}
                    >
                      {text.recover}
                    </button>
                  )}
                  <button
                    type="button"
                    className="dialog-button danger"
                    disabled={busy}
                    onClick={() => onDiscard(entry)}
                  >
                    {text.discard}
                  </button>
                </span>
              </li>
            ))}
          </ul>
          <div className="unsaved-dialog-actions">
            <button
              type="button"
              className="dialog-button danger"
              disabled={busy}
              onClick={() => onDiscardAll(catalog.catalogToken)}
            >
              <Trash2 size={15} aria-hidden="true" />
              {text.discardAll}
            </button>
          </div>
        </div>
      </section>
      {/* oxlint-enable jsx-a11y/prefer-tag-over-role */}
    </div>
  );
}
