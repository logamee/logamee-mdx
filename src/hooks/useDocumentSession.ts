import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { buildWorkspaceFileTree } from '../lib/fileTree';
import { displayName, EMPTY_MARKDOWN } from '../lib/documentNames';
import {
  createTauriActiveDocumentWatchTransport,
  isTauriRuntime,
  type ActiveDocumentWatchEvent,
  type ActiveDocumentWatchSnapshotEnvelope,
  type ActiveDocumentWatchTransport,
} from '../lib/activeDocumentWatch';
import {
  createDocumentSessionQueue,
  type DocumentSessionQueueOperation,
  type DocumentSessionQueueResult,
} from '../lib/documentSessionQueue';
import {
  applyWorkspaceSelection,
  createProvisionalDocumentTransition,
  createDocumentSaveOperationId,
  createWorkspaceDirectoryAndReconcile,
  deleteWorkspaceEntryAndReconcile,
  getEditableFileKindForPath,
  getMutationOutcomeMessage,
  getOpenedDocumentState,
  isCurrentWorkspaceIdentity,
  isDocumentDirty,
  isEditableFileKind,
  moveWorkspaceEntryAndReconcile,
  nextPreparedOpenGeneration,
  renameWorkspaceEntryAndReconcile,
  reconcileWorkspaceReceipt,
  resolveOpenCommitOutcome,
  restoreDocumentSnapshot,
  type DocumentAuthorityStatus,
  type DocumentSessionState,
  type WorkspaceIdentity,
} from '../lib/documentSession';
import {
  coalesceExternalConflict,
  reduceExternalDocumentChange,
  resolveKeepCurrent,
  resolveUseExternal,
  type ExternalDocumentChangeDecision,
} from '../lib/externalDocumentChange';
import type { PaneReplicatedState, PaneSnapshotEnvelope, ReplicaRole } from '../lib/paneSync';
import { normalizeAppError } from '../lib/appFeedback';
import {
  createCrashDraftDocumentId,
  createCrashDraftScheduler,
  type CrashDraftRecoverResponse,
  type CrashDraftScheduler,
} from '../lib/crashDrafts';
import { crashDraftCommands } from '../lib/crashDraftCommands';
import { translate, useI18n } from '../lib/i18n';
import type { OpenIntentTargetKind } from '../lib/openIntent';
import { createPaneProtocolId, createTauriPaneReplication } from '../lib/tauriPaneReplication';
import {
  clearRecentFiles,
  commitRecentOpen,
  createWorkspaceDirectory,
  createWorkspaceFile,
  deleteWorkspaceEntry,
  discardOpenReceipt,
  getOpenCommitStatus,
  moveWorkspaceEntry,
  openDirectoryDialog,
  openFileDialog,
  openRecentFile,
  openWorkspaceFile,
  openWorkspaceIndexResult as openNativeWorkspaceIndexResult,
  persistWorkspaceSession,
  refreshDirectory,
  renameWorkspaceEntry,
  resolveOpenIntent as resolveNativeOpenIntent,
  settleOpenIntentWorkspace,
  saveAsDialog,
  issueDocumentOverwriteToken,
  retryDocumentSaveWithToken,
  cancelDocumentOverwriteToken,
  writeFile,
} from '../lib/tauriCommands';
import type {
  MutationOutcome,
  FileVersion,
  OpenFileResponse,
  PreparedOpenFileResponse,
  SnapshotReceipt,
  WorkspaceDirectoryEntry,
  WorkspaceFileEntry,
  WorkspaceFileKind,
  WorkspaceSnapshot,
} from '../types';

interface UseDocumentSessionInput {
  activeDocumentWatchTransport?: ActiveDocumentWatchTransport | null;
  isPopout: boolean;
  popoutPane: 'main' | 'editor' | 'preview';
  autosaveEnabled?: boolean;
  autosaveDelayMs?: number;
  afterConfirmedSave?: (documentId: string) => boolean | void | Promise<boolean | void>;
}

interface ActiveWorkspaceIdentity {
  workspaceToken: string;
  workspaceRoot: string;
}

type PreparedOpenApplyResult = 'committed' | 'not_committed' | 'indeterminate' | 'stale';

interface AcceptedActiveDocumentWatch {
  documentGeneration: number;
  documentId: string;
  highestAppliedSequence: number;
  path: string;
  resolvedThroughSequence: number;
  watchId: string;
}

interface ExternalFileActionState {
  envelope: ActiveDocumentWatchSnapshotEnvelope;
  kind: 'conflict' | 'deleted-draft';
}

interface PendingDocumentSaveConflict {
  busy: boolean;
  content: string;
  documentGeneration: number;
  documentId: string;
  operationId: string;
  overwriteToken?: string;
  path: string;
  sourcePath: string | null;
  saveKind: 'same-file' | 'save-as';
  resumeExternalAction?: ExternalFileActionState;
}

function activePathInWorkspaceSnapshot(
  activePath: string | null,
  files: readonly WorkspaceFileEntry[],
): string | null {
  if (!activePath || !files.some((file) => file.path === activePath)) return null;
  return activePath;
}

function editableFileVersion(file: OpenFileResponse): FileVersion | null {
  return file.kind === 'markdown' || file.kind === 'html' || file.kind === 'excalidraw'
    ? file.file_version
    : null;
}

export interface ExternalFileActionDialogState {
  busy: boolean;
  kind: 'conflict' | 'deleted-draft';
  path: string;
}

export interface DocumentSaveConflictDialogState {
  busy: boolean;
  path: string;
}

export function useDocumentSession({
  activeDocumentWatchTransport: suppliedActiveDocumentWatchTransport,
  isPopout,
  popoutPane,
  autosaveEnabled = false,
  autosaveDelayMs = 1500,
  afterConfirmedSave,
}: UseDocumentSessionInput) {
  const { locale } = useI18n();
  const localeRef = useRef(locale);
  localeRef.current = locale;
  const restoreWorkspaceSessionOnMountRef = useRef(!isPopout && isTauriRuntime());
  const restoreWorkspaceSessionOnMount = restoreWorkspaceSessionOnMountRef.current;
  const [workspaceRoot, setWorkspaceRoot] = useState<string | null>(null);
  const [files, setFiles] = useState<WorkspaceFileEntry[]>([]);
  const [directories, setDirectories] = useState<WorkspaceDirectoryEntry[]>([]);
  const [activeFileKind, setActiveFileKind] = useState<WorkspaceFileKind>('markdown');
  const [activeMimeType, setActiveMimeType] = useState<string | null>(null);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [bytesBase64, setBytesBase64] = useState<string | null>(null);
  const [content, setContent] = useState(EMPTY_MARKDOWN);
  const [lastSavedContent, setLastSavedContent] = useState(EMPTY_MARKDOWN);
  const [previewRevision, setPreviewRevision] = useState(0);
  const [authorityStatus, setAuthorityStatus] = useState<DocumentAuthorityStatus>('committed');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [externalFileAction, setExternalFileAction] = useState<ExternalFileActionState | null>(null);
  const [externalFileActionBusy, setExternalFileActionBusy] = useState(false);
  const [saveConflict, setSaveConflict] = useState<PendingDocumentSaveConflict | null>(null);
  const [busy, setBusy] = useState(false);
  const [autosaveBlockedContent, setAutosaveBlockedContent] = useState<string | null>(null);
  const [workspaceSessionRestoreSettled, setWorkspaceSessionRestoreSettled] = useState(
    () => !restoreWorkspaceSessionOnMount,
  );
  const [documentIdentity, setDocumentIdentity] = useState(() => ({
    documentId: createPaneProtocolId('pane-document'),
    documentEpoch: 0,
  }));
  const sessionQueueRef = useRef<ReturnType<typeof createDocumentSessionQueue> | null>(null);
  if (!sessionQueueRef.current) sessionQueueRef.current = createDocumentSessionQueue();
  const sessionQueue = sessionQueueRef.current;
  const documentGenerationRef = useRef(0);
  const documentOpenRequestRef = useRef(0);
  const workspaceGenerationRef = useRef(0);
  const workspaceSessionPersistRevisionRef = useRef(0);
  const workspaceSessionPersistTailRef = useRef<Promise<void>>(Promise.resolve());
  const workspaceSessionRestoreMountedRef = useRef(true);
  const workspaceSessionRestoreSettledRef = useRef(!restoreWorkspaceSessionOnMount);
  const workspaceFilesRef = useRef<WorkspaceFileEntry[]>([]);
  const workspaceDirectoriesRef = useRef<WorkspaceDirectoryEntry[]>([]);
  const activePathRef = useRef<string | null>(null);
  const activeFileVersionRef = useRef<FileVersion | null>(null);
  const crashDraftSchedulerRef = useRef<CrashDraftScheduler | null>(null);
  const crashDraftDocumentIdRef = useRef(createCrashDraftDocumentId());
  const forcedDirtyCrashDraftIdRef = useRef<string | null>(null);
  const saveConflictRef = useRef<PendingDocumentSaveConflict | null>(null);
  const activeDocumentWatchRef = useRef<AcceptedActiveDocumentWatch | null>(null);
  const externalFileActionRef = useRef<ExternalFileActionState | null>(null);
  const paneReplicationRef = useRef<ReturnType<typeof createTauriPaneReplication> | null>(null);
  const workspaceIdentityRef = useRef<WorkspaceIdentity>({
    workspaceToken: null,
    workspaceRoot: null,
  });
  const activeDocumentWatchTransport = useMemo(() => {
    if (suppliedActiveDocumentWatchTransport !== undefined) {
      return suppliedActiveDocumentWatchTransport;
    }
    if (!isTauriRuntime()) return null;
    return createTauriActiveDocumentWatchTransport({
      onError: (watchError) => setError(normalizeAppError(watchError, localeRef.current)),
    });
  }, [suppliedActiveDocumentWatchTransport]);

  externalFileActionRef.current = externalFileAction;
  saveConflictRef.current = saveConflict;

  const dirty = isDocumentDirty({ activeFileKind, content, lastSavedContent })
    || forcedDirtyCrashDraftIdRef.current === crashDraftDocumentIdRef.current;
  const fileTree = useMemo(() => buildWorkspaceFileTree(files, directories), [directories, files]);
  workspaceFilesRef.current = files;
  workspaceDirectoriesRef.current = directories;
  const paneState = useMemo<PaneReplicatedState>(() => ({
    activeFileKind,
    activeMimeType,
    activePath,
    bytesBase64,
    content,
    lastSavedContent,
    previewRevision,
    authorityStatus,
    workspaceRoot,
    ...documentIdentity,
  }), [activeFileKind, activeMimeType, activePath, authorityStatus, bytesBase64, content, documentIdentity, lastSavedContent, previewRevision, workspaceRoot]);
  const paneStateRef = useRef(paneState);
  paneStateRef.current = paneState;

  useEffect(() => sessionQueue.subscribeBusy(setBusy), [sessionQueue]);

  useEffect(() => {
    if (isPopout) return undefined;
    const scheduler = createCrashDraftScheduler({
      isMainWindow: true,
      write: crashDraftCommands.write,
    });
    crashDraftSchedulerRef.current = scheduler;
    return () => {
      if (crashDraftSchedulerRef.current === scheduler) crashDraftSchedulerRef.current = null;
      scheduler.dispose();
    };
  }, [isPopout]);

  const executeSessionOperation = useCallback(async <T,>(
    operation: DocumentSessionQueueOperation<T>,
  ): Promise<DocumentSessionQueueResult<T> | null> => {
    try {
      return await sessionQueue.enqueue({
        ...operation,
        run: async () => {
          setError(null);
          return operation.run();
        },
      });
    } catch (err) {
      setError(normalizeAppError(err, localeRef.current));
      return null;
    }
  }, [sessionQueue]);

  const consumeMutationOutcome = useCallback(<T,>(outcome: MutationOutcome<T> | null) => {
    if (!outcome) return;
    const message = getMutationOutcomeMessage(outcome);
    if (message) setError(message);
  }, []);

  const applyWorkspaceSnapshot = useCallback((response: WorkspaceSnapshot) => {
    workspaceIdentityRef.current = {
      workspaceToken: response.workspace_token,
      workspaceRoot: response.root,
    };
    paneStateRef.current = {
      ...paneStateRef.current,
      workspaceRoot: response.root,
    };
    workspaceFilesRef.current = response.files;
    workspaceDirectoriesRef.current = response.directories ?? [];
    setWorkspaceRoot(response.root);
    setFiles(response.files);
    setDirectories(response.directories ?? []);
  }, []);

  const restoreWorkspaceState = useCallback((snapshot: WorkspaceSnapshot | null) => {
    if (snapshot) {
      applyWorkspaceSnapshot(snapshot);
      return;
    }
    workspaceIdentityRef.current = { workspaceRoot: null, workspaceToken: null };
    workspaceFilesRef.current = [];
    workspaceDirectoriesRef.current = [];
    paneStateRef.current = { ...paneStateRef.current, workspaceRoot: null };
    setWorkspaceRoot(null);
    setFiles([]);
    setDirectories([]);
  }, [applyWorkspaceSnapshot]);

  const setActiveDocumentPath = useCallback((path: string | null) => {
    const previousPath = activePathRef.current;
    const currentVersion = activeFileVersionRef.current;
    if (path && previousPath && currentVersion?.canonicalPath === previousPath) {
      activeFileVersionRef.current = { ...currentVersion, canonicalPath: path };
    }
    activePathRef.current = path;
    paneStateRef.current = {
      ...paneStateRef.current,
      activePath: path,
    };
    setActivePath(path);
  }, []);

  const applyDocumentSessionState = useCallback((next: DocumentSessionState) => {
    const nextPaneState: PaneReplicatedState = {
      ...paneStateRef.current,
      ...next,
    };
    paneStateRef.current = nextPaneState;
    setDocumentIdentity({
      documentId: next.documentId,
      documentEpoch: next.documentEpoch,
    });
    setActiveFileKind(next.activeFileKind);
    setActiveMimeType(next.activeMimeType);
    setActiveDocumentPath(next.activePath);
    setBytesBase64(next.bytesBase64);
    setContent(next.content);
    setLastSavedContent(next.lastSavedContent);
    setPreviewRevision(next.previewRevision);
    setAuthorityStatus(next.authorityStatus);
  }, [setActiveDocumentPath]);

  const currentDocumentSessionState = useCallback((): DocumentSessionState => ({
    documentId: paneStateRef.current.documentId,
    documentEpoch: paneStateRef.current.documentEpoch,
    authorityStatus: paneStateRef.current.authorityStatus ?? 'unknown',
    activeFileKind: paneStateRef.current.activeFileKind,
    activeMimeType: paneStateRef.current.activeMimeType,
    activePath: paneStateRef.current.activePath,
    bytesBase64: paneStateRef.current.bytesBase64 ?? null,
    content: paneStateRef.current.content,
    lastSavedContent: paneStateRef.current.lastSavedContent,
    previewRevision: paneStateRef.current.previewRevision,
  }), []);

  const setExternalFileActionState = useCallback((next: ExternalFileActionState | null) => {
    externalFileActionRef.current = next;
    setExternalFileAction(next);
  }, []);

  const setSaveConflictState = useCallback((next: PendingDocumentSaveConflict | null) => {
    saveConflictRef.current = next;
    setSaveConflict(next);
  }, []);

  const flushCrashDraft = useCallback(async () => {
    await crashDraftSchedulerRef.current?.flush(crashDraftDocumentIdRef.current);
  }, []);

  const advanceCrashDraftIdentity = useCallback((priorDocumentId: string) => {
    crashDraftSchedulerRef.current?.invalidate(priorDocumentId);
    crashDraftDocumentIdRef.current = createCrashDraftDocumentId();
    forcedDirtyCrashDraftIdRef.current = null;
  }, []);

  const scheduleCurrentCrashDraft = useCallback(() => {
    if (isPopout) return;
    const current = paneStateRef.current;
    if ((current.authorityStatus ?? 'unknown') !== 'committed'
      || !isEditableFileKind(current.activeFileKind)) return;
    const version = activeFileVersionRef.current;
    if (current.activePath && !version) return;
    crashDraftSchedulerRef.current?.schedule({
      documentId: crashDraftDocumentIdRef.current,
      fileKind: current.activeFileKind,
      pathHint: current.activePath,
      baseVersionToken: current.activePath ? version!.sha256 : null,
      content: current.content,
    });
  }, [isPopout]);

  const cleanupConfirmedCrashDraft = useCallback(async (committedContent: string) => {
    const crashDocumentId = crashDraftDocumentIdRef.current;
    if (paneStateRef.current.content !== committedContent) {
      try {
        scheduleCurrentCrashDraft();
      } catch {
        setError('The document was saved, but newer edits could not be added to crash recovery.');
      }
      return;
    }
    try {
      await crashDraftSchedulerRef.current?.flush(crashDocumentId);
    } catch {
      setError('The document was saved, but its recovery draft could not be finalized.');
      return;
    }
    const cleaned = await afterConfirmedSave?.(crashDocumentId);
    if (cleaned === false) return;
    crashDraftSchedulerRef.current?.invalidate(crashDocumentId);
    forcedDirtyCrashDraftIdRef.current = null;
  }, [afterConfirmedSave, scheduleCurrentCrashDraft]);

  const lockDocumentAuthorityUnknown = useCallback(() => {
    paneStateRef.current = { ...paneStateRef.current, authorityStatus: 'unknown' };
    setAuthorityStatus('unknown');
  }, []);

  const ordinaryDocumentActionsBlocked = useCallback(
    () => externalFileActionRef.current !== null
      || saveConflictRef.current !== null
      || (!isPopout && !workspaceSessionRestoreSettledRef.current),
    [isPopout],
  );

  const openIntentResolutionBlocked = useCallback(
    () => isPopout || externalFileActionRef.current !== null || saveConflictRef.current !== null,
    [isPopout],
  );

  const stopAcceptedActiveDocumentWatch = useCallback(async () => {
    const accepted = activeDocumentWatchRef.current;
    activeDocumentWatchRef.current = null;
    if (!accepted || !activeDocumentWatchTransport) return;
    await activeDocumentWatchTransport.stop(accepted.watchId).catch(() => false);
  }, [activeDocumentWatchTransport]);

  const isAcceptedWatchCurrent = useCallback((
    accepted: AcceptedActiveDocumentWatch,
    sequence?: number,
  ) => {
    const current = activeDocumentWatchRef.current;
    if (!current
      || current.watchId !== accepted.watchId
      || current.documentId !== accepted.documentId
      || current.documentGeneration !== accepted.documentGeneration
      || documentGenerationRef.current !== accepted.documentGeneration
      || paneStateRef.current.documentId !== accepted.documentId
      || (paneStateRef.current.authorityStatus ?? 'unknown') !== 'committed') {
      return false;
    }
    return sequence === undefined
      || (sequence > current.highestAppliedSequence
        && sequence > current.resolvedThroughSequence);
  }, []);

  const envelopeMatchesAcceptedPath = useCallback((
    accepted: AcceptedActiveDocumentWatch,
    envelope: ActiveDocumentWatchSnapshotEnvelope,
  ) => {
    const currentPath = activePathRef.current;
    if (!currentPath) return false;
    if (envelope.reason === 'renamed') {
      return envelope.previous_path === currentPath
        && envelope.snapshot.status === 'present';
    }
    const snapshotPath = envelope.snapshot.status === 'present'
      ? envelope.snapshot.file.path
      : envelope.snapshot.path;
    return snapshotPath === currentPath && accepted.path === currentPath;
  }, []);

  const applyOpenFileResponse = useCallback((response: OpenFileResponse) => {
    const current = currentDocumentSessionState();
    applyDocumentSessionState({
      ...getOpenedDocumentState(response),
      documentId: createPaneProtocolId('pane-document'),
      documentEpoch: current.documentEpoch + 1,
      authorityStatus: 'committed',
    });
    activeFileVersionRef.current = editableFileVersion(response);
  }, [applyDocumentSessionState, currentDocumentSessionState]);

  const applyPreparedOpen = useCallback(async (
    prepared: PreparedOpenFileResponse,
    requestedGeneration: number,
    reportFailure = true,
    discardCurrentCrashDraft = false,
  ): Promise<PreparedOpenApplyResult> => {
    const priorCrashDocumentId = crashDraftDocumentIdRef.current;
    try {
      await crashDraftSchedulerRef.current?.flush(priorCrashDocumentId);
    } catch {
      await discardOpenReceipt(prepared.open_receipt).catch(() => undefined);
      if (reportFailure) setError('The recovery draft could not be saved. The current document remains open.');
      return 'not_committed';
    }
    const prior = currentDocumentSessionState();
    const priorVersion = activeFileVersionRef.current;
    const transition = createProvisionalDocumentTransition(
      prior,
      prepared.file,
      {
        documentId: createPaneProtocolId('pane-document'),
        documentEpoch: prior.documentEpoch + 1,
      },
    );
    applyDocumentSessionState(transition.provisional);

    const outcome = await resolveOpenCommitOutcome(prepared, {
      commit: commitRecentOpen,
      getStatus: getOpenCommitStatus,
    });
    if (documentGenerationRef.current !== requestedGeneration) return 'stale';

    if (outcome.status === 'committed') {
      applyDocumentSessionState({
        ...transition.provisional,
        authorityStatus: 'committed',
      });
      activeFileVersionRef.current = editableFileVersion(prepared.file);
      advanceCrashDraftIdentity(priorCrashDocumentId);
      if (discardCurrentCrashDraft) await afterConfirmedSave?.(priorCrashDocumentId);
      return 'committed';
    }
    if (outcome.status === 'not_committed') {
      try {
        applyDocumentSessionState(restoreDocumentSnapshot(transition.prior));
        activeFileVersionRef.current = priorVersion;
      } catch {
        applyDocumentSessionState({
          ...transition.provisional,
          authorityStatus: 'failed',
        });
        activeFileVersionRef.current = priorVersion;
      }
      if (reportFailure) setError(outcome.message);
      return 'not_committed';
    }
    applyDocumentSessionState({
      ...transition.provisional,
      authorityStatus: 'unknown',
    });
    activeFileVersionRef.current = priorVersion;
    if (reportFailure) {
      setError('The file authorization result could not be confirmed. Open another file to continue.');
    }
    return 'indeterminate';
  }, [advanceCrashDraftIdentity, afterConfirmedSave, applyDocumentSessionState, currentDocumentSessionState]);

  const claimPreparedOpen = useCallback((
    prepared: PreparedOpenFileResponse | null,
    requestedGeneration: number,
  ) => {
    const nextGeneration = nextPreparedOpenGeneration(
      documentGenerationRef.current,
      requestedGeneration,
      prepared,
    );
    if (nextGeneration !== null) documentGenerationRef.current = nextGeneration;
    return nextGeneration;
  }, []);

  useEffect(() => {
    workspaceSessionRestoreMountedRef.current = true;
    return () => {
      workspaceSessionRestoreMountedRef.current = false;
    };
  }, []);

  const settleWorkspaceSessionRestore = useCallback(() => {
    workspaceSessionRestoreSettledRef.current = true;
    if (workspaceSessionRestoreMountedRef.current) setWorkspaceSessionRestoreSettled(true);
  }, []);

  const getActiveWorkspace = useCallback((): ActiveWorkspaceIdentity | null => {
    const { workspaceRoot: currentRoot, workspaceToken: currentToken } = workspaceIdentityRef.current;
    if (!currentRoot || !currentToken) return null;
    return { workspaceRoot: currentRoot, workspaceToken: currentToken };
  }, []);

  const enqueueWorkspaceSessionPersist = useCallback((
    workspace: ActiveWorkspaceIdentity,
    activePath: string | null,
  ): Promise<void> => {
    const revision = ++workspaceSessionPersistRevisionRef.current;
    const persist = workspaceSessionPersistTailRef.current
      .catch(() => undefined)
      .then(async () => {
        if (revision !== workspaceSessionPersistRevisionRef.current
          || isPopout
          || !workspaceSessionRestoreSettledRef.current) {
          return;
        }
        await persistWorkspaceSession(
          workspace.workspaceToken,
          workspace.workspaceRoot,
          activePath,
        );
      });
    const tracked = persist.catch((persistError: unknown) => {
      if (revision === workspaceSessionPersistRevisionRef.current) {
        setError(normalizeAppError(persistError, localeRef.current));
      }
      throw persistError;
    });
    workspaceSessionPersistTailRef.current = tracked.catch(() => undefined);
    return tracked;
  }, [isPopout]);

  useEffect(() => {
    if (
      isPopout
      || !workspaceSessionRestoreSettled
      || authorityStatus !== 'committed'
    ) return;
    const workspace = getActiveWorkspace();
    if (!workspace) return;
    const persistedActivePath = activePathInWorkspaceSnapshot(activePath, files);
    void enqueueWorkspaceSessionPersist(workspace, persistedActivePath).catch(() => undefined);
  }, [
    activePath,
    authorityStatus,
    enqueueWorkspaceSessionPersist,
    files,
    getActiveWorkspace,
    isPopout,
    workspaceRoot,
    workspaceSessionRestoreSettled,
  ]);

  const flushWorkspaceSession = useCallback(async () => {
    if (isPopout || !workspaceSessionRestoreSettledRef.current) return;
    const workspace = getActiveWorkspace();
    if (!workspace) return;
    const current = paneStateRef.current;
    if ((current.authorityStatus ?? 'unknown') !== 'committed') return;
    await enqueueWorkspaceSessionPersist(
      workspace,
      activePathInWorkspaceSnapshot(current.activePath, workspaceFilesRef.current),
    );
  }, [enqueueWorkspaceSessionPersist, getActiveWorkspace, isPopout]);

  const isCurrentWorkspaceRequest = useCallback((
    requestedWorkspace: ActiveWorkspaceIdentity,
    requestedGeneration: number,
  ) => workspaceGenerationRef.current === requestedGeneration
    && isCurrentWorkspaceIdentity(workspaceIdentityRef.current, requestedWorkspace), []);

  const refreshWorkspaceDirect = useCallback(async (
    requestedWorkspace: ActiveWorkspaceIdentity,
    requestedGeneration: number,
  ) => {
    const response = await refreshDirectory(
      requestedWorkspace.workspaceToken,
      requestedWorkspace.workspaceRoot,
    );
    if (!isCurrentWorkspaceRequest(requestedWorkspace, requestedGeneration)) return;
    if (!isCurrentWorkspaceIdentity(
      {
        workspaceRoot: response.root,
        workspaceToken: response.workspace_token,
      },
      requestedWorkspace,
    )) {
      throw new Error('Workspace refresh response does not match the active workspace');
    }
    applyWorkspaceSnapshot(response);
  }, [applyWorkspaceSnapshot, isCurrentWorkspaceRequest]);

  const refreshWorkspaceAfterExternalPathChange = useCallback(async (previousPath: string) => {
    const requestedWorkspace = getActiveWorkspace();
    if (!requestedWorkspace) return;
    const normalizedRoot = requestedWorkspace.workspaceRoot.replace(/\\/g, '/').replace(/\/$/, '');
    const normalizedPath = previousPath.replace(/\\/g, '/');
    if (normalizedPath !== normalizedRoot && !normalizedPath.startsWith(`${normalizedRoot}/`)) {
      return;
    }
    const requestedGeneration = workspaceGenerationRef.current;
    try {
      await refreshWorkspaceDirect(requestedWorkspace, requestedGeneration);
    } catch (refreshError) {
      if (isCurrentWorkspaceRequest(requestedWorkspace, requestedGeneration)) {
        setError(normalizeAppError(refreshError, localeRef.current));
      }
    }
  }, [getActiveWorkspace, isCurrentWorkspaceRequest, refreshWorkspaceDirect]);

  const applyExternalDocumentDecision = useCallback(async (
    decision: ExternalDocumentChangeDecision,
    sequence: number,
  ) => {
    const accepted = activeDocumentWatchRef.current;
    if (accepted) accepted.highestAppliedSequence = Math.max(
      accepted.highestAppliedSequence,
      sequence,
    );

    if (decision.kind === 'ignore') return;
    if (decision.kind === 'apply-document') {
      const previousPath = activePathRef.current;
      const appliedAction = externalFileActionRef.current;
      if (accepted && decision.state.activePath) accepted.path = decision.state.activePath;
      applyDocumentSessionState(decision.state);
      const sourceEnvelope = appliedAction?.envelope;
      if (sourceEnvelope?.snapshot.status === 'present'
        && isEditableFileKind(sourceEnvelope.snapshot.file.kind)) {
        activeFileVersionRef.current = editableFileVersion(sourceEnvelope.snapshot.file);
      }
      if (previousPath && decision.state.activePath !== previousPath) {
        await refreshWorkspaceAfterExternalPathChange(previousPath);
      }
      return;
    }
    if (decision.kind === 'show-conflict') {
      const pendingSave = saveConflictRef.current;
      setSaveConflictState(null);
      if (pendingSave?.overwriteToken) {
        void cancelDocumentOverwriteToken(pendingSave.path, pendingSave.overwriteToken).catch(() => undefined);
      }
      const currentAction = externalFileActionRef.current;
      const envelope = currentAction?.kind === 'conflict'
        ? coalesceExternalConflict(currentAction.envelope, decision.envelope)
        : decision.envelope;
      setExternalFileActionState({ kind: 'conflict', envelope });
      return;
    }
    if (decision.kind === 'show-deleted-draft') {
      const pendingSave = saveConflictRef.current;
      setSaveConflictState(null);
      if (pendingSave?.overwriteToken) {
        void cancelDocumentOverwriteToken(pendingSave.path, pendingSave.overwriteToken).catch(() => undefined);
      }
      await stopAcceptedActiveDocumentWatch();
      setExternalFileActionState({ kind: 'deleted-draft', envelope: decision.envelope });
      return;
    }

    const previousPath = activePathRef.current;
    const priorCrashDocumentId = crashDraftDocumentIdRef.current;
    try {
      await crashDraftSchedulerRef.current?.flush(priorCrashDocumentId);
    } catch {
      setError('The recovery draft could not be saved. The current document remains open.');
      return;
    }
    await stopAcceptedActiveDocumentWatch();
    documentOpenRequestRef.current += 1;
    documentGenerationRef.current += 1;
    const current = currentDocumentSessionState();
    applyDocumentSessionState({
      documentId: createPaneProtocolId('pane-document'),
      documentEpoch: current.documentEpoch + 1,
      authorityStatus: 'committed',
      activeFileKind: 'markdown',
      activeMimeType: null,
      activePath: null,
      bytesBase64: null,
      content: EMPTY_MARKDOWN,
      lastSavedContent: EMPTY_MARKDOWN,
      previewRevision: 0,
    });
    activeFileVersionRef.current = null;
    advanceCrashDraftIdentity(priorCrashDocumentId);
    setNotice(translate(localeRef.current, 'watchedFileDeleted', { name: displayName(decision.path) }));
    if (previousPath) await refreshWorkspaceAfterExternalPathChange(previousPath);
  }, [
    applyDocumentSessionState,
    advanceCrashDraftIdentity,
    currentDocumentSessionState,
    refreshWorkspaceAfterExternalPathChange,
    setExternalFileActionState,
    setSaveConflictState,
    stopAcceptedActiveDocumentWatch,
  ]);

  const enqueueActiveDocumentWatchEnvelope = useCallback(async (
    accepted: AcceptedActiveDocumentWatch,
    envelope: ActiveDocumentWatchSnapshotEnvelope,
    registration = false,
  ): Promise<boolean> => {
    try {
      const result = await sessionQueue.enqueue({
        run: async () => envelope,
        isCurrent: () => {
          if (registration) {
            return documentGenerationRef.current === accepted.documentGeneration
              && paneStateRef.current.documentId === accepted.documentId
              && (paneStateRef.current.authorityStatus ?? 'unknown') === 'committed'
              && activePathRef.current === accepted.path;
          }
          return isAcceptedWatchCurrent(accepted, envelope.sequence)
            && envelopeMatchesAcceptedPath(accepted, envelope);
        },
        apply: async (currentEnvelope) => {
          if (!registration && (!isAcceptedWatchCurrent(accepted, currentEnvelope.sequence)
            || !envelopeMatchesAcceptedPath(accepted, currentEnvelope))) {
            return;
          }
          accepted.highestAppliedSequence = Math.max(
            accepted.highestAppliedSequence,
            currentEnvelope.sequence,
          );
          const decision = reduceExternalDocumentChange(currentDocumentSessionState(), currentEnvelope);
          await applyExternalDocumentDecision(decision, currentEnvelope.sequence);
          if (decision.kind === 'apply-document'
            && currentEnvelope.snapshot.status === 'present'
            && isEditableFileKind(currentEnvelope.snapshot.file.kind)) {
            activeFileVersionRef.current = editableFileVersion(currentEnvelope.snapshot.file);
          }
        },
      });
      return result.status === 'applied';
    } catch (watchError) {
      setError(normalizeAppError(watchError, localeRef.current));
      return false;
    }
  }, [
    applyExternalDocumentDecision,
    currentDocumentSessionState,
    envelopeMatchesAcceptedPath,
    isAcceptedWatchCurrent,
    sessionQueue,
  ]);

  const enqueueActiveDocumentWatchHealth = useCallback(async (
    accepted: AcceptedActiveDocumentWatch,
    event: ActiveDocumentWatchEvent & { event: { kind: 'health' } },
  ) => {
    try {
      await sessionQueue.enqueue({
        run: async () => event,
        isCurrent: () => isAcceptedWatchCurrent(accepted, event.sequence),
        apply: (currentEvent) => {
          if (!isAcceptedWatchCurrent(accepted, currentEvent.sequence)) return;
          accepted.highestAppliedSequence = currentEvent.sequence;
          if (currentEvent.event.status === 'failed') {
            setError(translate(localeRef.current, 'watchStopped'));
            setNotice(null);
          } else {
            setNotice(translate(localeRef.current, 'watchInterrupted'));
          }
        },
      });
    } catch (watchError) {
      setError(normalizeAppError(watchError, localeRef.current));
    }
  }, [isAcceptedWatchCurrent, sessionQueue]);

  const handleActiveDocumentWatchEvent = useCallback((event: ActiveDocumentWatchEvent) => {
    const accepted = activeDocumentWatchRef.current;
    if (!accepted
      || event.watch_id !== accepted.watchId
      || event.document_id !== accepted.documentId
      || event.document_generation !== accepted.documentGeneration
      || event.sequence <= accepted.highestAppliedSequence
      || event.sequence <= accepted.resolvedThroughSequence) {
      return;
    }
    if (event.event.kind === 'health') {
      void enqueueActiveDocumentWatchHealth(accepted, event as ActiveDocumentWatchEvent & {
        event: { kind: 'health' };
      });
      return;
    }
    void enqueueActiveDocumentWatchEnvelope(accepted, {
      protocol_version: event.protocol_version,
      watch_id: event.watch_id,
      document_id: event.document_id,
      document_generation: event.document_generation,
      sequence: event.sequence,
      reason: event.event.reason,
      previous_path: event.event.previous_path,
      snapshot: event.event.snapshot,
    });
  }, [enqueueActiveDocumentWatchEnvelope, enqueueActiveDocumentWatchHealth]);

  useEffect(() => {
    if (isPopout || !activeDocumentWatchTransport) return undefined;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    activeDocumentWatchTransport.listen(handleActiveDocumentWatchEvent).then((stopListening) => {
      if (disposed) stopListening();
      else unlisten = stopListening;
    }).catch((watchError: unknown) => setError(normalizeAppError(watchError, localeRef.current)));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [activeDocumentWatchTransport, handleActiveDocumentWatchEvent, isPopout]);

  useEffect(() => {
    if (isPopout
      || !activeDocumentWatchTransport
      || authorityStatus !== 'committed'
      || !activePath) {
      return undefined;
    }

    const requestedPath = activePath;
    const requestedDocumentId = documentIdentity.documentId;
    const requestedDocumentGeneration = documentGenerationRef.current;
    const existing = activeDocumentWatchRef.current;
    let disposed = false;
    let startedWatchId: string | null = null;

    const cleanup = () => {
      disposed = true;
      const current = activeDocumentWatchRef.current;
      if (!current || (startedWatchId && current.watchId !== startedWatchId)) return;
      const renameHandoff = current.documentId === requestedDocumentId
        && current.documentGeneration === requestedDocumentGeneration
        && current.path !== requestedPath
        && current.path === activePathRef.current;
      if (renameHandoff) return;
      activeDocumentWatchRef.current = null;
      void activeDocumentWatchTransport.stop(current.watchId).catch(() => false);
    };

    if (existing
      && existing.documentId === requestedDocumentId
      && existing.documentGeneration === requestedDocumentGeneration
      && existing.path === requestedPath) {
      startedWatchId = existing.watchId;
      return cleanup;
    }

    void (async () => {
      try {
        const registration = await activeDocumentWatchTransport.start(
          requestedPath,
          requestedDocumentId,
          requestedDocumentGeneration,
        );
        startedWatchId = registration.watch_id;
        if (disposed
          || documentGenerationRef.current !== requestedDocumentGeneration
          || paneStateRef.current.documentId !== requestedDocumentId
          || activePathRef.current !== requestedPath) {
          await activeDocumentWatchTransport.stop(registration.watch_id).catch(() => false);
          return;
        }

        const accepted: AcceptedActiveDocumentWatch = {
          documentGeneration: requestedDocumentGeneration,
          documentId: requestedDocumentId,
          highestAppliedSequence: 0,
          path: requestedPath,
          resolvedThroughSequence: 0,
          watchId: registration.watch_id,
        };
        const envelope: ActiveDocumentWatchSnapshotEnvelope = {
          protocol_version: registration.protocol_version,
          watch_id: registration.watch_id,
          document_id: registration.document_id,
          document_generation: registration.document_generation,
          sequence: registration.sequence,
          reason: registration.snapshot.status === 'missing' ? 'missing' : 'resync',
          previous_path: null,
          snapshot: registration.snapshot,
        };
        const applied = await enqueueActiveDocumentWatchEnvelope(accepted, envelope, true);
        if (!applied
          || disposed
          || documentGenerationRef.current !== requestedDocumentGeneration
          || paneStateRef.current.documentId !== requestedDocumentId
          || !activePathRef.current
          || externalFileActionRef.current?.kind === 'deleted-draft') {
          await activeDocumentWatchTransport.stop(registration.watch_id).catch(() => false);
          return;
        }
        accepted.highestAppliedSequence = registration.sequence;
        accepted.path = registration.snapshot.status === 'present'
          ? registration.snapshot.file.path
          : registration.snapshot.path;
        activeDocumentWatchRef.current = accepted;
        const activated = await activeDocumentWatchTransport.activate(
          registration.watch_id,
          requestedDocumentId,
          requestedDocumentGeneration,
          registration.sequence,
        );
        if (!activated && activeDocumentWatchRef.current?.watchId === registration.watch_id) {
          activeDocumentWatchRef.current = null;
          await activeDocumentWatchTransport.stop(registration.watch_id).catch(() => false);
          setError(translate(localeRef.current, 'watchUnavailable'));
        }
      } catch (watchError) {
        if (!disposed
          && documentGenerationRef.current === requestedDocumentGeneration
          && paneStateRef.current.documentId === requestedDocumentId
          && activePathRef.current === requestedPath) {
          setError(normalizeAppError(watchError, localeRef.current));
        }
      }
    })();

    return cleanup;
  }, [
    activeDocumentWatchTransport,
    activePath,
    authorityStatus,
    documentIdentity.documentId,
    enqueueActiveDocumentWatchEnvelope,
    isPopout,
  ]);

  const reconcileRequestedWorkspaceReceipt = useCallback(async (
    requestedWorkspace: ActiveWorkspaceIdentity,
    requestedGeneration: number,
    receipt: SnapshotReceipt,
  ) => {
    if (!isCurrentWorkspaceRequest(requestedWorkspace, requestedGeneration)) return null;
    return reconcileWorkspaceReceipt(
      requestedWorkspace.workspaceToken,
      receipt,
      {
        workspaceRoot: requestedWorkspace.workspaceRoot,
        applySnapshot: (snapshot) => {
          if (isCurrentWorkspaceRequest(requestedWorkspace, requestedGeneration)) {
            applyWorkspaceSnapshot(snapshot);
          }
        },
        refresh: () => refreshWorkspaceDirect(requestedWorkspace, requestedGeneration),
      },
    );
  }, [applyWorkspaceSnapshot, isCurrentWorkspaceRequest, refreshWorkspaceDirect]);

  const replicationRole: ReplicaRole = isPopout
    ? popoutPane === 'editor' ? 'editor-popout' : 'preview-popout'
    : 'main';
  const applyReplicatedPaneSnapshot = useCallback((snapshot: PaneSnapshotEnvelope) => {
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

  const refreshWorkspace = useCallback(async (root?: string) => {
    if (ordinaryDocumentActionsBlocked()) return;
    const currentWorkspace = getActiveWorkspace();
    if (!currentWorkspace) return;
    const requestedWorkspace = {
      ...currentWorkspace,
      workspaceRoot: root ?? currentWorkspace.workspaceRoot,
    };
    if (!isCurrentWorkspaceIdentity(currentWorkspace, requestedWorkspace)) return;
    const requestedGeneration = workspaceGenerationRef.current;

    await executeSessionOperation({
      run: () => refreshDirectory(
        requestedWorkspace.workspaceToken,
        requestedWorkspace.workspaceRoot,
      ),
      isCurrent: () => isCurrentWorkspaceRequest(requestedWorkspace, requestedGeneration),
      apply: (response) => {
        if (!isCurrentWorkspaceIdentity(
          {
            workspaceRoot: response.root,
            workspaceToken: response.workspace_token,
          },
          requestedWorkspace,
        )) {
          throw new Error('Workspace refresh response does not match the active workspace');
        }
        applyWorkspaceSnapshot(response);
      },
    });
  }, [applyWorkspaceSnapshot, executeSessionOperation, getActiveWorkspace, isCurrentWorkspaceRequest, ordinaryDocumentActionsBlocked]);

  const openWorkspaceFilePath = useCallback(async (path: string) => {
    if (ordinaryDocumentActionsBlocked()) return;
    const requestedWorkspace = getActiveWorkspace();
    if (!requestedWorkspace) return;
    const requestedWorkspaceGeneration = workspaceGenerationRef.current;
    const requestedDocumentGeneration = documentGenerationRef.current;
    const requestedOpen = ++documentOpenRequestRef.current;

    await executeSessionOperation({
      run: () => openWorkspaceFile(path),
      consume: async (prepared) => {
        if (documentOpenRequestRef.current !== requestedOpen
          || documentGenerationRef.current !== requestedDocumentGeneration
          || !isCurrentWorkspaceRequest(requestedWorkspace, requestedWorkspaceGeneration)) {
          await discardOpenReceipt(prepared.open_receipt).catch(() => undefined);
        }
      },
      isCurrent: () => documentOpenRequestRef.current === requestedOpen
        && documentGenerationRef.current === requestedDocumentGeneration
        && isCurrentWorkspaceRequest(requestedWorkspace, requestedWorkspaceGeneration),
      apply: async (prepared) => {
        const appliedGeneration = claimPreparedOpen(prepared, requestedDocumentGeneration);
        if (appliedGeneration !== null) await applyPreparedOpen(prepared, appliedGeneration);
      },
    });
  }, [applyPreparedOpen, claimPreparedOpen, executeSessionOperation, getActiveWorkspace, isCurrentWorkspaceRequest, ordinaryDocumentActionsBlocked]);

  const openWorkspaceIndexResult = useCallback(async (
    workspaceToken: string,
    workspaceRoot: string,
    indexGeneration: number,
    relativePath: string,
  ) => {
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
      consume: async (prepared) => {
        if (
          documentOpenRequestRef.current !== requestedOpen
          || documentGenerationRef.current !== requestedDocumentGeneration
          || !isCurrentWorkspaceRequest(requestedWorkspace, requestedWorkspaceGeneration)
        ) {
          await discardOpenReceipt(prepared.open_receipt).catch(() => undefined);
        }
      },
      isCurrent: () => documentOpenRequestRef.current === requestedOpen
        && documentGenerationRef.current === requestedDocumentGeneration
        && isCurrentWorkspaceRequest(requestedWorkspace, requestedWorkspaceGeneration),
      apply: async (prepared) => {
        const appliedGeneration = claimPreparedOpen(prepared, requestedDocumentGeneration);
        if (appliedGeneration !== null) await applyPreparedOpen(prepared, appliedGeneration);
      },
    });
  }, [
    applyPreparedOpen,
    claimPreparedOpen,
    executeSessionOperation,
    getActiveWorkspace,
    isCurrentWorkspaceRequest,
    ordinaryDocumentActionsBlocked,
  ]);

  const handleOpenFile = useCallback(async () => {
    if (ordinaryDocumentActionsBlocked()) return;
    const requestedDocumentGeneration = documentGenerationRef.current;
    const requestedOpen = ++documentOpenRequestRef.current;
    await executeSessionOperation({
      run: openFileDialog,
      consume: async (prepared) => {
        if (prepared && (documentOpenRequestRef.current !== requestedOpen
          || documentGenerationRef.current !== requestedDocumentGeneration)) {
          await discardOpenReceipt(prepared.open_receipt).catch(() => undefined);
        }
      },
      isCurrent: () => documentOpenRequestRef.current === requestedOpen
        && documentGenerationRef.current === requestedDocumentGeneration,
      apply: async (prepared) => {
        const appliedGeneration = claimPreparedOpen(prepared, requestedDocumentGeneration);
        if (prepared && appliedGeneration !== null) {
          await applyPreparedOpen(prepared, appliedGeneration);
        }
      },
    });
  }, [applyPreparedOpen, claimPreparedOpen, executeSessionOperation, ordinaryDocumentActionsBlocked]);

  const handleOpenRecent = useCallback(async (entryId: string) => {
    if (ordinaryDocumentActionsBlocked()) return;
    const requestedDocumentGeneration = documentGenerationRef.current;
    const requestedOpen = ++documentOpenRequestRef.current;
    await executeSessionOperation({
      run: () => openRecentFile(entryId),
      consume: async (prepared) => {
        if (documentOpenRequestRef.current !== requestedOpen
          || documentGenerationRef.current !== requestedDocumentGeneration) {
          await discardOpenReceipt(prepared.open_receipt).catch(() => undefined);
        }
      },
      isCurrent: () => documentOpenRequestRef.current === requestedOpen
        && documentGenerationRef.current === requestedDocumentGeneration,
      apply: async (prepared) => {
        const appliedGeneration = claimPreparedOpen(prepared, requestedDocumentGeneration);
        if (appliedGeneration !== null) await applyPreparedOpen(prepared, appliedGeneration);
      },
    });
  }, [applyPreparedOpen, claimPreparedOpen, executeSessionOperation, ordinaryDocumentActionsBlocked]);

  const handleClearRecent = useCallback(async () => {
    await executeSessionOperation({ run: clearRecentFiles });
  }, [executeSessionOperation]);

  const handleOpenDirectory = useCallback(async () => {
    if (ordinaryDocumentActionsBlocked()) return;
    const requestedGeneration = workspaceGenerationRef.current;
    await executeSessionOperation({
      run: openDirectoryDialog,
      isCurrent: () => workspaceGenerationRef.current === requestedGeneration,
      apply: (response) => {
        applyWorkspaceSelection(response, {
          advanceGeneration: () => {
            workspaceGenerationRef.current += 1;
          },
          applySnapshot: applyWorkspaceSnapshot,
        });
      },
    });
  }, [applyWorkspaceSnapshot, executeSessionOperation, ordinaryDocumentActionsBlocked]);

  const resolveOpenIntentRequest = useCallback(async (
    intentId: string,
    targetKind: OpenIntentTargetKind = 'unknown',
    discardCurrentCrashDraft = false,
  ): Promise<'blocked' | 'accepted' | 'failed'> => {
    if (openIntentResolutionBlocked()) return 'blocked';
    const requestedDocumentGeneration = documentGenerationRef.current;
    const requestedOpen = ++documentOpenRequestRef.current;
    let applied = false;
    const result = await executeSessionOperation({
      run: () => resolveNativeOpenIntent(intentId),
      consume: async (resolved) => {
        if (
          documentOpenRequestRef.current !== requestedOpen
          || documentGenerationRef.current !== requestedDocumentGeneration
          || !workspaceSessionRestoreMountedRef.current
        ) {
          const prepared = resolved.kind === 'file'
            ? resolved.prepared
            : resolved.kind === 'session_restore'
              ? resolved.restore?.active_file ?? null
              : null;
          if (prepared) {
            await discardOpenReceipt(prepared.open_receipt).catch(() => undefined);
          }
          const workspaceOpenReceipt = resolved.kind === 'directory'
            ? resolved.workspace_open_receipt
            : resolved.kind === 'session_restore'
              ? resolved.workspace_open_receipt
              : null;
          if (workspaceOpenReceipt) {
            await settleOpenIntentWorkspace(workspaceOpenReceipt, false).catch(() => undefined);
          }
        }
      },
      isCurrent: () => documentOpenRequestRef.current === requestedOpen
        && documentGenerationRef.current === requestedDocumentGeneration
        && workspaceSessionRestoreMountedRef.current,
      apply: async (resolved) => {
        if (resolved.kind === 'file') {
          const appliedGeneration = claimPreparedOpen(
            resolved.prepared,
            requestedDocumentGeneration,
          );
          if (appliedGeneration !== null) {
            applied = await applyPreparedOpen(
              resolved.prepared,
              appliedGeneration,
              true,
              discardCurrentCrashDraft,
            ) === 'committed';
          }
          return;
        }
        if (resolved.kind === 'session_restore') {
          const restored = resolved.restore;
          if (restored) {
            const currentWorkspace = workspaceIdentityRef.current;
            const priorWorkspace = currentWorkspace.workspaceRoot && currentWorkspace.workspaceToken
              ? {
                workspace_token: currentWorkspace.workspaceToken,
                root: currentWorkspace.workspaceRoot,
                files: [...workspaceFilesRef.current],
                directories: [...workspaceDirectoriesRef.current],
              }
              : null;
            workspaceGenerationRef.current += 1;
            applyWorkspaceSnapshot(restored.workspace);
            const workspaceOpenReceipt = resolved.workspace_open_receipt;
            if (!workspaceOpenReceipt) {
              restoreWorkspaceState(priorWorkspace);
              if (restored.active_file) {
                await discardOpenReceipt(restored.active_file.open_receipt).catch(() => undefined);
              }
              return;
            }
            let workspaceSettlement;
            try {
              workspaceSettlement = await settleOpenIntentWorkspace(
                workspaceOpenReceipt,
                true,
              );
            } catch (error) {
              restoreWorkspaceState(priorWorkspace);
              if (restored.active_file) {
                await discardOpenReceipt(restored.active_file.open_receipt).catch(() => undefined);
              }
              throw error;
            }
            if (workspaceSettlement !== 'applied') {
              restoreWorkspaceState(priorWorkspace);
              if (restored.active_file) {
                await discardOpenReceipt(restored.active_file.open_receipt).catch(() => undefined);
              }
              return;
            }
            const prepared = restored.active_file;
            if (prepared) {
              const appliedGeneration = claimPreparedOpen(
                prepared,
                requestedDocumentGeneration,
              );
              if (appliedGeneration === null) {
                await discardOpenReceipt(prepared.open_receipt).catch(() => undefined);
              } else {
                applied = await applyPreparedOpen(
                  prepared,
                  appliedGeneration,
                  false,
                  discardCurrentCrashDraft,
                ) === 'committed';
              }
            } else {
              applied = true;
            }
          } else {
            applied = true;
          }
          return;
        }
        const currentWorkspace = workspaceIdentityRef.current;
        const priorWorkspace = currentWorkspace.workspaceRoot && currentWorkspace.workspaceToken
          ? {
            workspace_token: currentWorkspace.workspaceToken,
            root: currentWorkspace.workspaceRoot,
            files: [...workspaceFilesRef.current],
            directories: [...workspaceDirectoriesRef.current],
          }
          : null;
        workspaceGenerationRef.current += 1;
        applyWorkspaceSnapshot(resolved.workspace);
        try {
          const workspaceSettlement = await settleOpenIntentWorkspace(
            resolved.workspace_open_receipt,
            true,
          );
          if (workspaceSettlement === 'applied') applied = true;
          else restoreWorkspaceState(priorWorkspace);
        } catch (error) {
          restoreWorkspaceState(priorWorkspace);
          throw error;
        }
      },
    });
    if (targetKind === 'session_restore') settleWorkspaceSessionRestore();
    if (!result || result.status !== 'applied' || !applied) return 'failed';
    return 'accepted';
  }, [
    applyPreparedOpen,
    applyWorkspaceSnapshot,
    claimPreparedOpen,
    executeSessionOperation,
    openIntentResolutionBlocked,
    restoreWorkspaceState,
    settleWorkspaceSessionRestore,
  ]);

  const saveDocumentAs = useCallback(async (
    defaultName: string,
    allowExternalRecovery = false,
  ): Promise<boolean> => {
    if (isPopout || (!allowExternalRecovery && ordinaryDocumentActionsBlocked())) return false;
    const document = currentDocumentSessionState();
    if (!isEditableFileKind(document.activeFileKind)) return true;
    if (document.authorityStatus !== 'committed') return false;
    const contentToSave = document.content;
    const sourcePath = document.activePath;
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
      apply: async (outcome) => {
        if (!outcome) return;
        if (outcome.status !== 'confirmed_committed') {
          if (outcome.status === 'conflict' && outcome.overwrite_token) {
            const resumeExternalAction = allowExternalRecovery ? externalFileActionRef.current : null;
            if (allowExternalRecovery) setExternalFileActionState(null);
            setSaveConflictState({
              busy: false,
              content: contentToSave,
              documentGeneration: requestedDocumentGeneration,
              documentId: document.documentId,
              operationId,
              overwriteToken: outcome.overwrite_token,
              path: outcome.path,
              sourcePath,
              saveKind: 'save-as',
              ...(resumeExternalAction ? { resumeExternalAction } : {}),
            });
            return;
          }
          setError(normalizeAppError(new Error(outcome.message), localeRef.current));
          if (outcome.status === 'indeterminate') lockDocumentAuthorityUnknown();
          return;
        }

        documentGenerationRef.current = requestedDocumentGeneration + 1;
        const savedPath = outcome.path;
        const savedKind = getEditableFileKindForPath(savedPath);
        activeFileVersionRef.current = outcome.version;
        applyDocumentSessionState({
          ...currentDocumentSessionState(),
          activeFileKind: savedKind,
          activeMimeType: savedKind === 'html' ? 'text/html' : null,
          activePath: savedPath,
          lastSavedContent: contentToSave,
        });
        await cleanupConfirmedCrashDraft(contentToSave);
        if (outcome.cleanup_repair_receipt) {
          setNotice('The document was saved, but background cleanup still needs attention.');
        }

        if (!requestedWorkspace
          || !isCurrentWorkspaceRequest(requestedWorkspace, requestedWorkspaceGeneration)) return;
        try {
          await refreshWorkspaceDirect(requestedWorkspace, requestedWorkspaceGeneration);
        } catch (err) {
          if (isCurrentWorkspaceRequest(requestedWorkspace, requestedWorkspaceGeneration)) {
            setError(normalizeAppError(err, localeRef.current));
          }
        }
      },
    });

    return result?.status === 'applied'
      && result.value?.status === 'confirmed_committed'
      && paneStateRef.current.content === contentToSave;
  }, [
    applyDocumentSessionState,
    cleanupConfirmedCrashDraft,
    currentDocumentSessionState,
    executeSessionOperation,
    getActiveWorkspace,
    isCurrentWorkspaceRequest,
    isPopout,
    lockDocumentAuthorityUnknown,
    ordinaryDocumentActionsBlocked,
    refreshWorkspaceDirect,
    setSaveConflictState,
    setExternalFileActionState,
  ]);

  const saveCurrentDocument = useCallback(async (): Promise<boolean> => {
    if (isPopout || ordinaryDocumentActionsBlocked()) return false;
    const document = currentDocumentSessionState();
    if (!isEditableFileKind(document.activeFileKind)) return true;
    if (document.authorityStatus !== 'committed') return false;
    const pathToSave = document.activePath;
    if (!pathToSave) {
      return saveDocumentAs(
        document.activeFileKind === 'excalidraw' ? 'Untitled.excalidraw' : 'Untitled.md',
      );
    }

    const contentToSave = document.content;
    const expectedVersion = activeFileVersionRef.current;
    if (!expectedVersion) {
      setError('The current file version is unavailable. Reopen the document before saving.');
      return false;
    }
    const operationId = createDocumentSaveOperationId();
    const requestedDocumentGeneration = documentGenerationRef.current;
    const requestedWorkspace = getActiveWorkspace();
    const requestedWorkspaceGeneration = workspaceGenerationRef.current;
    const result = await executeSessionOperation({
      run: () => writeFile(pathToSave, contentToSave, expectedVersion, operationId),
      isCurrent: () => documentGenerationRef.current === requestedDocumentGeneration
        && activePathRef.current === pathToSave,
      apply: async (outcome) => {
        if (outcome.status === 'conflict') {
          setAutosaveBlockedContent(contentToSave);
          setSaveConflictState({
            busy: false,
            content: contentToSave,
            documentGeneration: requestedDocumentGeneration,
            documentId: document.documentId,
            operationId,
            path: pathToSave,
            sourcePath: pathToSave,
            saveKind: 'same-file',
          });
          return;
        }
        if (outcome.status !== 'confirmed_committed') {
          setAutosaveBlockedContent(contentToSave);
          setError(normalizeAppError(new Error(outcome.message), localeRef.current));
          if (outcome.status === 'indeterminate') lockDocumentAuthorityUnknown();
          return;
        }
        activeFileVersionRef.current = outcome.version;
        setAutosaveBlockedContent(null);
        paneStateRef.current = {
          ...paneStateRef.current,
          lastSavedContent: contentToSave,
        };
        setLastSavedContent(contentToSave);
        await cleanupConfirmedCrashDraft(contentToSave);
        if (outcome.cleanup_repair_receipt) {
          setNotice('The document was saved, but background cleanup still needs attention.');
        }
        if (!requestedWorkspace
          || !isCurrentWorkspaceRequest(requestedWorkspace, requestedWorkspaceGeneration)) return;
        try {
          await refreshWorkspaceDirect(requestedWorkspace, requestedWorkspaceGeneration);
        } catch (err) {
          if (isCurrentWorkspaceRequest(requestedWorkspace, requestedWorkspaceGeneration)) {
            setError(normalizeAppError(err, localeRef.current));
          }
        }
      },
    });
    const saved = result?.status === 'applied'
      && result.value.status === 'confirmed_committed'
      && paneStateRef.current.content === contentToSave;
    if (!saved) setAutosaveBlockedContent(contentToSave);
    return saved;
  }, [
    cleanupConfirmedCrashDraft,
    currentDocumentSessionState,
    executeSessionOperation,
    getActiveWorkspace,
    isCurrentWorkspaceRequest,
    isPopout,
    lockDocumentAuthorityUnknown,
    ordinaryDocumentActionsBlocked,
    refreshWorkspaceDirect,
    saveDocumentAs,
    setSaveConflictState,
  ]);

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

  const clearActiveDocument = useCallback(() => {
    const current = currentDocumentSessionState();
    applyDocumentSessionState({
      documentId: createPaneProtocolId('pane-document'),
      documentEpoch: current.documentEpoch + 1,
      authorityStatus: 'committed',
      activeFileKind: 'markdown',
      activeMimeType: null,
      activePath: null,
      bytesBase64: null,
      content: EMPTY_MARKDOWN,
      lastSavedContent: EMPTY_MARKDOWN,
      previewRevision: 0,
    });
    activeFileVersionRef.current = null;
    setSaveConflictState(null);
  }, [applyDocumentSessionState, currentDocumentSessionState, setSaveConflictState]);

  const handleNew = useCallback(async () => {
    if (ordinaryDocumentActionsBlocked()) return;
    const priorCrashDocumentId = crashDraftDocumentIdRef.current;
    try {
      await crashDraftSchedulerRef.current?.flush(priorCrashDocumentId);
    } catch {
      setError('The recovery draft could not be saved. The current document remains open.');
      return;
    }
    documentOpenRequestRef.current += 1;
    documentGenerationRef.current += 1;
    clearActiveDocument();
    advanceCrashDraftIdentity(priorCrashDocumentId);
    setError(null);
  }, [advanceCrashDraftIdentity, clearActiveDocument, ordinaryDocumentActionsBlocked]);

  const resolveExternalConflict = useCallback(async (choice: 'keep-current' | 'use-external') => {
    const action = externalFileActionRef.current;
    const accepted = activeDocumentWatchRef.current;
    if (action?.kind !== 'conflict' || !accepted || !activeDocumentWatchTransport) return;
    setExternalFileActionBusy(true);
    try {
      await sessionQueue.enqueue({
        run: () => activeDocumentWatchTransport.reconcile(
          accepted.watchId,
          accepted.documentId,
          accepted.documentGeneration,
        ),
        isCurrent: () => {
          const current = activeDocumentWatchRef.current;
          const currentAction = externalFileActionRef.current;
          return current?.watchId === accepted.watchId
            && current.documentId === accepted.documentId
            && current.documentGeneration === accepted.documentGeneration
            && currentAction?.kind === 'conflict'
            && currentAction.envelope.watch_id === accepted.watchId;
        },
        apply: async (envelope) => {
          const current = activeDocumentWatchRef.current;
          if (!current
            || current.watchId !== accepted.watchId
            || current.documentId !== accepted.documentId
            || current.documentGeneration !== accepted.documentGeneration
            || !envelopeMatchesAcceptedPath(current, envelope)
            || envelope.sequence <= current.resolvedThroughSequence) {
            return;
          }
          current.resolvedThroughSequence = Math.max(
            current.resolvedThroughSequence,
            envelope.sequence,
          );
          current.highestAppliedSequence = Math.max(
            current.highestAppliedSequence,
            envelope.sequence,
          );
          if (choice === 'use-external' && envelope.snapshot.status === 'present') {
            activeFileVersionRef.current = editableFileVersion(envelope.snapshot.file);
          }
          setExternalFileActionState(null);
          const currentDocument = currentDocumentSessionState();
          const decision = choice === 'keep-current'
            ? resolveKeepCurrent(currentDocument, envelope)
            : resolveUseExternal(currentDocument, envelope);
          await applyExternalDocumentDecision(decision, envelope.sequence);
          if (choice === 'keep-current' && envelope.snapshot.status === 'present') {
            setSaveConflictState({
              busy: false,
              content: currentDocument.content,
              documentGeneration: accepted.documentGeneration,
              documentId: currentDocument.documentId,
              operationId: createDocumentSaveOperationId(),
              path: envelope.snapshot.file.path,
              sourcePath: envelope.snapshot.file.path,
              saveKind: 'same-file',
            });
          }
        },
      });
    } catch (watchError) {
      setError(normalizeAppError(watchError, localeRef.current));
    } finally {
      setExternalFileActionBusy(false);
    }
  }, [
    activeDocumentWatchTransport,
    applyExternalDocumentDecision,
    currentDocumentSessionState,
    envelopeMatchesAcceptedPath,
    sessionQueue,
    setSaveConflictState,
    setExternalFileActionState,
  ]);

  const handleCancelSaveConflict = useCallback(() => {
    const pending = saveConflictRef.current;
    if (!pending || pending.busy) return;
    setSaveConflictState(null);
    if (pending.resumeExternalAction) setExternalFileActionState(pending.resumeExternalAction);
    if (pending.overwriteToken) {
      void cancelDocumentOverwriteToken(pending.path, pending.overwriteToken).catch(() => undefined);
    }
  }, [setExternalFileActionState, setSaveConflictState]);

  const handleOverwriteSaveConflict = useCallback(async () => {
    const pending = saveConflictRef.current;
    if (!pending || pending.busy || isPopout) return;
    setSaveConflictState({ ...pending, busy: true });
    const isPendingCurrent = () => {
      const current = saveConflictRef.current;
      return current?.operationId === pending.operationId
        && current.documentId === pending.documentId
        && documentGenerationRef.current === pending.documentGeneration
        && activePathRef.current === pending.sourcePath
        && externalFileActionRef.current === null;
    };
    const result = await executeSessionOperation({
      run: async () => {
        if (!isPendingCurrent()) return null;
        const issuedToken = pending.overwriteToken ?? (await issueDocumentOverwriteToken(
          pending.path, pending.content, pending.operationId,
        )).overwriteToken;
        if (!isPendingCurrent()) {
          await cancelDocumentOverwriteToken(pending.path, issuedToken).catch(() => undefined);
          return null;
        }
        try {
          return await retryDocumentSaveWithToken(
            pending.path,
            pending.content,
            pending.operationId,
            issuedToken,
          );
        } catch (retryError) {
          await cancelDocumentOverwriteToken(pending.path, issuedToken).catch(() => undefined);
          throw retryError;
        }
      },
      isCurrent: isPendingCurrent,
      apply: async (outcome) => {
        if (!outcome) return;
        if (outcome.status !== 'confirmed_committed') {
          setError(normalizeAppError(new Error(outcome.message), localeRef.current));
          setSaveConflictState(null);
          if (outcome.status !== 'indeterminate' && pending.resumeExternalAction) {
            setExternalFileActionState(pending.resumeExternalAction);
          }
          if (outcome.status === 'indeterminate') {
            lockDocumentAuthorityUnknown();
          }
          return;
        }
        activeFileVersionRef.current = outcome.version;
        if (pending.saveKind === 'save-as') {
          documentGenerationRef.current = pending.documentGeneration + 1;
          const savedKind = getEditableFileKindForPath(outcome.path);
          applyDocumentSessionState({
            ...currentDocumentSessionState(),
            activeFileKind: savedKind,
            activeMimeType: savedKind === 'html' ? 'text/html' : null,
            activePath: outcome.path,
            lastSavedContent: pending.content,
          });
        } else {
          paneStateRef.current = { ...paneStateRef.current, lastSavedContent: pending.content };
          setLastSavedContent(pending.content);
        }
        setSaveConflictState(null);
        await cleanupConfirmedCrashDraft(pending.content);
        if (outcome.cleanup_repair_receipt) {
          setNotice('The document was saved, but background cleanup still needs attention.');
        }
        const workspace = getActiveWorkspace();
        if (!workspace) return;
        const generation = workspaceGenerationRef.current;
        try {
          await refreshWorkspaceDirect(workspace, generation);
        } catch (refreshError) {
          if (isCurrentWorkspaceRequest(workspace, generation)) {
            setError(normalizeAppError(refreshError, localeRef.current));
          }
        }
      },
    });
    if (!result && saveConflictRef.current?.operationId === pending.operationId) {
      setSaveConflictState({ ...pending, busy: false });
    }
  }, [
    cleanupConfirmedCrashDraft,
    applyDocumentSessionState,
    currentDocumentSessionState,
    executeSessionOperation,
    getActiveWorkspace,
    isCurrentWorkspaceRequest,
    isPopout,
    lockDocumentAuthorityUnknown,
    refreshWorkspaceDirect,
    setSaveConflictState,
    setExternalFileActionState,
  ]);

  const handleKeepCurrentExternal = useCallback(async () => {
    await resolveExternalConflict('keep-current');
    await handleOverwriteSaveConflict();
  }, [handleOverwriteSaveConflict, resolveExternalConflict]);

  const handleUseExternal = useCallback(async () => {
    await resolveExternalConflict('use-external');
  }, [resolveExternalConflict]);

  const handleSaveDeletedDraftAs = useCallback(async () => {
    const action = externalFileActionRef.current;
    if (action?.kind !== 'deleted-draft') return;
    const deletedPath = action.envelope.snapshot.status === 'missing'
      ? action.envelope.snapshot.path
      : activePathRef.current;
    setExternalFileActionBusy(true);
    try {
      const saved = await saveDocumentAs(displayName(deletedPath), true);
      if (saved && externalFileActionRef.current === action) {
        setExternalFileActionState(null);
      }
    } finally {
      setExternalFileActionBusy(false);
    }
  }, [saveDocumentAs, setExternalFileActionState]);

  const handleCloseDeletedDraft = useCallback(async () => {
    if (externalFileActionRef.current?.kind !== 'deleted-draft') return;
    setExternalFileActionBusy(true);
    try {
      const priorCrashDocumentId = crashDraftDocumentIdRef.current;
      await crashDraftSchedulerRef.current?.flush(priorCrashDocumentId);
      await stopAcceptedActiveDocumentWatch();
      setExternalFileActionState(null);
      documentOpenRequestRef.current += 1;
      documentGenerationRef.current += 1;
      clearActiveDocument();
      advanceCrashDraftIdentity(priorCrashDocumentId);
    } catch {
      setError('The recovery draft could not be saved. The current document remains open.');
    } finally {
      setExternalFileActionBusy(false);
    }
  }, [advanceCrashDraftIdentity, clearActiveDocument, setExternalFileActionState, stopAcceptedActiveDocumentWatch]);

  const createFileInWorkspace = useCallback(async (
    parentPath: string,
    name: string,
    fileKind: Extract<WorkspaceFileKind, 'markdown' | 'excalidraw'> = 'markdown',
  ) => {
    if (ordinaryDocumentActionsBlocked()) return;
    const requestedWorkspace = getActiveWorkspace();
    if (!requestedWorkspace) return;
    const requestedWorkspaceGeneration = workspaceGenerationRef.current;
    const requestedDocumentGeneration = documentGenerationRef.current;

    await executeSessionOperation({
      run: () => createWorkspaceFile(
        requestedWorkspace.workspaceToken,
        parentPath,
        name,
        fileKind,
      ),
      consume: consumeMutationOutcome,
      isCurrent: () => isCurrentWorkspaceRequest(
        requestedWorkspace,
        requestedWorkspaceGeneration,
      ),
      apply: async (outcome) => {
        if (outcome.status !== 'confirmed-committed') return;
        if (documentGenerationRef.current === requestedDocumentGeneration) {
          const priorCrashDocumentId = crashDraftDocumentIdRef.current;
          await crashDraftSchedulerRef.current?.flush(priorCrashDocumentId);
          documentGenerationRef.current = requestedDocumentGeneration + 1;
          applyOpenFileResponse(outcome.receipt.committed);
          advanceCrashDraftIdentity(priorCrashDocumentId);
        }
        const receiptError = await reconcileRequestedWorkspaceReceipt(
          requestedWorkspace,
          requestedWorkspaceGeneration,
          outcome.receipt.workspace,
        );
        if (receiptError) setError(receiptError);
      },
    });
  }, [
    applyOpenFileResponse,
    advanceCrashDraftIdentity,
    consumeMutationOutcome,
    executeSessionOperation,
    getActiveWorkspace,
    isCurrentWorkspaceRequest,
    ordinaryDocumentActionsBlocked,
    reconcileRequestedWorkspaceReceipt,
  ]);

  const createFolderInWorkspace = useCallback(async (parentPath: string, name: string) => {
    if (ordinaryDocumentActionsBlocked()) return;
    const requestedWorkspace = getActiveWorkspace();
    if (!requestedWorkspace) return;
    const requestedGeneration = workspaceGenerationRef.current;

    await executeSessionOperation({
      run: () => createWorkspaceDirectory(
        requestedWorkspace.workspaceToken,
        parentPath,
        name,
      ),
      consume: consumeMutationOutcome,
      isCurrent: () => isCurrentWorkspaceRequest(requestedWorkspace, requestedGeneration),
      apply: async (outcome) => {
        if (outcome.status !== 'confirmed-committed') return;
        const receiptError = await createWorkspaceDirectoryAndReconcile(
          requestedWorkspace,
          parentPath,
          name,
          {
            createDirectory: async () => outcome,
            getCurrentWorkspace: () => workspaceIdentityRef.current,
            applySnapshot: applyWorkspaceSnapshot,
            refresh: () => refreshWorkspaceDirect(requestedWorkspace, requestedGeneration),
          },
        );
        if (receiptError) setError(receiptError);
      },
    });
  }, [
    applyWorkspaceSnapshot,
    consumeMutationOutcome,
    executeSessionOperation,
    getActiveWorkspace,
    isCurrentWorkspaceRequest,
    ordinaryDocumentActionsBlocked,
    refreshWorkspaceDirect,
  ]);

  const renameWorkspaceEntryPath = useCallback(async (path: string, newName: string) => {
    if (ordinaryDocumentActionsBlocked()) return;
    const requestedWorkspace = getActiveWorkspace();
    if (!requestedWorkspace) return;
    const requestedGeneration = workspaceGenerationRef.current;

    await executeSessionOperation({
      run: () => renameWorkspaceEntry(requestedWorkspace.workspaceToken, path, newName),
      consume: consumeMutationOutcome,
      isCurrent: () => isCurrentWorkspaceRequest(requestedWorkspace, requestedGeneration),
      apply: async (outcome) => {
        if (outcome.status !== 'confirmed-committed') return;
        const receiptError = await renameWorkspaceEntryAndReconcile(
          requestedWorkspace,
          path,
          newName,
          {
            renameEntry: async () => outcome,
            getCurrentWorkspace: () => workspaceIdentityRef.current,
            getActivePath: () => activePathRef.current,
            setActivePath: setActiveDocumentPath,
            applySnapshot: applyWorkspaceSnapshot,
            refresh: () => refreshWorkspaceDirect(requestedWorkspace, requestedGeneration),
          },
        );
        if (receiptError) setError(receiptError);
      },
    });
  }, [
    applyWorkspaceSnapshot,
    consumeMutationOutcome,
    executeSessionOperation,
    getActiveWorkspace,
    isCurrentWorkspaceRequest,
    ordinaryDocumentActionsBlocked,
    refreshWorkspaceDirect,
    setActiveDocumentPath,
  ]);

  const moveWorkspaceEntryPath = useCallback(async (
    path: string,
    destinationParentPath: string,
  ) => {
    if (ordinaryDocumentActionsBlocked()) return;
    const requestedWorkspace = getActiveWorkspace();
    if (!requestedWorkspace) return;
    const requestedGeneration = workspaceGenerationRef.current;

    await executeSessionOperation({
      run: () => moveWorkspaceEntry(
        requestedWorkspace.workspaceToken,
        path,
        destinationParentPath,
      ),
      consume: consumeMutationOutcome,
      isCurrent: () => isCurrentWorkspaceRequest(requestedWorkspace, requestedGeneration),
      apply: async (outcome) => {
        if (outcome.status !== 'confirmed-committed') return;
        const receiptError = await moveWorkspaceEntryAndReconcile(
          requestedWorkspace,
          path,
          destinationParentPath,
          {
            moveEntry: async () => outcome,
            getCurrentWorkspace: () => workspaceIdentityRef.current,
            getActivePath: () => activePathRef.current,
            setActivePath: setActiveDocumentPath,
            applySnapshot: applyWorkspaceSnapshot,
            refresh: () => refreshWorkspaceDirect(requestedWorkspace, requestedGeneration),
          },
        );
        if (receiptError) setError(receiptError);
      },
    });
  }, [
    applyWorkspaceSnapshot,
    consumeMutationOutcome,
    executeSessionOperation,
    getActiveWorkspace,
    isCurrentWorkspaceRequest,
    ordinaryDocumentActionsBlocked,
    refreshWorkspaceDirect,
    setActiveDocumentPath,
  ]);

  const deleteWorkspaceEntryPath = useCallback(async (path: string) => {
    if (ordinaryDocumentActionsBlocked()) return;
    const requestedWorkspace = getActiveWorkspace();
    if (!requestedWorkspace) return;
    const requestedGeneration = workspaceGenerationRef.current;

    await executeSessionOperation({
      run: () => deleteWorkspaceEntry(requestedWorkspace.workspaceToken, path),
      consume: consumeMutationOutcome,
      isCurrent: () => isCurrentWorkspaceRequest(requestedWorkspace, requestedGeneration),
      apply: async (outcome) => {
        if (outcome.status !== 'confirmed-committed') return;
        const receiptError = await deleteWorkspaceEntryAndReconcile(
          requestedWorkspace,
          path,
          {
            deleteEntry: async () => outcome,
            getCurrentWorkspace: () => workspaceIdentityRef.current,
            getActivePath: () => activePathRef.current,
            clearActiveDocument,
            applySnapshot: applyWorkspaceSnapshot,
            refresh: () => refreshWorkspaceDirect(requestedWorkspace, requestedGeneration),
          },
        );
        if (receiptError) setError(receiptError);
      },
    });
  }, [
    applyWorkspaceSnapshot,
    clearActiveDocument,
    consumeMutationOutcome,
    executeSessionOperation,
    getActiveWorkspace,
    isCurrentWorkspaceRequest,
    ordinaryDocumentActionsBlocked,
    refreshWorkspaceDirect,
  ]);

  const updateContent = useCallback((nextContent: string) => {
    if (
      !isPopout
      && !workspaceSessionRestoreSettledRef.current
      && activePathRef.current === null
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

  const recoverCrashDraft = useCallback(async (draft: CrashDraftRecoverResponse) => {
    if (isPopout) return;
    const priorCrashDocumentId = crashDraftDocumentIdRef.current;
    await crashDraftSchedulerRef.current?.flush(priorCrashDocumentId);
    await stopAcceptedActiveDocumentWatch();
    documentOpenRequestRef.current += 1;
    documentGenerationRef.current += 1;
    crashDraftSchedulerRef.current?.invalidate(priorCrashDocumentId);
    crashDraftDocumentIdRef.current = draft.documentId;
    forcedDirtyCrashDraftIdRef.current = draft.documentId;
    activeFileVersionRef.current = null;
    const current = currentDocumentSessionState();
    applyDocumentSessionState({
      documentId: createPaneProtocolId('pane-document'),
      documentEpoch: current.documentEpoch + 1,
      authorityStatus: 'committed',
      activeFileKind: draft.fileKind,
      activeMimeType: draft.fileKind === 'html' ? 'text/html' : null,
      activePath: null,
      bytesBase64: null,
      content: draft.content,
      lastSavedContent: draft.content,
      previewRevision: 0,
    });
    setExternalFileActionState(null);
    setSaveConflictState(null);
  }, [
    applyDocumentSessionState,
    currentDocumentSessionState,
    isPopout,
    setExternalFileActionState,
    setSaveConflictState,
    stopAcceptedActiveDocumentWatch,
  ]);

  const seedCrashDraftRevision = useCallback((documentId: string, revision: number, entryToken: string) => {
    crashDraftSchedulerRef.current?.seedRevision(documentId, revision, entryToken);
  }, []);

  const getCrashDraftStoredEntryToken = useCallback((documentId: string) => (
    crashDraftSchedulerRef.current?.getStoredEntryToken(documentId) ?? null
  ), []);

  const confirmCrashDraftDiscarded = useCallback((documentId: string, entryToken: string) => {
    crashDraftSchedulerRef.current?.confirmDiscarded(documentId, entryToken);
  }, []);

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

  useEffect(() => {
    if (isPopout
      || !dirty
      || authorityStatus !== 'committed'
      || !isEditableFileKind(activeFileKind)) return;
    const version = activeFileVersionRef.current;
    if (activePath && !version) return;
    try {
      scheduleCurrentCrashDraft();
    } catch {
      setError('Crash recovery could not save the current edits. Your work remains in the editor.');
    }
  }, [activeFileKind, activePath, authorityStatus, content, dirty, documentIdentity.documentEpoch, isPopout, scheduleCurrentCrashDraft]);

  useEffect(() => {
    if (isPopout
      || !autosaveEnabled
      || !dirty
      || !activePath
      || !isEditableFileKind(activeFileKind)
      || authorityStatus !== 'committed'
      || !activeFileVersionRef.current
      || externalFileAction !== null
      || saveConflict !== null
      || autosaveBlockedContent === content
      || busy) return undefined;
    const timer = globalThis.setTimeout(() => {
      void saveCurrentDocument();
    }, Math.max(250, Math.min(60_000, autosaveDelayMs)));
    return () => globalThis.clearTimeout(timer);
  }, [
    activeFileKind,
    activePath,
    authorityStatus,
    autosaveDelayMs,
    autosaveEnabled,
    autosaveBlockedContent,
    busy,
    content,
    dirty,
    externalFileAction,
    isPopout,
    saveConflict,
    saveCurrentDocument,
  ]);

  return {
    activeFileKind,
    activeMimeType,
    activePath,
    authorityStatus,
    broadcastPaneState,
    busy,
    bytesBase64,
    content,
    dirty,
    createFileInWorkspace,
    createFolderInWorkspace,
    deleteWorkspaceEntryPath,
    documentEpoch: documentIdentity.documentEpoch,
    documentId: documentIdentity.documentId,
    error,
    externalFileAction: externalFileActionDialog,
    files,
    fileTree,
    flushWorkspaceSession,
    flushCrashDraft,
    handleNew,
    handleOpenDirectory,
    handleOpenFile,
    handleOpenRecent,
    handleClearRecent,
    handleCloseDeletedDraft,
    handleKeepCurrentExternal,
    handleCancelSaveConflict,
    handleOverwriteSaveConflict,
    handleSave,
    handleSaveAs,
    handleSaveDeletedDraftAs,
    handleUseExternal,
    lastSavedContent,
    moveWorkspaceEntryPath,
    notice,
    openWorkspaceIndexResult,
    openWorkspaceFilePath,
    resolveOpenIntentRequest,
    settleWorkspaceSessionRestore,
    previewRevision,
    renameWorkspaceEntryPath,
    refreshWorkspace,
    recoverCrashDraft,
    saveCurrentDocument,
    saveConflict: saveConflictDialog,
    seedCrashDraftRevision,
    getCrashDraftStoredEntryToken,
    confirmCrashDraftDiscarded,
    setError,
    setNotice,
    updateContent,
    workspaceRoot,
    workspaceSessionRestoreSettled,
    workspaceToken: workspaceIdentityRef.current.workspaceToken,
  };
}
