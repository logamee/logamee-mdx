import {
  discardOpenReceipt,
  
  openFileDialog,
  openRecentFile,
  openWorkspaceFile,
  openWorkspaceIndexResult as openNativeWorkspaceIndexResult } from '../../lib/tauriCommands';
import { createPaneProtocolId } from '../../lib/tauriPaneReplication';
import {
  
  getOpenedDocumentState,
  isCurrentWorkspaceIdentity } from '../../lib/documentSession';
import { editableFileVersion } from './sessionFacts';
import type { OpenIntentDeps } from './openIntentTypes';
import type { ActiveWorkspaceIdentity, PreparedOpenApplyResult } from './sessionTypes';
import type { OpenFileResponse, PreparedOpenFileResponse } from '../../types';

interface PreparedOpenHandles {
  applyPreparedOpen: (prepared: PreparedOpenFileResponse, generation: number) => Promise<PreparedOpenApplyResult>;
  claimPreparedOpen: (prepared: PreparedOpenFileResponse | null, generation: number) => number | null;
}

async function claimAndApplyPrepared(
  handles: PreparedOpenHandles,
  prepared: PreparedOpenFileResponse | null,
  generation: number,
): Promise<void> {
  const appliedGeneration = handles.claimPreparedOpen(prepared, generation);
  if (prepared && appliedGeneration !== null) {
    await handles.applyPreparedOpen(prepared, appliedGeneration);
  }
}

function preparedOpenIsStale(
  deps: OpenIntentDeps,
  requested: {
    open: number;
    documentGeneration: number;
    workspace?: { identity: ActiveWorkspaceIdentity; generation: number };
  },
): boolean {
  if (deps.documentOpenRequestRef.current !== requested.open) return true;
  if (deps.documentGenerationRef.current !== requested.documentGeneration) return true;
  if (requested.workspace !== undefined
    && !deps.isCurrentWorkspaceRequest(requested.workspace.identity, requested.workspace.generation)) {
    return true;
  }
  return false;
}


export async function openWorkspaceFilePathBody(
  path: string,
  deps: OpenIntentDeps,
  handles: PreparedOpenHandles,
): Promise<void> {
  const { executeSessionOperation, documentGenerationRef, documentOpenRequestRef, getActiveWorkspace, ordinaryDocumentActionsBlocked, workspaceGenerationRef } = deps;

      if (ordinaryDocumentActionsBlocked()) return;
      const requestedWorkspace = getActiveWorkspace();
      if (!requestedWorkspace) return;
      const requestedWorkspaceGeneration = workspaceGenerationRef.current;
      const requestedDocumentGeneration = documentGenerationRef.current;
      const requestedOpen = ++documentOpenRequestRef.current;

      await executeSessionOperation({
        run: () => openWorkspaceFile(path),
        consume: async (prepared: PreparedOpenFileResponse) => {
          if (preparedOpenIsStale(deps, {
            open: requestedOpen,
            documentGeneration: requestedDocumentGeneration,
            workspace: { identity: requestedWorkspace, generation: requestedWorkspaceGeneration },
          })) {
            await discardOpenReceipt(prepared.open_receipt).catch(() => undefined);
          }
        },
        isCurrent: () => !preparedOpenIsStale(deps, {
          open: requestedOpen,
          documentGeneration: requestedDocumentGeneration,
          workspace: { identity: requestedWorkspace, generation: requestedWorkspaceGeneration },
        }),
        apply: (prepared) => claimAndApplyPrepared(handles, prepared, requestedDocumentGeneration),
      });
}

export async function openWorkspaceIndexResultBody(
  request: { workspaceToken: string; workspaceRoot: string; indexGeneration: number; relativePath: string },
  deps: OpenIntentDeps,
  handles: PreparedOpenHandles,
): Promise<void> {
  const { executeSessionOperation, documentGenerationRef, documentOpenRequestRef, getActiveWorkspace, ordinaryDocumentActionsBlocked, workspaceGenerationRef } = deps;
  const { workspaceToken, workspaceRoot, indexGeneration, relativePath } = request;

      if (ordinaryDocumentActionsBlocked()) return;
      const requestedWorkspace = getActiveWorkspace();
      if (
        !requestedWorkspace
        || !isCurrentWorkspaceIdentity(requestedWorkspace, { workspaceToken, workspaceRoot })
      ) return;
      const requestedWorkspaceGeneration = workspaceGenerationRef.current;
      const requestedDocumentGeneration = documentGenerationRef.current;
      const requestedOpen = ++documentOpenRequestRef.current;

      await executeSessionOperation({
        run: () => openNativeWorkspaceIndexResult(
          workspaceToken,
          workspaceRoot,
          indexGeneration,
          relativePath,
        ),
        consume: async (prepared: PreparedOpenFileResponse) => {
          if (preparedOpenIsStale(deps, {
            open: requestedOpen,
            documentGeneration: requestedDocumentGeneration,
            workspace: { identity: requestedWorkspace, generation: requestedWorkspaceGeneration },
          })) {
            await discardOpenReceipt(prepared.open_receipt).catch(() => undefined);
          }
        },
        isCurrent: () => !preparedOpenIsStale(deps, {
          open: requestedOpen,
          documentGeneration: requestedDocumentGeneration,
          workspace: { identity: requestedWorkspace, generation: requestedWorkspaceGeneration },
        }),
        apply: (prepared) => claimAndApplyPrepared(handles, prepared, requestedDocumentGeneration),
      });
}

export async function handleOpenFileBody(
  deps: OpenIntentDeps,
    handles: PreparedOpenHandles,
): Promise<void> {
  const { documentGenerationRef, documentOpenRequestRef, executeSessionOperation, ordinaryDocumentActionsBlocked } = deps;

      if (ordinaryDocumentActionsBlocked()) return;
      const requestedDocumentGeneration = documentGenerationRef.current;
      const requestedOpen = ++documentOpenRequestRef.current;
      await executeSessionOperation({
        run: openFileDialog,
        consume: async (prepared: PreparedOpenFileResponse | null) => {
          if (prepared
            && preparedOpenIsStale(deps, { open: requestedOpen, documentGeneration: requestedDocumentGeneration })) {
            await discardOpenReceipt(prepared.open_receipt).catch(() => undefined);
          }
        },
        isCurrent: () => !preparedOpenIsStale(deps, { open: requestedOpen, documentGeneration: requestedDocumentGeneration }),
        apply: (prepared) => claimAndApplyPrepared(handles, prepared, requestedDocumentGeneration),
      });
}

export async function handleOpenRecentBody(
  entryId: string,
  deps: OpenIntentDeps,
    handles: PreparedOpenHandles,
): Promise<void> {
  const { documentGenerationRef, documentOpenRequestRef, executeSessionOperation, ordinaryDocumentActionsBlocked } = deps;

      if (ordinaryDocumentActionsBlocked()) return;
      const requestedDocumentGeneration = documentGenerationRef.current;
      const requestedOpen = ++documentOpenRequestRef.current;
      await executeSessionOperation({
        run: () => openRecentFile(entryId),
        consume: async (prepared: PreparedOpenFileResponse) => {
          if (preparedOpenIsStale(deps, { open: requestedOpen, documentGeneration: requestedDocumentGeneration })) {
            await discardOpenReceipt(prepared.open_receipt).catch(() => undefined);
          }
        },
        isCurrent: () => !preparedOpenIsStale(deps, { open: requestedOpen, documentGeneration: requestedDocumentGeneration }),
        apply: (prepared) => claimAndApplyPrepared(handles, prepared, requestedDocumentGeneration),
      });
}

export function applyOpenFileResponseBody(response: OpenFileResponse, deps: OpenIntentDeps): void {
  const { activeFileVersionRef, applyDocumentSessionState, currentDocumentSessionState } = deps;
  const current = currentDocumentSessionState();
      applyDocumentSessionState({
        ...getOpenedDocumentState(response),
        documentId: createPaneProtocolId('pane-document'),
        documentEpoch: current.documentEpoch + 1,
        authorityStatus: 'committed',
      });
      activeFileVersionRef.current = editableFileVersion(response);
}
