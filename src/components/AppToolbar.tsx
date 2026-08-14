import { Check, CircleAlert, Download, FileText, Files, LoaderCircle, Search } from 'lucide-react';
import { displayName } from '../lib/documentNames';
import { useI18n } from '../lib/i18n';

interface AppToolbarProps {
  activePath: string | null;
  busy: boolean;
  canSearch: boolean;
  dirty: boolean;
  onQuickOpen: () => void;
  onWorkspaceSearch: () => void;
  onExport?: () => void;
}

export function AppToolbar({
  activePath,
  busy,
  canSearch,
  dirty,
  onQuickOpen,
  onWorkspaceSearch,
  onExport,
}: AppToolbarProps) {
  const { t } = useI18n();
  const status = busy
    ? { className: 'is-working', icon: <LoaderCircle size={13} />, label: t('working') }
    : dirty
      ? { className: 'is-edited', icon: <CircleAlert size={13} />, label: t('edited') }
      : { className: 'is-saved', icon: <Check size={13} />, label: t('saved') };

  return (
    <header className="toolbar" data-tauri-drag-region>
      <div className="brand">
        <span className="brand-mark" aria-hidden="true"><FileText size={15} /></span>
        <div className="brand-copy">
          <strong>mdx</strong>
          <small>Markdown</small>
        </div>
        <div className="toolbar-search-actions">
          <button type="button" aria-label={t('exportDocument')} className="toolbar-icon-button" disabled={!onExport} title={t('exportDocument')} onClick={onExport}><Download size={16} aria-hidden="true" /></button>
          <button
            type="button"
            aria-label={t('quickOpen')}
            className="toolbar-icon-button"
            disabled={!canSearch}
            title={t('quickOpen')}
            onClick={onQuickOpen}
          >
            <Files size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label={t('workspaceSearch')}
            className="toolbar-icon-button"
            disabled={!canSearch}
            title={t('workspaceSearch')}
            onClick={onWorkspaceSearch}
          >
            <Search size={16} aria-hidden="true" />
          </button>
        </div>
      </div>
      <div
        className="toolbar-document"
        aria-label={t('currentDocument')}
        title={activePath ?? undefined}
      >
        {displayName(activePath)}
      </div>
      <div className={`document-status ${status.className}`} aria-live="polite">
        {status.icon}
        <span>{status.label}</span>
      </div>
    </header>
  );
}
