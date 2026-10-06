/* eslint-disable react-hooks/exhaustive-deps -- 纯搬移：效果依赖保持提取前原样，由 WorkspaceSearchDialog.test.tsx 回归约束 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import type { WorkspaceIndexQueryKind, WorkspaceIndexQueryResult } from '../../types';
import {
  cancelWorkspaceIndexOperation,
  queryWorkspaceIndex,
  rebuildWorkspaceIndex,
} from '../../lib/tauriCommands';
import { createWorkspaceIndexOperationId } from '../../lib/workspaceSearch';
export type WorkspaceSearchMode = 'quick-open' | 'workspace-search';

export interface WorkspaceSearchSelection {
  workspaceToken: string;
  workspaceRoot: string;
  indexGeneration: number;
  relativePath: string;
}

const SEARCH_DEBOUNCE_MS = 160;

interface SearchOperationRefs {
  buildOperationRef: { current: string | null };
  queryOperationRef: { current: string | null };
  requestGenerationRef: { current: number };
}

function cancelOperation(operationId: string | null): void {
  if (!operationId) return;
  void cancelWorkspaceIndexOperation(operationId).catch(() => undefined);
}

// 索引重建：新的操作号使旧响应全部失效，就绪后记录索引世代。
function useIndexRebuild(deps: {
  onError: (error: unknown) => void;
  refs: SearchOperationRefs;
  resetResults: () => void;
  setIndexGeneration: (generation: number | null) => void;
  setIndexing: (indexing: boolean) => void;
  setSearching: (searching: boolean) => void;
  workspaceRoot: string;
  workspaceToken: string;
}): () => Promise<void> {
  const { onError, refs, resetResults, workspaceRoot, workspaceToken } = deps;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps 数组由下方显式列出
  return useCallback(async () => {
    cancelOperation(refs.buildOperationRef.current);
    cancelOperation(refs.queryOperationRef.current);
    const operationId = createWorkspaceIndexOperationId('rebuild');
    refs.buildOperationRef.current = operationId;
    refs.queryOperationRef.current = null;
    refs.requestGenerationRef.current += 1;
    deps.setIndexing(true);
    deps.setSearching(false);
    deps.setIndexGeneration(null);
    resetResults();
    try {
      const response = await rebuildWorkspaceIndex(workspaceToken, workspaceRoot, operationId);
      if (refs.buildOperationRef.current !== operationId) return;
      if (response.status === 'ready' && response.workspaceToken === workspaceToken) {
        deps.setIndexGeneration(response.indexGeneration);
      }
    } catch (error) {
      if (refs.buildOperationRef.current === operationId) onError(error);
    } finally {
      if (refs.buildOperationRef.current === operationId) {
        refs.buildOperationRef.current = null;
        deps.setIndexing(false);
      }
    }
  }, [onError, resetResults, workspaceRoot, workspaceToken]);
}

// 查询执行：响应需通过操作号/世代/索引世代/令牌四重校验后才落地。
function runDebouncedQuery(deps: {
  indexGeneration: number | null;
  normalizedQuery: string;
  onError: (error: unknown) => void;
  queryKind: WorkspaceIndexQueryKind;
  refs: SearchOperationRefs;
  requestGeneration: number;
  workspaceRoot: string;
  workspaceToken: string;
  setResults: (results: WorkspaceIndexQueryResult[]) => void;
  setSearching: (searching: boolean) => void;
  setTruncated: (truncated: boolean) => void;
}): void {
  const operationId = createWorkspaceIndexOperationId('query');
  deps.refs.queryOperationRef.current = operationId;
  deps.setSearching(true);
  void queryWorkspaceIndex(deps.workspaceToken, deps.workspaceRoot, operationId, {
    kind: deps.queryKind,
    text: deps.normalizedQuery,
  }).then((response) => {
    if (
      deps.refs.queryOperationRef.current !== operationId
      || deps.refs.requestGenerationRef.current !== deps.requestGeneration
      || response.status !== 'ready'
      || response.indexGeneration !== deps.indexGeneration
      || response.workspaceToken !== deps.workspaceToken
    ) return;
    deps.setResults(response.results);
    deps.setTruncated(response.truncated);
  }).catch((error: unknown) => {
    if (deps.refs.queryOperationRef.current === operationId && deps.refs.requestGenerationRef.current === deps.requestGeneration) {
      deps.onError(error);
    }
  }).finally(() => {
    if (deps.refs.queryOperationRef.current === operationId) {
      deps.refs.queryOperationRef.current = null;
      deps.setSearching(false);
    }
  });
}

// 防抖查询：操作号与请求世代双重防陈旧，索引世代不匹配的结果丢弃。
function useDebouncedIndexQuery(deps: {
  indexGeneration: number | null;
  normalizedQuery: string;
  onError: (error: unknown) => void;
  queryKind: WorkspaceIndexQueryKind;
  refs: SearchOperationRefs;
  setResults: (results: WorkspaceIndexQueryResult[]) => void;
  setSearching: (searching: boolean) => void;
  setTruncated: (truncated: boolean) => void;
  workspaceRoot: string;
  workspaceToken: string;
}): void {
  const { indexGeneration, normalizedQuery, onError, queryKind, refs, workspaceRoot, workspaceToken } = deps;
  useEffect(() => {
    cancelOperation(refs.queryOperationRef.current);
    refs.queryOperationRef.current = null;
    const requestGeneration = ++refs.requestGenerationRef.current;
    if (indexGeneration === null || !normalizedQuery) {
      deps.setSearching(false);
      deps.setResults([]);
      deps.setTruncated(false);
      return undefined;
    }

    const timer = window.setTimeout(() => {
      runDebouncedQuery({
        indexGeneration, normalizedQuery, onError, queryKind, refs, requestGeneration, workspaceRoot, workspaceToken,
        setResults: deps.setResults, setSearching: deps.setSearching, setTruncated: deps.setTruncated,
      });
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
      if (refs.queryOperationRef.current) cancelOperation(refs.queryOperationRef.current);
    };
  }, [indexGeneration, normalizedQuery, onError, queryKind, workspaceRoot, workspaceToken]);
}

// 选中当前激活结果：无结果或索引未就绪时忽略。
function selectSearchResult(deps: {
  activeIndex: number;
  indexGeneration: number | null;
  onSelect: (selection: WorkspaceSearchSelection) => void;
  results: WorkspaceIndexQueryResult[];
  workspaceRoot: string;
  workspaceToken: string;
}): void {
  const result = deps.results[deps.activeIndex];
  if (!result || deps.indexGeneration === null) return;
  deps.onSelect({
    workspaceToken: deps.workspaceToken,
    workspaceRoot: deps.workspaceRoot,
    indexGeneration: deps.indexGeneration,
    relativePath: result.relativePath,
  });
}

// 列表行为：查询或结果变化重置激活项、激活行滚动可见、挂载聚焦输入。
function useSearchListBehaviors(
  state: {
    activeIndex: number;
    activeResultRef: RefObject<HTMLButtonElement | null>;
    inputRef: RefObject<HTMLInputElement | null>;
    query: string;
    results: WorkspaceIndexQueryResult[];
  },
  setActiveIndex: Dispatch<SetStateAction<number>>,
): void {
  const { activeIndex, activeResultRef, inputRef, query, results } = state;
  useEffect(() => {
    setActiveIndex(0);
  }, [query, results]);
  useEffect(() => {
    activeResultRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [activeIndex, results]);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
}

// 工作区搜索控制器：索引重建、防抖查询、结果/激活态与输入引用。
export function useWorkspaceSearchResults(deps: {
  mode: WorkspaceSearchMode;
  onError: (error: unknown) => void;
  onSelect: (selection: WorkspaceSearchSelection) => void;
  workspaceRoot: string;
  workspaceToken: string;
}) {
  const { mode, onError, onSelect, workspaceRoot, workspaceToken } = deps;
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<WorkspaceIndexQueryResult[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [indexGeneration, setIndexGeneration] = useState<number | null>(null);
  const [indexing, setIndexing] = useState(true), [searching, setSearching] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null), activeResultRef = useRef<HTMLButtonElement>(null);

  const buildOperationRef = useRef<string | null>(null), queryOperationRef = useRef<string | null>(null);
  const requestGenerationRef = useRef(0);
  const refs: SearchOperationRefs = { buildOperationRef, queryOperationRef, requestGenerationRef };
  const resetResults = useCallback(() => { setResults([]); setTruncated(false); setActiveIndex(0); }, []);
  const rebuild = useIndexRebuild({
    onError, refs, resetResults, workspaceRoot, workspaceToken,
    setIndexGeneration, setIndexing, setSearching, });

  useEffect(() => {
    void rebuild();
    return () => {
      cancelOperation(refs.buildOperationRef.current);
      cancelOperation(refs.queryOperationRef.current);
      refs.buildOperationRef.current = null; refs.queryOperationRef.current = null;
    };
  }, [rebuild]);
  useSearchListBehaviors({ activeIndex, activeResultRef, inputRef, query, results }, setActiveIndex);

  const queryKind: WorkspaceIndexQueryKind = mode === 'quick-open' ? 'filename' : 'fullText';
  const normalizedQuery = query.trim();

  useDebouncedIndexQuery({
    indexGeneration, normalizedQuery, onError, queryKind, refs, workspaceRoot, workspaceToken,
    setResults, setSearching, setTruncated, });


  const selectActiveResult = useCallback(
    () => selectSearchResult({ activeIndex, indexGeneration, onSelect, results, workspaceRoot, workspaceToken }),
    [activeIndex, indexGeneration, onSelect, results, workspaceRoot, workspaceToken]);

  return {
    activeIndex, activeResultRef, indexGeneration, indexing, inputRef, normalizedQuery, query,
    rebuild, results, searching, selectActiveResult, setActiveIndex, setQuery, truncated, };
}
