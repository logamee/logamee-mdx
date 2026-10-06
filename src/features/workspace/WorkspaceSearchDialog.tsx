import { useI18n } from '../../lib/i18n';
import { useWorkspaceSearchResults } from './workspaceSearchResultsController';
import type { WorkspaceSearchMode, WorkspaceSearchSelection } from './workspaceSearchResultsController';
import { WorkspaceSearchDialogHeader, WorkspaceSearchResultList } from './workspaceSearchDialogView';

export type { WorkspaceSearchMode, WorkspaceSearchSelection } from './workspaceSearchResultsController';

interface WorkspaceSearchDialogProps {
  mode: WorkspaceSearchMode;
  workspaceRoot: string;
  workspaceToken: string;
  onCancel: () => void;
  onError: (error: unknown) => void;
  onSelect: (selection: WorkspaceSearchSelection) => void;
}

export function WorkspaceSearchDialog({
  mode, workspaceRoot, workspaceToken, onCancel, onError, onSelect,
}: WorkspaceSearchDialogProps) {
  const { t } = useI18n();
  const search = useWorkspaceSearchResults({ mode, onError, onSelect, workspaceRoot, workspaceToken });
  const title = mode === 'quick-open' ? t('quickOpen') : t('workspaceSearch');
  const placeholder = mode === 'quick-open' ? t('searchFiles') : t('searchContent');

  return (
    <div className="workspace-search-dialog-backdrop">
      <dialog
        open
        className="workspace-search-dialog"
        aria-labelledby="workspace-search-dialog-title"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
          }
        }}
      >
        <WorkspaceSearchDialogHeader
          activeIndexRef={search.activeResultRef} inputRef={search.inputRef} indexing={search.indexing}
          onCancel={onCancel} placeholder={placeholder} query={search.query}
          rebuild={() => void search.rebuild()} results={search.results} searching={search.searching}
          setActiveIndex={search.setActiveIndex} setQuery={search.setQuery}
          submitActive={search.selectActiveResult} title={title}
        />
        <WorkspaceSearchResultList
          activeIndex={search.activeIndex}
          activeResultRef={search.activeResultRef}
          indexGeneration={search.indexGeneration}
          indexing={search.indexing}
          normalizedQuery={search.normalizedQuery}
          onHover={search.setActiveIndex}
          onSelect={(result) => search.indexGeneration !== null && onSelect({ workspaceToken, workspaceRoot, indexGeneration: search.indexGeneration, relativePath: result.relativePath })}
          results={search.results}
          searching={search.searching}
          title={title}
          truncated={search.truncated}
        />
      </dialog>
    </div>
  );
}
