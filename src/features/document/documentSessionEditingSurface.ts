/* eslint-disable react-hooks/exhaustive-deps -- 子模块输出经解构进入回调，插件无法跨 deps 对象静态追踪；依赖数组保持搬移前原样，由 useDocumentSession.test.tsx 回归约束 */
import { useCallback, useMemo } from 'react';
import { isEditableFileKind } from '../../lib/documentSession';
import type {
  DocumentSaveConflictDialogState,
  ExternalFileActionDialogState,
} from './dialogState';
import { useAutosaveSession } from './autosaveSession';
import type { DocumentSessionStores } from './documentSessionStores';
import type { DocumentSessionCore, DocumentSessionDerived } from './documentSessionRuntime';
import type { SaveFlowSessionApi } from './documentSessionComposition';

function useDocumentDialogsState(stores: DocumentSessionStores) {
  const { externalFileAction, externalFileActionBusy, saveConflict } = stores;
  const externalFileActionDialog = useMemo<ExternalFileActionDialogState | null>(() => {
    if (!externalFileAction) return null;
    const path = externalFileAction.envelope.snapshot.status === 'present'
      ? externalFileAction.envelope.snapshot.file.path
      : externalFileAction.envelope.snapshot.path;
    return {
      busy: externalFileActionBusy,
      kind: externalFileAction.kind,
      path,
    };
  }, [externalFileAction, externalFileActionBusy]);

  const saveConflictDialog = useMemo<DocumentSaveConflictDialogState | null>(() => (
    saveConflict ? { busy: saveConflict.busy, path: saveConflict.path } : null
  ), [saveConflict]);
  return { externalFileActionDialog, saveConflictDialog };
}

export function useDocumentEditingSurface(
  stores: DocumentSessionStores,
  derived: DocumentSessionDerived,
  core: DocumentSessionCore,
  save: SaveFlowSessionApi,
) {
  const {
    activeFileKind, activePath, activeFileVersionRef, autosaveBlockedContent,
    autosaveBlockedContentRef, autosaveDelayMs, autosaveEnabled, autosaveMode, authorityStatus,
    busy, busyRef, content, externalFileAction, externalFileActionRef,
    isPopout, paneReplicationRef, popoutPane, saveConflict, saveConflictRef, setAutosaveBlockedContent,
    setContent,
  } = stores;
  const { dirty, paneStateRef } = derived;
  const { currentDocumentSessionState } = core;
  const { saveCurrentDocument } = save;

  const updateContent = useCallback((nextContent: string) => {
    if (
      !isPopout
      && !stores.workspaceSessionRestoreSettledRef.current
      && stores.activePathRef.current === null
    ) return;
    const document = currentDocumentSessionState();
    if (document.authorityStatus !== 'committed'
      || !isEditableFileKind(document.activeFileKind)) return;
    paneStateRef.current = {
      ...paneStateRef.current,
      content: nextContent,
    };
    setContent(nextContent);
    setAutosaveBlockedContent(null);
    if (isPopout && popoutPane === 'editor') {
      paneReplicationRef.current?.publishEditorContent(nextContent);
    }
  }, [currentDocumentSessionState, isPopout, popoutPane]);

  const { externalFileActionDialog, saveConflictDialog } = useDocumentDialogsState(stores);

  useAutosaveSession({
    activeFileKind, activePath, activeFileVersionRef, autosaveBlockedContent,
    autosaveBlockedContentRef, autosaveDelayMs, autosaveEnabled, autosaveMode, authorityStatus,
    busy, busyRef, content, dirty, externalFileAction, externalFileActionRef, isPopout,
    paneStateRef, saveConflict, saveConflictRef, saveCurrentDocument,
  });

  return { externalFileActionDialog, saveConflictDialog, updateContent };
}
