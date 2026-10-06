import { countColumn, EditorState } from '@codemirror/state';
import type { Dispatch, SetStateAction } from 'react';
import { getEditorDocumentStats } from '../../lib/editorStatus';
import {
  DOCUMENT_STATS_DEBOUNCE_MS,
  DOCUMENT_STATS_IDLE_TIMEOUT_MS,
  type DeferredDocumentStatsTask,
  type EditorStatus,
} from './editorPaneTypes';

function getEditorCursorStatus(state: EditorState): Pick<EditorStatus, 'column' | 'line'> {
  const head = state.selection.main.head;
  const line = state.doc.lineAt(head);
  return {
    column: countColumn(line.text, 2, head - line.from) + 1,
    line: line.number,
  };
}

export function getEditorStatus(state: EditorState): EditorStatus {
  return {
    ...getEditorDocumentStats(state.doc.toString()),
    ...getEditorCursorStatus(state),
  };
}

function isSameEditorStatus(current: EditorStatus, next: EditorStatus): boolean {
  return current.characters === next.characters
    && current.column === next.column
    && current.line === next.line
    && current.lines === next.lines
    && current.words === next.words;
}

// 游标状态即时同步：仅在行列变化时更新，避免每次事务重渲染。
export function syncEditorCursorStatus(
  state: EditorState,
  setEditorStatus: Dispatch<SetStateAction<EditorStatus>>,
): void {
  const cursor = getEditorCursorStatus(state);
  setEditorStatus((current) => {
    const next = { ...current, ...cursor };
    return isSameEditorStatus(current, next) ? current : next;
  });
}

interface DeferredStatsState {
  deferredTask: DeferredDocumentStatsTask;
  pendingState: EditorState | null;
  version: number;
}

function cancelStatsTask(state: DeferredStatsState): void {
  const task = state.deferredTask;
  if (!task) return;
  if (task.kind === 'idle') {
    if (typeof cancelIdleCallback === 'function') cancelIdleCallback(task.id);
  } else {
    window.clearTimeout(task.id);
  }
  state.deferredTask = null;
}

function commitDocumentStats(
  state: DeferredStatsState,
  version: number,
  setEditorStatus: Dispatch<SetStateAction<EditorStatus>>,
): void {
  if (version !== state.version) return;
  state.deferredTask = null;
  const pending = state.pendingState;
  state.pendingState = null;
  if (!pending) return;
  const documentStats = getEditorDocumentStats(pending.doc.toString());
  setEditorStatus((current) => {
    const next = { ...current, ...documentStats };
    return isSameEditorStatus(current, next) ? current : next;
  });
}

function requestIdleStatsWork(
  state: DeferredStatsState,
  version: number,
  setEditorStatus: Dispatch<SetStateAction<EditorStatus>>,
): void {
  if (version !== state.version) return;
  state.deferredTask = null;
  if (typeof requestIdleCallback === 'function') {
    const id = requestIdleCallback(
      () => commitDocumentStats(state, version, setEditorStatus),
      { timeout: DOCUMENT_STATS_IDLE_TIMEOUT_MS },
    );
    state.deferredTask = { id, kind: 'idle' };
    return;
  }
  commitDocumentStats(state, version, setEditorStatus);
}

export interface DeferredStatsScheduler {
  dispose: () => void;
  schedule: (state: EditorState) => void;
}

// 延迟统计调度：输入防抖后走 requestIdleCallback（不支持时立即提交），版本号防陈旧。
export function createDeferredStatsScheduler(
  setEditorStatus: Dispatch<SetStateAction<EditorStatus>>,
): DeferredStatsScheduler {
  const state: DeferredStatsState = { deferredTask: null, pendingState: null, version: 0 };
  return {
    dispose: () => {
      state.version += 1;
      state.pendingState = null;
      cancelStatsTask(state);
    },
    schedule: (editorState: EditorState) => {
      state.pendingState = editorState;
      cancelStatsTask(state);
      state.version += 1;
      const version = state.version;
      const id = window.setTimeout(
        () => requestIdleStatsWork(state, version, setEditorStatus),
        DOCUMENT_STATS_DEBOUNCE_MS,
      );
      state.deferredTask = { id, kind: 'debounce' };
    },
  };
}
