/* eslint-disable react-hooks/exhaustive-deps -- 子模块输出经解构进入回调，插件无法跨 deps 对象静态追踪；依赖数组保持搬移前原样，由 useDocumentSession.test.tsx 回归约束 */
import { useRef, useState } from 'react';
import { EMPTY_MARKDOWN } from '../../lib/documentNames';
import { isTauriRuntime } from '../../lib/activeDocumentWatch';
import { createDocumentSessionQueue } from '../../lib/documentSessionQueue';
import type { DocumentAuthorityStatus, WorkspaceIdentity } from '../../lib/documentSession';
import { createCrashDraftDocumentId, type CrashDraftScheduler } from '../../lib/crashDrafts';
import { createPaneProtocolId, createTauriPaneReplication } from '../../lib/tauriPaneReplication';
import { useI18n } from '../../lib/i18n';
import type {
  AutosaveMode,
  FileVersion,
  WorkspaceDirectoryEntry,
  WorkspaceFileEntry,
  WorkspaceFileKind,
} from '../../types';
import type {
  AcceptedActiveDocumentWatch,
  ExternalFileActionState,
  PendingDocumentSaveConflict,
  UseDocumentSessionInput,
} from './sessionTypes';

export function useDocumentSessionState({ isPopout }: UseDocumentSessionInput) {
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
  const busyRef = useRef(false);
  busyRef.current = busy;
  const autosaveBlockedContentRef = useRef<string | null>(null);
  autosaveBlockedContentRef.current = autosaveBlockedContent;
  const [workspaceSessionRestoreSettled, setWorkspaceSessionRestoreSettled] = useState(
    () => !restoreWorkspaceSessionOnMount,
  );
  const [documentIdentity, setDocumentIdentity] = useState(() => ({
    documentId: createPaneProtocolId('pane-document'),
    documentEpoch: 0,
  }));
  return {
    localeRef, restoreWorkspaceSessionOnMount,
    workspaceRoot, setWorkspaceRoot, files, setFiles, directories, setDirectories,
    activeFileKind, setActiveFileKind, activeMimeType, setActiveMimeType, activePath, setActivePath,
    bytesBase64, setBytesBase64, content, setContent, lastSavedContent, setLastSavedContent,
    previewRevision, setPreviewRevision, authorityStatus, setAuthorityStatus, error, setError,
    notice, setNotice, externalFileAction, setExternalFileAction,
    externalFileActionBusy, setExternalFileActionBusy, saveConflict, setSaveConflict,
    busy, setBusy, autosaveBlockedContent, setAutosaveBlockedContent, busyRef, autosaveBlockedContentRef,
    workspaceSessionRestoreSettled, setWorkspaceSessionRestoreSettled,
    documentIdentity, setDocumentIdentity,
  };
}

export function useDocumentSessionRefs(restoreWorkspaceSessionOnMount: boolean) {
  const workspaceRollbackIdRef = useRef(0);
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
  const sessionQueueRef = useRef<ReturnType<typeof createDocumentSessionQueue> | null>(null);
  if (!sessionQueueRef.current) sessionQueueRef.current = createDocumentSessionQueue();
  const sessionQueue = sessionQueueRef.current;
  return {
    workspaceRollbackIdRef, documentGenerationRef, documentOpenRequestRef, workspaceGenerationRef,
    workspaceSessionPersistRevisionRef, workspaceSessionPersistTailRef, workspaceSessionRestoreMountedRef,
    workspaceSessionRestoreSettledRef, workspaceFilesRef, workspaceDirectoriesRef, activePathRef,
    activeFileVersionRef, crashDraftSchedulerRef, crashDraftDocumentIdRef, forcedDirtyCrashDraftIdRef,
    saveConflictRef, activeDocumentWatchRef, externalFileActionRef, paneReplicationRef,
    workspaceIdentityRef, sessionQueue,
  };
}

type DocumentSessionStateBundle = ReturnType<typeof useDocumentSessionState>;
type DocumentSessionRefBundle = ReturnType<typeof useDocumentSessionRefs>;
export type DocumentSessionStores = Omit<UseDocumentSessionInput, 'autosaveEnabled' | 'autosaveDelayMs' | 'autosaveMode'>
  & { autosaveEnabled: boolean; autosaveDelayMs: number; autosaveMode: AutosaveMode }
  & DocumentSessionStateBundle & DocumentSessionRefBundle;
