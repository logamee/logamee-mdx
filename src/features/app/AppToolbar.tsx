import { Check, CircleAlert, Download, FileText, Files, LoaderCircle, Search } from 'lucide-react';
import { displayName } from '../../lib/documentNames';
import { useI18n } from '../../lib/i18n';

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
      <ToolbarBrand canSearch={canSearch} onExport={onExport} onQuickOpen={onQuickOpen} onWorkspaceSearch={onWorkspaceSearch} />
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

// 品牌区：标识 + 导出/快速打开/工作区搜索三个图标按钮。
function ToolbarBrand(props: Omit<AppToolbarProps, 'activePath' | 'busy' | 'dirty'>) {
  const { t } = useI18n();
  return (
    <div className="brand">
      <span className="brand-mark" aria-hidden="true"><FileText size={15} /></span>
      <div className="brand-copy">
        <strong>mdx</strong>
        <small>Markdown</small>
      </div>
      <div className="toolbar-search-actions">
        <button type="button" aria-label={t('exportDocument')} className="toolbar-icon-button" disabled={!props.onExport} title={t('exportDocument')} onClick={props.onExport}><Download size={16} aria-hidden="true" /></button>
        <button
          type="button"
          aria-label={t('quickOpen')}
          className="toolbar-icon-button"
          disabled={!props.canSearch}
          title={t('quickOpen')}
          onClick={props.onQuickOpen}
        >
          <Files size={16} aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label={t('workspaceSearch')}
          className="toolbar-icon-button"
          disabled={!props.canSearch}
          title={t('workspaceSearch')}
          onClick={props.onWorkspaceSearch}
        >
          <Search size={16} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
