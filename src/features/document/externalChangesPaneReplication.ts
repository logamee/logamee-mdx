/* eslint-disable react-hooks/exhaustive-deps -- 纯搬移：依赖数组逐项保持提取前原样，由 useDocumentSession.test.tsx 回归约束 */
import { useCallback, useEffect } from 'react';
import { createTauriPaneReplication } from '../../lib/tauriPaneReplication';
import { isEditableFileKind } from '../../lib/documentSession';
import { normalizeAppError } from '../../lib/appFeedback';
import type { PaneSnapshotEnvelope, ReplicaRole } from '../../lib/paneSync';
import type { ExternalChangesDeps } from './externalChangesTypes';

// 窗格复制：主窗广播权威态，弹出窗接受快照并落盘会话状态。
export function useExternalChangesPaneReplication(deps: ExternalChangesDeps) {
  const {
    applyDocumentSessionState, isPopout, localeRef, paneReplicationRef, paneStateRef,
    paneState, popoutPane, setError } = deps;

    const replicationRole: ReplicaRole = isPopout
      ? popoutPane === 'editor' ? 'editor-popout' : 'preview-popout'
      : 'main';
    const applyReplicatedPaneSnapshot = useCallback((snapshot: PaneSnapshotEnvelope) => {
      applyMainWindowState(deps, snapshot);
    }, [applyDocumentSessionState, isPopout]);

    const broadcastPaneState = useCallback(async () => {
      paneReplicationRef.current?.publishAuthoritativeState(paneStateRef.current);
    }, []);

    useEffect(() => {
      const replication = createTauriPaneReplication({
        role: replicationRole,
        observe: applyReplicatedPaneSnapshot,
        onError: (error) => setError(normalizeAppError(error, localeRef.current)),
      });
      paneReplicationRef.current = replication;
      replication.start();

      return () => {
        if (paneReplicationRef.current === replication) paneReplicationRef.current = null;
        replication.dispose();
      };
    }, [applyReplicatedPaneSnapshot, replicationRole]);

    useEffect(() => {
      if (!isPopout) void broadcastPaneState();
    }, [broadcastPaneState, isPopout, paneState]);


  return { broadcastPaneState };
}

function applyMainWindowState(
  deps: Parameters<typeof useExternalChangesPaneReplication>[0],
  snapshot: PaneSnapshotEnvelope,
): void {
  const { applyDocumentSessionState, isPopout, paneStateRef, setContent, setWorkspaceRoot } = deps;
  const next = snapshot.state;
  if (!isPopout) {
    if ((next.authorityStatus ?? 'unknown') === 'committed'
      && isEditableFileKind(next.activeFileKind)) {
      paneStateRef.current = {
        ...paneStateRef.current,
        content: next.content,
      };
      setContent(next.content);
    }
    return;
  }

  applyDocumentSessionState({
    ...next,
    bytesBase64: next.bytesBase64 ?? null,
    previewRevision: next.previewRevision,
    authorityStatus: next.authorityStatus ?? 'unknown',
  });
  paneStateRef.current = {
    ...paneStateRef.current,
    workspaceRoot: next.workspaceRoot,
  };
  setWorkspaceRoot(next.workspaceRoot);
}
