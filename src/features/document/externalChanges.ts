/* eslint-disable react-hooks/exhaustive-deps -- 纯搬移：依赖数组逐项保持提取前原样，由 useDocumentSession.test.tsx 回归约束 */
import { useExternalChangesWorkspace } from './externalChangesWorkspace';
import { useExternalChangesWatchHandlers } from './externalChangesWatchHandlers';
import { useExternalChangesWatchRuntime } from './externalChangesWatchRuntime';
import { useExternalChangesPaneReplication } from './externalChangesPaneReplication';
import type { ExternalChangesDeps } from './externalChangesTypes';

export type { ExternalChangesDeps } from './externalChangesTypes';

export function useExternalChanges(deps: ExternalChangesDeps) {
  const workspaceSession = useExternalChangesWorkspace(deps);
  const {
    flushWorkspaceSession,
    getActiveWorkspace,
    isCurrentWorkspaceRequest,
    reconcileRequestedWorkspaceReceipt,
    refreshWorkspace,
    refreshWorkspaceAfterExternalPathChange,
    refreshWorkspaceDirect,
    settleWorkspaceSessionRestore } = workspaceSession;
  const watchHandlers = useExternalChangesWatchHandlers(deps, workspaceSession);
  const {
    applyExternalDocumentDecision,
    envelopeMatchesAcceptedPath,
    isAcceptedWatchCurrent,
    setExternalFileActionState,
    stopAcceptedActiveDocumentWatch } = watchHandlers;
  const watchRuntime = useExternalChangesWatchRuntime(deps, watchHandlers);
  const {
    enqueueActiveDocumentWatchEnvelope,
    enqueueActiveDocumentWatchHealth,
    handleActiveDocumentWatchEvent } = watchRuntime;
  const paneReplication = useExternalChangesPaneReplication(deps);
  const { broadcastPaneState } = paneReplication;
  return {
    broadcastPaneState,
    flushWorkspaceSession,
    refreshWorkspace,
    getActiveWorkspace,
    isCurrentWorkspaceRequest,
    refreshWorkspaceDirect,
    reconcileRequestedWorkspaceReceipt,
    settleWorkspaceSessionRestore,
    setExternalFileActionState,
    stopAcceptedActiveDocumentWatch,
    isAcceptedWatchCurrent,
    envelopeMatchesAcceptedPath,
    refreshWorkspaceAfterExternalPathChange,
    applyExternalDocumentDecision,
    enqueueActiveDocumentWatchEnvelope,
    enqueueActiveDocumentWatchHealth,
    handleActiveDocumentWatchEvent };
}
