import { FileText, LoaderCircle, RotateCw, Search, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorkspaceIndexQueryKind, WorkspaceIndexQueryResult } from '../types';
import { useI18n } from '../lib/i18n';
import {
  cancelWorkspaceIndexOperation,
  queryWorkspaceIndex,
  rebuildWorkspaceIndex,
} from '../lib/tauriCommands';
import { createWorkspaceIndexOperationId } from '../lib/workspaceSearch';

export type WorkspaceSearchMode = 'quick-open' | 'workspace-search';

export interface WorkspaceSearchSelection {
  workspaceToken: string;
  workspaceRoot: string;
  indexGeneration: number;
  relativePath: string;
}

interface WorkspaceSearchDialogProps {
  mode: WorkspaceSearchMode;
  workspaceRoot: string;
  workspaceToken: string;
  onCancel: () => void;
  onError: (error: unknown) => void;
  onSelect: (selection: WorkspaceSearchSelection) => void;
}

const SEARCH_DEBOUNCE_MS = 160;

function resultLabel(result: WorkspaceIndexQueryResult): string {
  const segments = result.relativePath.split('/');
  return segments[segments.length - 1] ?? result.relativePath;
}

function resultLocation(result: WorkspaceIndexQueryResult): string | null {
  if (!result.location) return null;
  return `Line ${result.location.line}`;
}

export function WorkspaceSearchDialog({
  mode,
  workspaceRoot,
  workspaceToken,
  onCancel,
  onError,
  onSelect,
}: WorkspaceSearchDialogProps) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<WorkspaceIndexQueryResult[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [indexGeneration, setIndexGeneration] = useState<number | null>(null);
  const [indexing, setIndexing] = useState(true);
  const [searching, setSearching] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const activeResultRef = useRef<HTMLButtonElement>(null);
  const buildOperationRef = useRef<string | null>(null);
  const queryOperationRef = useRef<string | null>(null);
  const requestGenerationRef = useRef(0);

  const cancelOperation = useCallback((operationId: string | null) => {
    if (!operationId) return;
    void cancelWorkspaceIndexOperation(operationId).catch(() => undefined);
  }, []);

  const rebuild = useCallback(async () => {
    cancelOperation(buildOperationRef.current);
    cancelOperation(queryOperationRef.current);
    const operationId = createWorkspaceIndexOperationId('rebuild');
    buildOperationRef.current = operationId;
    queryOperationRef.current = null;
    requestGenerationRef.current += 1;
    setIndexing(true);
    setSearching(false);
    setIndexGeneration(null);
    setResults([]);
    setTruncated(false);
    setActiveIndex(0);
    try {
      const response = await rebuildWorkspaceIndex(workspaceToken, workspaceRoot, operationId);
      if (buildOperationRef.current !== operationId) return;
      if (response.status === 'ready' && response.workspaceToken === workspaceToken) {
        setIndexGeneration(response.indexGeneration);
      }
    } catch (error) {
      if (buildOperationRef.current === operationId) onError(error);
    } finally {
      if (buildOperationRef.current === operationId) {
        buildOperationRef.current = null;
        setIndexing(false);
      }
    }
  }, [cancelOperation, onError, workspaceRoot, workspaceToken]);

  useEffect(() => {
    void rebuild();
    return () => {
      cancelOperation(buildOperationRef.current);
      cancelOperation(queryOperationRef.current);
      buildOperationRef.current = null;
      queryOperationRef.current = null;
    };
  }, [cancelOperation, rebuild]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query, results]);

  useEffect(() => {
    activeResultRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [activeIndex, results]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const queryKind: WorkspaceIndexQueryKind = mode === 'quick-open' ? 'filename' : 'fullText';
  const normalizedQuery = query.trim();

  useEffect(() => {
    cancelOperation(queryOperationRef.current);
    queryOperationRef.current = null;
    const requestGeneration = ++requestGenerationRef.current;
    if (indexGeneration === null || !normalizedQuery) {
      setSearching(false);
      setResults([]);
      setTruncated(false);
      return undefined;
    }

    const timer = window.setTimeout(() => {
      const operationId = createWorkspaceIndexOperationId('query');
      queryOperationRef.current = operationId;
      setSearching(true);
      void queryWorkspaceIndex(workspaceToken, workspaceRoot, operationId, {
        kind: queryKind,
        text: normalizedQuery,
      }).then((response) => {
        if (
          queryOperationRef.current !== operationId
          || requestGenerationRef.current !== requestGeneration
          || response.status !== 'ready'
          || response.indexGeneration !== indexGeneration
          || response.workspaceToken !== workspaceToken
        ) return;
        setResults(response.results);
        setTruncated(response.truncated);
      }).catch((error: unknown) => {
        if (queryOperationRef.current === operationId && requestGenerationRef.current === requestGeneration) {
          onError(error);
        }
      }).finally(() => {
        if (queryOperationRef.current === operationId) {
          queryOperationRef.current = null;
          setSearching(false);
        }
      });
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
      if (queryOperationRef.current) cancelOperation(queryOperationRef.current);
    };
  }, [
    cancelOperation,
    indexGeneration,
    normalizedQuery,
    onError,
    queryKind,
    workspaceRoot,
    workspaceToken,
  ]);

  const selectActiveResult = useCallback(() => {
    const result = results[activeIndex];
    if (!result || indexGeneration === null) return;
    onSelect({
      workspaceToken,
      workspaceRoot,
      indexGeneration,
      relativePath: result.relativePath,
    });
  }, [activeIndex, indexGeneration, onSelect, results, workspaceRoot, workspaceToken]);

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
        <div className="workspace-search-dialog-header">
          <div className="workspace-search-dialog-title-row">
            <h2 id="workspace-search-dialog-title">{title}</h2>
            <button
              type="button"
              className="workspace-search-dialog-close"
              aria-label={t('cancel')}
              title={t('cancel')}
              onClick={onCancel}
            >
              <X size={16} aria-hidden="true" />
            </button>
          </div>
          <label className="workspace-search-input">
            {indexing || searching ? <LoaderCircle size={16} aria-hidden="true" /> : <Search size={16} aria-hidden="true" />}
            <input
              ref={inputRef}
              aria-controls="workspace-search-result-list"
              aria-label={title}
              autoComplete="off"
              placeholder={placeholder}
              spellCheck={false}
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown') {
                  event.preventDefault();
                  setActiveIndex((index) => results.length ? (index + 1) % results.length : 0);
                } else if (event.key === 'ArrowUp') {
                  event.preventDefault();
                  setActiveIndex((index) => results.length ? (index - 1 + results.length) % results.length : 0);
                } else if (event.key === 'Enter') {
                  event.preventDefault();
                  selectActiveResult();
                }
              }}
            />
            <button
              type="button"
              className="workspace-search-rebuild"
              disabled={indexing}
              aria-label={t('rebuildIndex')}
              title={t('rebuildIndex')}
              onClick={() => void rebuild()}
            >
              <RotateCw size={15} aria-hidden="true" />
            </button>
          </label>
        </div>
        <ul id="workspace-search-result-list" className="workspace-search-result-list" aria-label={title}>
          {indexing && <li className="workspace-search-state">{t('rebuildingIndex')}</li>}
          {!indexing && normalizedQuery.length === 0 && <li className="workspace-search-state">{t('searchWorkspace')}</li>}
          {!indexing && normalizedQuery.length > 0 && !searching && results.length === 0 && (
            <li className="workspace-search-state">{t('noSearchResults')}</li>
          )}
          {results.map((result, index) => {
            const location = resultLocation(result);
            return (
              <li key={result.relativePath}>
                <button
                  ref={index === activeIndex ? activeResultRef : undefined}
                  id={`workspace-search-${result.relativePath}`}
                  type="button"
                  aria-current={index === activeIndex ? 'true' : undefined}
                  className="workspace-search-result"
                  data-relative-path={result.relativePath}
                  title={t('openSearchResult', { path: result.relativePath })}
                  onMouseMove={() => setActiveIndex(index)}
                  onClick={() => {
                    if (indexGeneration === null) return;
                    onSelect({ workspaceToken, workspaceRoot, indexGeneration, relativePath: result.relativePath });
                  }}
                >
                  <FileText size={16} aria-hidden="true" />
                  <span className="workspace-search-result-copy">
                    <strong>{resultLabel(result)}</strong>
                    <small>{result.relativePath}</small>
                    {result.snippet && <em>{result.snippet}</em>}
                  </span>
                  {location && <span className="workspace-search-result-location">{location}</span>}
                </button>
              </li>
            );
          })}
          {truncated && <li className="workspace-search-truncated">{t('resultsTruncated')}</li>}
        </ul>
      </dialog>
    </div>
  );
}
