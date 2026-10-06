import { useCallback } from 'react';
import { normalizeAppError } from '../../lib/appFeedback';
import type { EffectiveLocale } from '../../lib/locale';
import {
  createWorkspaceIndexOperationId } from '../../lib/workspaceSearch';
import { discardWorkspaceIndex, rebuildWorkspaceIndex } from '../../lib/tauriCommands';
import type { WorkspaceUiStates } from './workspaceDialogStates';
import type {
  WorkspaceSearchMode,
  WorkspaceSearchSelection } from './WorkspaceSearchDialog';

// 工作区搜索/索引动作：快捷打开与全工作区搜索入口 + 设置页里的索引重建/丢弃。
export function useWorkspaceSearchActions(deps: {
  enqueueLocalOpenIntent: (
    source: 'workspace_search',
    displayPath: string,
    action: { kind: 'workspace_search_result'; selection: WorkspaceSearchSelection },
  ) => void;
  locale: EffectiveLocale;
  modalActive: boolean;
  onDismissSettings: () => void;
  setError: (message: string | null) => void;
  setNotice: (message: string | null) => void;
  translate: (key: 'searchUnavailable' | 'workspaceIndexDiscarded' | 'workspaceIndexRebuilt') => string;
  states: Pick<
    WorkspaceUiStates,
    'setWorkspaceIndexActionBusy' | 'setWorkspaceSearchMode' | 'workspaceIndexActionBusy' | 'workspaceSearchMode'
  >;
  workspaceRoot: string | null;
  workspaceToken: string | null;
}) {
  const { setWorkspaceIndexActionBusy, setWorkspaceSearchMode, workspaceIndexActionBusy, workspaceSearchMode } = deps.states;
  const { translate } = deps;
  const session = {
    locale: deps.locale,
    onDismissSettings: deps.onDismissSettings,
    setError: deps.setError,
    setNotice: deps.setNotice,
    translate,
    workspaceRoot: deps.workspaceRoot,
    workspaceToken: deps.workspaceToken };

  const runWorkspaceIndexAction = useWorkspaceIndexAction(session, setWorkspaceIndexActionBusy);

  const discardCurrentWorkspaceIndex = useCallback(() => runWorkspaceIndexAction('discard'), [runWorkspaceIndexAction]);
  const rebuildCurrentWorkspaceIndex = useCallback(() => runWorkspaceIndexAction('rebuild'), [runWorkspaceIndexAction]);


  const showWorkspaceSearchDialog = useWorkspaceSearchDialogOpener(
    deps, setWorkspaceSearchMode, translate);
  const requestWorkspaceSearchOpen = useWorkspaceSearchOpenRequest(deps, setWorkspaceSearchMode);

  return {
    discardCurrentWorkspaceIndex,
    rebuildCurrentWorkspaceIndex,
    requestWorkspaceSearchOpen,
    setWorkspaceSearchMode,
    showWorkspaceSearchDialog,
    workspaceIndexActionBusy,
    workspaceSearchMode };
}

function useWorkspaceSearchDialogOpener(
  deps: Parameters<typeof useWorkspaceSearchActions>[0],
  setWorkspaceSearchMode: (mode: WorkspaceSearchMode | null) => void,
  translate: (key: 'searchUnavailable') => string,
) {
  return useCallback((mode: WorkspaceSearchMode) => {
    if (deps.modalActive) return;
    if (!deps.workspaceRoot || !deps.workspaceToken) {
      deps.setError(translate('searchUnavailable'));
      deps.setNotice(null);
      return;
    }
    setWorkspaceSearchMode(mode);
  }, [deps, setWorkspaceSearchMode, translate]);
}

function useWorkspaceSearchOpenRequest(
  deps: Parameters<typeof useWorkspaceSearchActions>[0],
  setWorkspaceSearchMode: (mode: WorkspaceSearchMode | null) => void,
) {
  return useCallback((selection: WorkspaceSearchSelection) => {
    setWorkspaceSearchMode(null);
    deps.setError(null);
    deps.setNotice(null);
    deps.enqueueLocalOpenIntent(
      'workspace_search',
      selection.relativePath,
      { kind: 'workspace_search_result', selection },
    );
  }, [deps, setWorkspaceSearchMode]);
}

function useWorkspaceIndexAction(
  deps: Parameters<typeof useWorkspaceSearchActions>[0] extends infer _ ? {
    locale: EffectiveLocale;
    onDismissSettings: () => void;
    setError: (message: string | null) => void;
    setNotice: (message: string | null) => void;
    translate: (key: 'workspaceIndexDiscarded' | 'workspaceIndexRebuilt') => string;
    workspaceRoot: string | null;
    workspaceToken: string | null;
  } : never,
  setBusy: (busy: boolean) => void,
) {
  return useCallback(async (action: 'discard' | 'rebuild') => {
    if (!deps.workspaceRoot || !deps.workspaceToken) return;
    setBusy(true);
    try {
      if (action === 'discard') {
        await discardWorkspaceIndex(deps.workspaceToken, deps.workspaceRoot);
      } else {
        const response = await rebuildWorkspaceIndex(
          deps.workspaceToken,
          deps.workspaceRoot,
          createWorkspaceIndexOperationId('rebuild'),
        );
        if (response.status !== 'ready') {
          throw new Error('Workspace index rebuild did not complete');
        }
      }
      deps.onDismissSettings();
      deps.setError(null);
      deps.setNotice(deps.translate(action === 'discard' ? 'workspaceIndexDiscarded' : 'workspaceIndexRebuilt'));
    } catch (err) {
      deps.onDismissSettings();
      deps.setError(normalizeAppError(err, deps.locale));
      deps.setNotice(null);
    } finally {
      setBusy(false);
    }
  }, [deps, setBusy]);
}
