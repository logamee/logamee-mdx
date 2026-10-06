import { FileText, LoaderCircle, RotateCw, Search, X } from 'lucide-react';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import type { WorkspaceIndexQueryResult } from '../../types';
import { useI18n } from '../../lib/i18n';

function resultLabel(result: WorkspaceIndexQueryResult): string {
  const segments = result.relativePath.split('/');
  return segments[segments.length - 1] ?? result.relativePath;
}

function resultLocation(result: WorkspaceIndexQueryResult): string | null {
  if (!result.location) return null;
  return `Line ${result.location.line}`;
}

// 搜索输入行：加载态图标、键盘循环选择、回车确认与重建按钮。
export function WorkspaceSearchInputRow(props: {
  activeIndexRef: RefObject<HTMLButtonElement | null>;
  inputRef: RefObject<HTMLInputElement | null>;
  indexing: boolean;
  placeholder: string;
  query: string;
  rebuild: () => void;
  results: WorkspaceIndexQueryResult[];
  searching: boolean;
  setActiveIndex: Dispatch<SetStateAction<number>>;
  setQuery: (query: string) => void;
  submitActive: () => void;
  title: string;
}) {
  const { t } = useI18n();
  return (
    <label className="workspace-search-input">
      {props.indexing || props.searching ? <LoaderCircle size={16} aria-hidden="true" /> : <Search size={16} aria-hidden="true" />}
      <input
        ref={props.inputRef}
        aria-controls="workspace-search-result-list"
        aria-label={props.title}
        autoComplete="off"
        placeholder={props.placeholder}
        spellCheck={false}
        value={props.query}
        onChange={(event) => props.setQuery(event.currentTarget.value)}
        onKeyDown={(event) => handleSearchInputKey(event, {
          results: props.results, setActiveIndex: props.setActiveIndex, submitActive: props.submitActive,
        })}
      />
      <button
        type="button"
        className="workspace-search-rebuild"
        disabled={props.indexing}
        aria-label={t('rebuildIndex')}
        title={t('rebuildIndex')}
        onClick={() => props.rebuild()}
      >
        <RotateCw size={15} aria-hidden="true" />
      </button>
    </label>
  );
}

// 输入键盘：上下循环移动激活项，回车确认。
function handleSearchInputKey(event: { key: string; preventDefault: () => void }, handlers: {
  results: WorkspaceIndexQueryResult[];
  setActiveIndex: Dispatch<SetStateAction<number>>;
  submitActive: () => void;
}): void {
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    handlers.setActiveIndex((index) => handlers.results.length ? (index + 1) % handlers.results.length : 0);
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    handlers.setActiveIndex((index) => handlers.results.length ? (index - 1 + handlers.results.length) % handlers.results.length : 0);
  } else if (event.key === 'Enter') {
    event.preventDefault();
    handlers.submitActive();
  }
}

// 结果列表：索引/空态/无结果提示与逐条结果按钮（悬停跟随激活）。
export function WorkspaceSearchResultList(props: {
  activeIndex: number;
  activeResultRef: RefObject<HTMLButtonElement | null>;
  indexGeneration: number | null;
  indexing: boolean;
  normalizedQuery: string;
  onHover: (index: number) => void;
  onSelect: (result: WorkspaceIndexQueryResult) => void;
  results: WorkspaceIndexQueryResult[];
  searching: boolean;
  title: string;
  truncated: boolean;
}) {
  const { t } = useI18n();
  return (
    <ul id="workspace-search-result-list" className="workspace-search-result-list" aria-label={props.title}>
      {props.indexing && <li className="workspace-search-state">{t('rebuildingIndex')}</li>}
      {!props.indexing && props.normalizedQuery.length === 0 && <li className="workspace-search-state">{t('searchWorkspace')}</li>}
      {!props.indexing && props.normalizedQuery.length > 0 && !props.searching && props.results.length === 0 && (
        <li className="workspace-search-state">{t('noSearchResults')}</li>
      )}
      {props.results.map((result, index) => (
        <li key={result.relativePath}>
          <button
            ref={index === props.activeIndex ? props.activeResultRef : undefined}
            id={`workspace-search-${result.relativePath}`}
            type="button"
            aria-current={index === props.activeIndex ? 'true' : undefined}
            className="workspace-search-result"
            data-relative-path={result.relativePath}
            title={t('openSearchResult', { path: result.relativePath })}
            onMouseMove={() => props.onHover(index)}
            onClick={() => props.onSelect(result)}
          >
            <FileText size={16} aria-hidden="true" />
            <span className="workspace-search-result-copy">
              <strong>{resultLabel(result)}</strong>
              <small>{result.relativePath}</small>
              {result.snippet && <em>{result.snippet}</em>}
            </span>
            {resultLocation(result) && <span className="workspace-search-result-location">{resultLocation(result)}</span>}
          </button>
        </li>
      ))}
      {props.truncated && <li className="workspace-search-truncated">{t('resultsTruncated')}</li>}
    </ul>
  );
}

// 对话框头：标题、关闭按钮与输入行。
export function WorkspaceSearchDialogHeader(props: {
  onCancel: () => void;
  placeholder: string;
  title: string;
} & Parameters<typeof WorkspaceSearchInputRow>[0]) {
  const { t } = useI18n();
  return (
    <div className="workspace-search-dialog-header">
      <div className="workspace-search-dialog-title-row">
        <h2 id="workspace-search-dialog-title">{props.title}</h2>
        <button
          type="button"
          className="workspace-search-dialog-close"
          aria-label={t('cancel')}
          title={t('cancel')}
          onClick={props.onCancel}
        >
          <X size={16} aria-hidden="true" />
        </button>
      </div>
      <WorkspaceSearchInputRow
        activeIndexRef={props.activeIndexRef}
        inputRef={props.inputRef}
        indexing={props.indexing}
        placeholder={props.placeholder}
        query={props.query}
        rebuild={props.rebuild}
        results={props.results}
        searching={props.searching}
        setActiveIndex={props.setActiveIndex}
        setQuery={props.setQuery}
        submitActive={props.submitActive}
        title={props.title}
      />
    </div>
  );
}
