/* eslint-disable react-hooks/exhaustive-deps -- 纯搬移：依赖数组逐项保持提取前原样，由 useDocumentSession.test.tsx 回归约束 */
import { useCallback } from 'react';
import type { PendingDocumentSaveConflict } from './sessionTypes';
import { displayName } from '../../lib/documentNames';
import { createDocumentSaveOperationId, isEditableFileKind } from '../../lib/documentSession';
import { saveAsDialog, writeFile } from '../../lib/tauriCommands';
import { applySaveAsOutcome, applySameFileOutcome } from './saveFlowApply';
import type { SaveFlowDeps } from './saveFlowTypes';

export type { SaveFlowDeps } from './saveFlowTypes';

export function useSaveFlow(deps: SaveFlowDeps) {
  const { currentDocumentSessionState, ordinaryDocumentActionsBlocked } = deps;







    const { saveDocumentAs } = useSaveDocumentAs(deps);
    const { saveCurrentDocument } = useSaveCurrentDocument(deps, saveDocumentAs);
    const handleSave = useCallback(async () => {
      if (ordinaryDocumentActionsBlocked()) return;
      await saveCurrentDocument();
    }, [ordinaryDocumentActionsBlocked, saveCurrentDocument]);

    const handleSaveAs = useCallback(async () => {
      if (ordinaryDocumentActionsBlocked()) return;
      const document = currentDocumentSessionState();
      if (document.authorityStatus !== 'committed'
        || !isEditableFileKind(document.activeFileKind)) return;
      await saveDocumentAs(displayName(document.activePath));
    }, [currentDocumentSessionState, ordinaryDocumentActionsBlocked, saveDocumentAs]);

  return { saveDocumentAs, saveCurrentDocument, handleSave, handleSaveAs };
}


export function useSaveFlowState(deps: Pick<SaveFlowDeps, 'saveConflictRef' | 'setSaveConflict' | 'paneStateRef' | 'setAuthorityStatus'>) {
  const { saveConflictRef, setSaveConflict, paneStateRef, setAuthorityStatus } = deps;

  const setSaveConflictState = useCallback((next: PendingDocumentSaveConflict | null) => {
    saveConflictRef.current = next;
    setSaveConflict(next);
  }, []);

  const lockDocumentAuthorityUnknown = useCallback(() => {
    paneStateRef.current = { ...paneStateRef.current, authorityStatus: 'unknown' };
    setAuthorityStatus('unknown');
  }, []);

  return { setSaveConflictState, lockDocumentAuthorityUnknown };
}

function useSaveDocumentAs(deps: SaveFlowDeps) {
  const {
    activePathRef, documentGenerationRef, executeSessionOperation, getActiveWorkspace,
    paneStateRef, workspaceGenerationRef } = deps;

    const saveDocumentAs = useCallback(async (
      defaultName: string,
      allowExternalRecovery = false,
    ): Promise<boolean> => {
      const precheck = saveAsPrecheck(deps, allowExternalRecovery);
      if (precheck.kind === 'blocked') return false;
      if (precheck.kind === 'not-editable') return true;
      const { contentToSave, document, sourcePath } = precheck;
      const requestedDocumentGeneration = documentGenerationRef.current;
      const requestedWorkspace = getActiveWorkspace();
      const requestedWorkspaceGeneration = workspaceGenerationRef.current;
      const operationId = createDocumentSaveOperationId();

      const result = await executeSessionOperation({
        run: () => saveAsDialog(
          contentToSave,
          defaultName,
          operationId,
          document.activeFileKind === 'excalidraw' ? 'excalidraw' : undefined,
        ),
        isCurrent: () => documentGenerationRef.current === requestedDocumentGeneration
          && activePathRef.current === sourcePath,
        apply: (outcome) => applySaveAsOutcome(outcome, {
          deps,
          allowExternalRecovery,
          contentToSave,
          document,
          operationId,
          requestedDocumentGeneration,
          requestedWorkspace,
          requestedWorkspaceGeneration,
          sourcePath }),
      });

      return result?.status === 'applied'
        && result.value?.status === 'confirmed_committed'
        && paneStateRef.current.content === contentToSave;
    }, [deps, executeSessionOperation]);

  return { saveDocumentAs };
}

function useSaveCurrentDocument(
  deps: SaveFlowDeps,
  saveDocumentAs: (defaultName: string, allowExternalRecovery?: boolean) => Promise<boolean>,
): { saveCurrentDocument: () => Promise<boolean> } {
  const {
    executeSessionOperation,
    paneStateRef } = deps;

    const saveCurrentDocument = useCallback(async (): Promise<boolean> => {
      const precheck = sameFileSavePrecheck(deps);
      if (precheck.kind === 'blocked') return false;
      if (precheck.kind === 'not-editable') return true;
      if (precheck.kind === 'needs-save-as') {
        return saveDocumentAs(precheck.defaultName);
      }
      const { contentToSave, document, expectedVersion, pathToSave } = precheck;
      const result = await executeSessionOperation(writeCurrentFileOperation({
        contentToSave,
        deps,
        document,
        expectedVersion,
        pathToSave,
        precheck }));
      const saved = result?.status === 'applied'
        && result.value.status === 'confirmed_committed'
        && paneStateRef.current.content === contentToSave;
      if (!saved) deps.setAutosaveBlockedContent(contentToSave);
      return saved;
    }, [deps, executeSessionOperation, saveDocumentAs]);

  return { saveCurrentDocument };
}

type SaveAsPrecheck =
  | { kind: 'blocked' }
  | { kind: 'not-editable' }
  | { kind: 'ready'; contentToSave: string; document: ReturnType<SaveFlowDeps['currentDocumentSessionState']>; sourcePath: string | null };

function saveAsPrecheck(deps: SaveFlowDeps, allowExternalRecovery: boolean): SaveAsPrecheck {
  if (deps.isPopout || (!allowExternalRecovery && deps.ordinaryDocumentActionsBlocked())) {
    return { kind: 'blocked' };
  }
  const document = deps.currentDocumentSessionState();
  if (!isEditableFileKind(document.activeFileKind)) return { kind: 'not-editable' };
  if (document.authorityStatus !== 'committed') return { kind: 'blocked' };
  return { kind: 'ready', contentToSave: document.content, document, sourcePath: document.activePath };
}

type SameFileSavePrecheck =
  | { kind: 'blocked' }
  | { kind: 'not-editable' }
  | { kind: 'needs-save-as'; defaultName: string }
  | {
      kind: 'ready';
      contentToSave: string;
      document: ReturnType<SaveFlowDeps['currentDocumentSessionState']>;
      expectedVersion: NonNullable<SaveFlowDeps['activeFileVersionRef']['current']>;
      pathToSave: string;
    };

function sameFileSavePrecheck(deps: SaveFlowDeps): SameFileSavePrecheck {
  if (deps.isPopout || deps.ordinaryDocumentActionsBlocked()) return { kind: 'blocked' };
  const document = deps.currentDocumentSessionState();
  if (!isEditableFileKind(document.activeFileKind)) return { kind: 'not-editable' };
  if (document.authorityStatus !== 'committed') return { kind: 'blocked' };
  const pathToSave = document.activePath;
  if (!pathToSave) {
    return {
      kind: 'needs-save-as',
      defaultName: document.activeFileKind === 'excalidraw' ? 'Untitled.excalidraw' : 'Untitled.md' };
  }
  const expectedVersion = deps.activeFileVersionRef.current;
  if (!expectedVersion) {
    deps.setError('The current file version is unavailable. Reopen the document before saving.');
    return { kind: 'blocked' };
  }
  return { kind: 'ready', contentToSave: document.content, document, expectedVersion, pathToSave };
}

function writeCurrentFileOperation(ctx: {
  contentToSave: string;
  deps: SaveFlowDeps;
  document: ReturnType<SaveFlowDeps['currentDocumentSessionState']>;
  expectedVersion: NonNullable<SaveFlowDeps['activeFileVersionRef']['current']>;
  pathToSave: string;
  precheck: SameFileSavePrecheck;
}) {
  const { deps } = ctx;
  const requestedDocumentGeneration = deps.documentGenerationRef.current;
  const requestedWorkspace = deps.getActiveWorkspace();
  const requestedWorkspaceGeneration = deps.workspaceGenerationRef.current;
  const operationId = createDocumentSaveOperationId();
  return {
    run: () => writeFile(ctx.pathToSave, ctx.contentToSave, ctx.expectedVersion, operationId),
    isCurrent: () => deps.documentGenerationRef.current === requestedDocumentGeneration
      && deps.activePathRef.current === ctx.pathToSave,
    apply: (outcome: Awaited<ReturnType<typeof writeFile>>) => applySameFileOutcome(outcome, {
      deps,
      contentToSave: ctx.contentToSave,
      documentId: ctx.document.documentId,
      operationId,
      pathToSave: ctx.pathToSave,
      requestedDocumentGeneration,
      requestedWorkspace,
      requestedWorkspaceGeneration }),
  };
}
