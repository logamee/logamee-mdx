import {
  lazy,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from 'react';
import { Settings } from 'lucide-react';
import { emit, emitTo, listen } from '@tauri-apps/api/event';
import { AppToolbar } from './components/AppToolbar';
import type { DocxPreviewFeedback } from './components/DocxPreview';
import { EditorPane, type ClipboardImagePasteRequest } from './components/EditorPane';
import { ExternalFileChangeDialog } from './components/ExternalFileChangeDialog';
import { DocumentSaveConflictDialog } from './components/DocumentSaveConflictDialog';
import { CrashDraftStoreRepairDialog } from './components/CrashDraftStoreRepairDialog';
import { FeedbackDialog } from './components/FeedbackDialog';
import { ExportDialog, type ExportDialogValue } from './components/ExportDialog';
import { SettingsDialog } from './components/SettingsDialog';
import { QuickOpenDialog } from './components/QuickOpenDialog';
import {
  WorkspaceSearchDialog,
  type WorkspaceSearchMode,
  type WorkspaceSearchSelection,
} from './components/WorkspaceSearchDialog';
import { FileSidebar } from './components/FileSidebar';
import JinxiuMarkdown from './components/JinxiuMarkdown';
import { LazyPreviewBoundary } from './components/LazyPreviewBoundary';
import { PaneResizer } from './components/PaneResizer';
import type { PdfPreviewFeedback } from './components/PdfPreview';
import { PopoutPaneShell } from './components/PopoutPaneShell';
import { PreviewPane } from './components/PreviewPane';
import { UnsavedExitDialog } from './components/UnsavedExitDialog';
import { UpdateAvailableDialog } from './components/UpdateAvailableDialog';
import { WorkspaceEntryDialog, type WorkspaceEntryOperation } from './components/WorkspaceEntryDialog';
import { WorkspaceImagePreview } from './components/WorkspaceImagePreview';
import { WorkspaceHtmlPreview } from './components/WorkspaceHtmlPreview';
import { WorkspaceMediaPreview } from './components/WorkspaceMediaPreview';
import { WorkspaceMoveDialog, type WorkspaceMoveOperation } from './components/WorkspaceMoveDialog';
import { WorkspaceSidebarResizer } from './components/WorkspaceSidebarResizer';
import { useDocumentSession } from './hooks/useDocumentSession';
import { useCrashDraftRecovery } from './hooks/useCrashDraftRecovery';
import { usePanePopouts } from './hooks/usePanePopouts';
import { usePaneResize } from './hooks/usePaneResize';
import { useProgramCloseGuard } from './hooks/useProgramCloseGuard';
import { useSettings } from './hooks/useSettings';
import { useAppUpdater } from './hooks/useAppUpdater';
import { useI18n } from './lib/i18n';
import { isTauriRuntime } from './lib/activeDocumentWatch';
import type { EffectiveLocale } from './lib/locale';
import { useWorkspaceSidebarResize } from './hooks/useWorkspaceSidebarResize';
import { APP_FEEDBACK_ERROR_EVENT, getFeedbackDialog, normalizeAppError } from './lib/appFeedback';
import { getUnsavedExitPrompt, getUnsavedFileSwitchPrompt } from './lib/closeGuard';
import {
  decodeNativeMenuCommand,
  isNativeSaveMenuEnabled,
  NATIVE_MENU_EVENT,
} from './lib/nativeMenu';
import {
  getPaneLayoutStyle,
  getPanePopoutLabel,
  parsePopoutInstanceId,
  parsePopoutPane,
} from './lib/paneLayout';
import { loadLazyModuleWithRetry } from './lib/lazyModule';
import { resolveShortcutProfile, shortcutMatchesEvent, type ShortcutAction } from './lib/shortcutProfiles';
import { resolveThemeForAppearance } from './lib/theme';
import { useObservedEffectiveTheme } from './lib/themeObservation';
import {
  decodeMarkdownOutlineJump,
  extractMarkdownOutline,
  OUTLINE_JUMP_EVENT,
  type MarkdownOutlineItem,
  type MarkdownOutlineJump,
} from './lib/markdownOutline';
import {
  createMarkdownImageReference,
  createMarkdownMediaReference,
  decodeMarkdownMediaCursorInsertion,
  decodeMarkdownMediaInsertionHandshake,
  decodeMarkdownMediaInsertionReady,
  decodeMarkdownMediaInsertionReadyRequest,
  MARKDOWN_MEDIA_INSERTION_EVENT,
  MARKDOWN_MEDIA_INSERTION_HANDSHAKE_ACK_EVENT,
  MARKDOWN_MEDIA_INSERTION_HANDSHAKE_EVENT,
  MARKDOWN_MEDIA_INSERTION_REQUEST_READY_EVENT,
  MARKDOWN_MEDIA_INSERTION_READY_EVENT,
  type MarkdownMediaCursorInsertion,
  type MarkdownMediaInsertionHandshake,
  type MarkdownMediaInsertionReady,
  type MarkdownMediaInsertion,
  type MarkdownMediaInsertionTarget,
} from './lib/markdownMedia';
import { createPaneProtocolId } from './lib/tauriPaneReplication';
import {
  DEFAULT_WORKSPACE_SIDEBAR_WIDTH,
  getWorkspaceLayoutClassName,
  getWorkspaceSidebarLayoutStyle,
} from './lib/sidebarLayout';
import {
  authorizeResourceDirectory,
  discardWorkspaceIndex,
  discardOpenIntent,
  focusMainWindow,
  getPackagedOpenE2eConfig,
  peekOpenIntent,
  recordPackagedOpenAppEvent,
  rebuildWorkspaceIndex,
  requestSessionRestore,
  saveExcalidrawBundle,
  saveExport,
  setNativeSaveMenuEnabled,
  writeWorkspaceResource,
  type ResourceDirectoryAuthorization,
  type PackagedOpenAppEventType,
  type PackagedOpenE2eConfig,
} from './lib/tauriCommands';
import { collectExportPreflightIssues, type ExportPreflightIssue } from './lib/exportPreflight';
import {
  adaptBackendOpenIntent,
  createLocalOpenIntent,
  OPEN_INTENT_FOCUS_EVENT,
  OPEN_INTENT_PENDING_EVENT,
  type AppOpenIntent,
  type LocalOpenIntentAction,
  type LocalOpenIntentSource,
} from './lib/openIntent';
import { OpenIntentCoordinator } from './lib/openIntentCoordinator';
import { createWorkspaceIndexOperationId } from './lib/workspaceSearch';
import { crashDraftCommands } from './lib/crashDraftCommands';
import { getWorkspaceMoveDestinations } from './lib/fileTreeOperations';
import { getWorkspacePresentation } from './lib/workspaceFileKind';
import type { WorkspaceFileEntry } from './types';
import './styles.css';

const LazyDocxPreview = lazy(() => import('./components/DocxPreview').then((module) => ({
  default: module.DocxPreview,
})));
const LazyExcalidrawPane = lazy(async () => {
  try {
    const module = await loadLazyModuleWithRetry(() => import('./components/ExcalidrawPane'));
    return { default: module.ExcalidrawPane };
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`Failed to load Excalidraw preview module: ${detail}`);
  }
});
const LazyPdfPreview = lazy(() => import('./components/PdfPreview').then((module) => ({
  default: module.PdfPreview,
})));
const MAIN_WINDOW_LABEL = 'main';

interface PendingMarkdownMediaInsertionHandshake {
  attempt: number;
  generation: number;
  handshake: MarkdownMediaInsertionHandshake;
  retryTimer: ReturnType<typeof globalThis.setTimeout> | null;
  sending: boolean;
}

type PendingMarkdownMediaCursorInsertion = Omit<MarkdownMediaCursorInsertion, 'popoutInstanceId'>;

interface MarkdownMediaRetryController {
  cancelled: boolean;
  pendingTimers: Map<ReturnType<typeof globalThis.setTimeout>, () => void>;
}

const MEDIA_EVENT_RETRY_DELAYS_MS = [0, 100, 250] as const;
const MEDIA_INSERTION_HANDSHAKE_ATTEMPTS = 3;
const MEDIA_INSERTION_HANDSHAKE_ACK_TIMEOUT_MS = 250;

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunkSize = 32_768;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function createMarkdownMediaRetryController(): MarkdownMediaRetryController {
  return { cancelled: false, pendingTimers: new Map() };
}

function cancelMarkdownMediaRetries(controller: MarkdownMediaRetryController): void {
  controller.cancelled = true;
  for (const [timer, resolve] of controller.pendingTimers) {
    globalThis.clearTimeout(timer);
    resolve();
  }
  controller.pendingTimers.clear();
}

function waitForRetry(
  delayMs: number,
  controller: MarkdownMediaRetryController | undefined,
): Promise<boolean> {
  if (controller?.cancelled) return Promise.resolve(false);
  return new Promise((resolve) => {
    const complete = () => resolve(!controller?.cancelled);
    const timer = globalThis.setTimeout(() => {
      controller?.pendingTimers.delete(timer);
      complete();
    }, delayMs);
    controller?.pendingTimers.set(timer, complete);
  });
}

function cancelMarkdownMediaInsertionHandshake(
  pending: PendingMarkdownMediaInsertionHandshake | null,
): void {
  if (pending?.retryTimer !== null && pending?.retryTimer !== undefined) {
    globalThis.clearTimeout(pending.retryTimer);
    pending.retryTimer = null;
  }
}

async function emitToWithRetry(
  target: string,
  event: string,
  payload: unknown,
  isCurrent: () => boolean,
  retryController?: MarkdownMediaRetryController,
): Promise<void> {
  let lastError: unknown;
  for (const delayMs of MEDIA_EVENT_RETRY_DELAYS_MS) {
    if (delayMs > 0 && !await waitForRetry(delayMs, retryController)) return;
    if (retryController?.cancelled || !isCurrent()) return;
    try {
      await emitTo(target, event, payload);
      return;
    } catch (err) {
      lastError = err;
    }
  }
  if (!retryController?.cancelled && isCurrent()) throw lastError;
}

interface LazyPreviewWrapperProps {
  loadingLabel: string;
  locale: EffectiveLocale;
}

function DocxPreview({ loadingLabel, locale, ...props }:
ComponentProps<typeof LazyDocxPreview> & LazyPreviewWrapperProps) {
  return (
    <LazyPreviewBoundary loadingLabel={loadingLabel} locale={locale}>
      <LazyDocxPreview {...props} />
    </LazyPreviewBoundary>
  );
}

function ExcalidrawPane({ loadingLabel, locale, ...props }:
ComponentProps<typeof LazyExcalidrawPane> & LazyPreviewWrapperProps) {
  return (
    <LazyPreviewBoundary loadingLabel={loadingLabel} locale={locale}>
      <LazyExcalidrawPane {...props} />
    </LazyPreviewBoundary>
  );
}

function PdfPreview({ loadingLabel, locale, ...props }:
ComponentProps<typeof LazyPdfPreview> & LazyPreviewWrapperProps) {
  return (
    <LazyPreviewBoundary loadingLabel={loadingLabel} locale={locale}>
      <LazyPdfPreview {...props} />
    </LazyPreviewBoundary>
  );
}

function currentPopoutPane() {
  return typeof window === 'undefined' ? 'main' : parsePopoutPane(window.location.search);
}

function currentEditorPopoutInstanceId() {
  return typeof window === 'undefined' ? null : parsePopoutInstanceId(window.location.search);
}

function getWorkspaceRelativePath(workspaceRoot: string | null, path: string | null): string | null {
  if (!workspaceRoot || !path) return null;
  const normalizedRoot = workspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  const normalizedPath = path.replace(/\\/g, '/');
  const prefix = normalizedRoot === '/' ? '/' : `${normalizedRoot}/`;
  if (!normalizedPath.startsWith(prefix)) return null;
  const relativePath = normalizedPath.slice(prefix.length);
  if (!relativePath || relativePath.split('/').some((segment) => !segment || segment === '.' || segment === '..')) return null;
  return relativePath;
}

function getPackagedOpenStep(
  intent: Extract<AppOpenIntent, { origin: 'backend' }>,
  config: PackagedOpenE2eConfig,
): string | null {
  if (intent.source === 'session_restore') return 'session-restore';
  const { paths } = config;
  if (intent.displayPath === paths.primaryFile) return 'cli-primary';
  if (intent.displayPath === paths.unicodeFile) return 'cli-secondary-unicode';
  if (intent.displayPath === paths.workspaceDirectory) return 'cli-directory';
  if (intent.displayPath === paths.staleFile) return 'cli-stale';
  if (intent.displayPath === paths.associationFile) return 'file-association';
  return null;
}

function getPackagedSpellcheckEvidence() {
  const realEditors = [...document.querySelectorAll(
    '.editor-pane:not(.popout-pane) .editor-host .cm-content',
  )];
  const enabledRealEditors = realEditors.filter((editor) => editor.getAttribute('spellcheck') === 'true');
  const realEditorSet = new Set(realEditors);
  const enabledNonEditors = [...document.querySelectorAll('[spellcheck="true"]')]
    .filter((element) => !realEditorSet.has(element));
  return {
    realEditorCount: realEditors.length,
    enabledRealEditorCount: enabledRealEditors.length,
    enabledNonEditorCount: enabledNonEditors.length,
    dictionaryConsistency: 'not_claimed',
  };
}

const PACKAGED_UNICODE_READY_POLL_INTERVAL_MS = 50;
const PACKAGED_UNICODE_READY_MAX_ATTEMPTS = 200;
const PACKAGED_DIRTY_SEED = '<!-- mmd-packaged-open-dirty -->';

function isAbsoluteResourceDirectory(value: string): boolean {
  return value.startsWith('/')
    || value.startsWith('\\\\')
    || /^[A-Za-z]:[\\/]/u.test(value);
}

interface MutableBooleanRef {
  current: boolean;
}

export function updatePackagedSettlementBarrier(
  barrierRef: MutableBooleanRef,
  setRenderedActive: (active: boolean) => void,
  active: boolean,
): void {
  barrierRef.current = active;
  setRenderedActive(active);
}

export function syncOpenIntentCoordinatorModalState(
  coordinator: Pick<OpenIntentCoordinator, 'setModalActive'>,
  renderedModalActive: boolean,
  barrierRef: Readonly<MutableBooleanRef>,
): void {
  coordinator.setModalActive(renderedModalActive || barrierRef.current);
}

export default function App() {
  const { locale, t } = useI18n();
  const { appearance, skin } = useObservedEffectiveTheme();
  const packagedOpenEvidenceEnabled = import.meta.env.VITE_MMD_PACKAGED_OPEN_E2E === '1';
  const popoutPane = useMemo(() => currentPopoutPane(), []);
  const isPopout = popoutPane !== 'main';
  const appUpdater = useAppUpdater(isTauriRuntime() && !isPopout);
  const [editorPopoutInstanceId] = useState(() => (
    popoutPane === 'editor'
      ? currentEditorPopoutInstanceId() ?? createPaneProtocolId('markdown-media-popout')
      : null
  ));
  const [showUnsavedExitPrompt, setShowUnsavedExitPrompt] = useState(false);
  const [workspaceSearchMode, setWorkspaceSearchMode] = useState<WorkspaceSearchMode | null>(null);
  const [pendingOpenIntent, setPendingOpenIntent] = useState<AppOpenIntent | null>(null);
  const [packagedOpenConfig, setPackagedOpenConfig] = useState<PackagedOpenE2eConfig | null | undefined>(
    () => packagedOpenEvidenceEnabled ? undefined : null,
  );
  const [pendingPackagedSettlement, setPendingPackagedSettlement] = useState<{
    intent: Extract<AppOpenIntent, { origin: 'backend' }>;
    status: 'accepted' | 'cancelled' | 'failed';
  } | null>(null);
  const [packagedSettlementBarrierActive, setPackagedSettlementBarrierState] = useState(false);
  const [packagedDirtySeedPending, setPackagedDirtySeedPending] = useState(false);
  const [openIntentPollRevision, setOpenIntentPollRevision] = useState(0);
  const [workspaceEntryOperation, setWorkspaceEntryOperation] = useState<WorkspaceEntryOperation | null>(null);
  const [workspaceMoveOperation, setWorkspaceMoveOperation] = useState<WorkspaceMoveOperation | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [workspaceIndexActionBusy, setWorkspaceIndexActionBusy] = useState(false);
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(() => new Set());
  const [fileTreeCollapsed, setFileTreeCollapsed] = useState(false);
  const [editorPaneRatio, setEditorPaneRatio] = useState(0.5);
  const [workspaceSidebarWidth, setWorkspaceSidebarWidth] = useState(DEFAULT_WORKSPACE_SIDEBAR_WIDTH);
  const [outlineJump, setOutlineJump] = useState<MarkdownOutlineJump | null>(null);
  const [mediaInsertion, setMediaInsertion] = useState<MarkdownMediaInsertion | null>(null);
  const nativeSaveMenuSyncRef = useRef<Promise<void>>(Promise.resolve());
  const outlineJumpRequestIdRef = useRef(0);
  const mediaInsertionRequestIdRef = useRef(0);
  const mediaInsertionHighWaterRef = useRef(new Map<string, number>());
  const pendingPopoutMediaInsertionsRef = useRef<PendingMarkdownMediaCursorInsertion[]>([]);
  const popoutMediaInsertionTailRef = useRef<Promise<void>>(Promise.resolve());
  const popoutMediaInsertionGenerationRef = useRef(0);
  const editorPopoutReadyRef = useRef<MarkdownMediaInsertionReady | null>(null);
  const editorPopoutHandshakeRef = useRef<PendingMarkdownMediaInsertionHandshake | null>(null);
  const startEditorPopoutHandshakeRef = useRef<((ready: MarkdownMediaInsertionReady) => void) | null>(null);
  const editorPopoutOpenRef = useRef(false);
  const expectedEditorPopoutInstanceIdRef = useRef<string | null>(null);
  const pendingEditorPopoutReadyRequestIdRef = useRef<string | null>(null);
  const editorPopoutOpenRequestRef = useRef<Promise<void> | null>(null);
  const markdownMediaRetryControllerRef = useRef(createMarkdownMediaRetryController());
  const mountedRef = useRef(true);
  const localOpenIntentSequenceRef = useRef(0);
  const openIntentSettlementRef = useRef(new Set<string>());
  const activeOpenIntentIdRef = useRef<string | null>(null);
  const sessionRestoreRequestStateRef = useRef<'pending' | 'requested' | 'failed'>('pending');
  const packagedEvidenceTailRef = useRef(Promise.resolve());
  const packagedActivationEvidenceRef = useRef(new Set<string>());
  const packagedModalEvidenceRef = useRef(new Set<string>());
  const packagedDirtySeededRef = useRef(false);
  const packagedAutomatedDecisionRef = useRef(new Set<string>());
  const packagedSettlementBarrierRef = useRef(false);
  const setPackagedSettlementBarrierActive = useCallback((active: boolean) => {
    updatePackagedSettlementBarrier(
      packagedSettlementBarrierRef,
      setPackagedSettlementBarrierState,
      active,
    );
  }, []);
  const openIntentCoordinatorRef = useRef<OpenIntentCoordinator | null>(null);
  if (!openIntentCoordinatorRef.current) {
    openIntentCoordinatorRef.current = new OpenIntentCoordinator({
      onActivate: (intent) => {
        activeOpenIntentIdRef.current = intent.id;
        setPendingOpenIntent(intent);
        if (intent.origin === 'backend') void focusMainWindow(intent.id, false).catch(() => undefined);
      },
      onSettle: (intent, settlement) => {
        if (activeOpenIntentIdRef.current === intent.id) activeOpenIntentIdRef.current = null;
        openIntentSettlementRef.current.delete(intent.id);
        if (intent.origin === 'backend' && packagedOpenEvidenceEnabled) {
          setPendingPackagedSettlement({ intent, status: settlement.kind });
        } else {
          setOpenIntentPollRevision((revision) => revision + 1);
        }
        setPendingOpenIntent((current) => current?.id === intent.id ? null : current);
      },
    });
  }
  const openIntentCoordinator = openIntentCoordinatorRef.current;
  const enqueueLocalOpenIntent = useCallback((
    source: LocalOpenIntentSource,
    displayPath: string,
    action: LocalOpenIntentAction,
  ) => {
    localOpenIntentSequenceRef.current += 1;
    openIntentCoordinator.enqueue(createLocalOpenIntent(
      `local-open-intent-${localOpenIntentSequenceRef.current}`,
      source,
      displayPath,
      action,
    ));
  }, [openIntentCoordinator]);
  const paneLayoutStyle = useMemo(() => getPaneLayoutStyle(editorPaneRatio), [editorPaneRatio]);
  const settingsState = useSettings();
  const [resourceDirectoryAuthorization, setResourceDirectoryAuthorization] = useState<
    ResourceDirectoryAuthorization | null
  >(null);
  const afterConfirmedCrashDraftSaveRef = useRef<((documentId: string) => Promise<boolean>) | null>(null);
  const afterConfirmedCrashDraftSave = useCallback((documentId: string) => (
    afterConfirmedCrashDraftSaveRef.current?.(documentId) ?? Promise.resolve(true)
  ), []);

  useEffect(() => {
    if (settingsState.settings) setEditorPaneRatio(settingsState.settings.editorPaneRatio);
  }, [settingsState.settings]);

  const {
    activeFileKind,
    activeMimeType,
    activePath,
    authorityStatus,
    broadcastPaneState,
    busy,
    bytesBase64,
    content,
    createFileInWorkspace,
    createFolderInWorkspace,
    deleteWorkspaceEntryPath,
    dirty,
    documentEpoch,
    documentId,
    error,
    externalFileAction,
    files = [],
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
    moveWorkspaceEntryPath,
    notice,
    openWorkspaceIndexResult,
    openWorkspaceFilePath,
    resolveOpenIntentRequest,
    previewRevision,
    renameWorkspaceEntryPath,
    refreshWorkspace,
    recoverCrashDraft,
    saveCurrentDocument,
    saveConflict,
    seedCrashDraftRevision,
    getCrashDraftStoredEntryToken,
    confirmCrashDraftDiscarded,
    setError,
    setNotice,
    settleWorkspaceSessionRestore,
    updateContent,
    workspaceRoot,
    workspaceToken,
  } = useDocumentSession({
    isPopout,
    popoutPane,
    autosaveEnabled: settingsState.settings?.autosaveEnabled ?? false,
    autosaveDelayMs: settingsState.settings?.autosaveDelayMs ?? 1500,
    afterConfirmedSave: afterConfirmedCrashDraftSave,
  });
  const currentContentRef = useRef(content);
  currentContentRef.current = content;
  const [showExport, setShowExport] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const [exportValue, setExportValue] = useState<ExportDialogValue>({ format: 'html', scale: 2, theme: 'current' });
  const [exportIssues, setExportIssues] = useState<ExportPreflightIssue[]>([]);

  const requestCrashDraftRecovery = useCallback((draft: Parameters<typeof recoverCrashDraft>[0]) => {
    enqueueLocalOpenIntent(
      'crash_recovery',
      draft.pathHint ?? draft.documentId,
      { kind: 'crash_draft', draft },
    );
  }, [enqueueLocalOpenIntent]);

  const crashDraftRecovery = useCrashDraftRecovery({
    enabled: false,
    commands: crashDraftCommands,
    onRecoverDraft: requestCrashDraftRecovery,
    seedRevision: seedCrashDraftRevision,
    getStoredEntryToken: getCrashDraftStoredEntryToken,
    confirmDiscarded: confirmCrashDraftDiscarded,
  });
  afterConfirmedCrashDraftSaveRef.current = crashDraftRecovery.afterConfirmedSave;

  const feedbackDialog = useMemo(() => getFeedbackDialog({ error, notice }, locale), [error, locale, notice]);
  const unsavedExitPrompt = useMemo(() => getUnsavedExitPrompt(activePath, locale), [activePath, locale]);
  const pendingFileSwitchTarget = dirty && pendingOpenIntent ? pendingOpenIntent.displayPath : null;
  const unsavedFileSwitchPrompt = useMemo(() => (
    pendingFileSwitchTarget
      ? getUnsavedFileSwitchPrompt(activePath, pendingFileSwitchTarget, locale)
      : null
  ), [activePath, locale, pendingFileSwitchTarget]);
  const activePresentation = getWorkspacePresentation(activeFileKind);
  const workspaceLayoutStyle = {
    ...getWorkspaceSidebarLayoutStyle(workspaceSidebarWidth),
    ...('editor' in activePresentation ? paneLayoutStyle : {}),
  };
  const deferredOutlineContent = useDeferredValue(content);
  const outlineItems = useMemo(() => (
    activeFileKind === 'markdown' ? extractMarkdownOutline(deferredOutlineContent) : []
  ), [activeFileKind, deferredOutlineContent]);
  const currentOutlineJump = outlineJump?.documentId === documentId
    && outlineJump.documentEpoch === documentEpoch
    ? outlineJump
    : null;
  const currentMediaInsertion = mediaInsertion?.documentId === documentId
    && mediaInsertion.documentEpoch === documentEpoch
    ? mediaInsertion
    : null;
  const activeWorkspaceMarkdownFile = useMemo(() => (
    activeFileKind === 'markdown'
      ? files.find((file) => file.path === activePath && file.kind === 'markdown') ?? null
      : null
  ), [activeFileKind, activePath, files]);
  const excalidrawAssetSync = useMemo(() => {
    const resourceDirectory = settingsState.settings?.resourceDirectory;
    if (!workspaceRoot || !workspaceToken || !resourceDirectory) return null;
    const absolute = isAbsoluteResourceDirectory(resourceDirectory);
    if (absolute && resourceDirectoryAuthorization?.path !== resourceDirectory) return null;
    return {
      resourceDirectory,
      ...(resourceDirectoryAuthorization?.path === resourceDirectory
        ? { resourceDirectoryToken: resourceDirectoryAuthorization.token }
        : {}),
      workspaceRoot,
      workspaceToken,
    };
  }, [
    resourceDirectoryAuthorization,
    settingsState.settings?.resourceDirectory,
    workspaceRoot,
    workspaceToken,
  ]);
  const editorPasteContextRef = useRef({
    activeFileKind,
    activePath,
    activeWorkspaceMarkdownFile,
    authorityStatus,
    documentEpoch,
    documentId,
    resourceDirectory: settingsState.settings?.resourceDirectory ?? null,
    resourceDirectoryAuthorization,
    workspaceRoot,
    workspaceToken,
  });
  editorPasteContextRef.current = {
    activeFileKind,
    activePath,
    activeWorkspaceMarkdownFile,
    authorityStatus,
    documentEpoch,
    documentId,
    resourceDirectory: settingsState.settings?.resourceDirectory ?? null,
    resourceDirectoryAuthorization,
    workspaceRoot,
    workspaceToken,
  };
  const handleEditorPasteError = useCallback((pasteError: unknown) => {
    setError(normalizeAppError(pasteError, locale));
    setNotice(null);
  }, [locale, setError, setNotice]);
  const handleClipboardImagePaste = useCallback(async (
    request: ClipboardImagePasteRequest,
  ): Promise<string | null> => {
    const context = editorPasteContextRef.current;
    const isCurrentContext = () => {
      const current = editorPasteContextRef.current;
      return current.documentId === request.documentId
        && current.documentEpoch === request.documentEpoch
        && current.activeFileKind === 'markdown'
        && current.authorityStatus === 'committed'
        && current.activePath === context.activePath
        && current.workspaceRoot === context.workspaceRoot
        && current.workspaceToken === context.workspaceToken
        && current.resourceDirectoryAuthorization?.path
          === context.resourceDirectoryAuthorization?.path
        && current.resourceDirectoryAuthorization?.token
          === context.resourceDirectoryAuthorization?.token;
    };
    try {
      if (
        !isCurrentContext()
        || !context.activePath
        || !context.activeWorkspaceMarkdownFile
        || !context.resourceDirectory
        || !context.workspaceRoot
        || !context.workspaceToken
      ) throw new Error('Clipboard image paste is not authorized for the active workspace document.');
      const bytesBase64 = await blobToBase64(request.blob);
      if (!isCurrentContext()) return null;
      const resource = await writeWorkspaceResource({
        workspaceToken: context.workspaceToken,
        workspaceRoot: context.workspaceRoot,
        documentPath: context.activePath,
        resourceDirectory: context.resourceDirectory,
        bytesBase64,
        mimeType: request.mimeType,
        suggestedName: request.suggestedName,
        ...(context.resourceDirectoryAuthorization?.path === context.resourceDirectory
          ? { resourceDirectoryToken: context.resourceDirectoryAuthorization.token }
          : {}),
      });
      if (!isCurrentContext()) return null;
      const resourceName = request.suggestedName
        || resource.fileName
        || 'image';
      const markdown = createMarkdownImageReference(resourceName, resource.markdownPath);
      if (!markdown) throw new Error('Clipboard image resource path could not be inserted.');
      return markdown;
    } catch (pasteError) {
      if (mountedRef.current) handleEditorPasteError(pasteError);
      return null;
    }
  }, [handleEditorPasteError]);
  const handleAuthorizeResourceDirectory = useCallback(async (): Promise<string | null> => {
    try {
      const authorization = await authorizeResourceDirectory();
      if (!authorization) return null;
      setResourceDirectoryAuthorization(authorization);
      return authorization.path;
    } catch (authorizationError) {
      setError(normalizeAppError(authorizationError, locale));
      setNotice(null);
      return null;
    }
  }, [locale, setError, setNotice]);
  const editorFileKind = 'editor' in activePresentation ? activePresentation.editor : 'markdown';
  const isImageFile = activePresentation.preview === 'image';
  const isMediaFile = activePresentation.preview === 'media';
  const isPdfFile = activePresentation.preview === 'pdf';
  const isDocxFile = activePresentation.preview === 'docx';
  const isExcalidrawFile = activePresentation.preview === 'excalidraw';
  const isDocumentFile = isPdfFile || isDocxFile;
  const mediaKind = isMediaFile ? activePresentation.media_kind : 'video';
  const mediaMimeType = activeMimeType ?? (mediaKind === 'audio' ? 'audio/*' : 'video/*');
  const documentAssetsEnabled = authorityStatus === 'committed';
  const workspaceMoveDestinations = useMemo(() => {
    if (!workspaceMoveOperation || !workspaceRoot) return [];
    return getWorkspaceMoveDestinations({
      fileTree,
      sourceKind: workspaceMoveOperation.entryKind,
      sourcePath: workspaceMoveOperation.path,
      workspaceRoot,
    });
  }, [fileTree, workspaceMoveOperation, workspaceRoot]);
  const nativeSaveMenuEnabled = isNativeSaveMenuEnabled({
    authorityStatus,
    busy: busy || externalFileAction !== null || Boolean(saveConflict),
    fileKind: activeFileKind,
  });

  // Open intents must wait behind every app-owned modal and in-flight session operation.
  // This keeps a late OS launch from replacing the target of an existing decision dialog.
  const openIntentModalActive = Boolean(
    busy
      || settingsState.busy
      || settingsState.recovery
      || crashDraftRecovery.error
      || externalFileAction
      || saveConflict
      || showUnsavedExitPrompt
      || unsavedFileSwitchPrompt
      || workspaceSearchMode
      || workspaceEntryOperation
      || workspaceMoveOperation
      || showExport
      || showSettings
      || workspaceIndexActionBusy
      || packagedSettlementBarrierActive
      || appUpdater.update
      || feedbackDialog,
  );

  useEffect(() => {
    if (!packagedOpenEvidenceEnabled || isPopout || !isTauriRuntime()) {
      setPackagedOpenConfig(null);
      return;
    }
    let disposed = false;
    void getPackagedOpenE2eConfig().then((config) => {
      if (!disposed) setPackagedOpenConfig(config);
    }).catch(() => {
      if (!disposed) setPackagedOpenConfig(null);
    });
    return () => {
      disposed = true;
    };
  }, [isPopout, packagedOpenEvidenceEnabled]);

  const recordPackagedEvidence = useCallback((
    intent: Extract<AppOpenIntent, { origin: 'backend' }>,
    type: PackagedOpenAppEventType,
    fields: Record<string, unknown>,
  ): Promise<void> => {
    if (!packagedOpenConfig) return Promise.resolve();
    const step = getPackagedOpenStep(intent, packagedOpenConfig);
    if (!step) return Promise.resolve();
    const record = packagedEvidenceTailRef.current
      .catch(() => undefined)
      .then(() => recordPackagedOpenAppEvent({ type, intentId: intent.id, step, fields }));
    packagedEvidenceTailRef.current = record;
    return record;
  }, [packagedOpenConfig]);

  const reportPackagedEvidenceFailure = useCallback((err: unknown) => {
    if (!mountedRef.current) return;
    setError(normalizeAppError(err, locale));
    setNotice(null);
  }, [locale, setError, setNotice]);

  useEffect(() => {
    const settlement = pendingPackagedSettlement;
    if (!settlement || packagedOpenConfig === undefined) return;
    let waitForDirtySeed = false;
    setPendingPackagedSettlement(null);
    if (!packagedOpenConfig) {
      setPackagedSettlementBarrierActive(false);
      setOpenIntentPollRevision((revision) => revision + 1);
      return;
    }
    const packagedStep = getPackagedOpenStep(settlement.intent, packagedOpenConfig);
    const shouldSeedDirty = settlement.status === 'accepted'
      && settlement.intent.targetKind === 'file'
      && (packagedStep === 'cli-primary' || packagedStep === 'file-association')
      && !packagedDirtySeededRef.current;
    void recordPackagedEvidence(settlement.intent, 'app_settled', {
      status: settlement.status,
      app: {
        activeFile: activePath,
        workspaceRoot,
        workspaceToken,
        authorityStatus,
        dirty,
      },
      spellcheck: getPackagedSpellcheckEvidence(),
    }).then(() => {
      if (!mountedRef.current) return;
      if (settlement.status === 'failed') {
        setError(null);
        setNotice(null);
      }
      if (!shouldSeedDirty) return;
      packagedDirtySeededRef.current = true;
      const currentContent = currentContentRef.current;
      updateContent(currentContent.includes(PACKAGED_DIRTY_SEED)
        ? currentContent
        : `${currentContent}\n\n${PACKAGED_DIRTY_SEED}`);
      waitForDirtySeed = true;
      setPackagedDirtySeedPending(true);
    }).catch(reportPackagedEvidenceFailure).finally(() => {
      if (!mountedRef.current || waitForDirtySeed) return;
      setPackagedSettlementBarrierActive(false);
      setOpenIntentPollRevision((revision) => revision + 1);
    });
  }, [
    activePath,
    authorityStatus,
    dirty,
    packagedOpenConfig,
    pendingPackagedSettlement,
    recordPackagedEvidence,
    reportPackagedEvidenceFailure,
    setError,
    setNotice,
    setPackagedSettlementBarrierActive,
    updateContent,
    workspaceRoot,
    workspaceToken,
  ]);

  useEffect(() => {
    if (!packagedDirtySeedPending || !dirty) return;
    setPackagedDirtySeedPending(false);
    setPackagedSettlementBarrierActive(false);
    setOpenIntentPollRevision((revision) => revision + 1);
  }, [dirty, packagedDirtySeedPending, setPackagedSettlementBarrierActive]);

  useEffect(() => {
    if (
      pendingOpenIntent?.origin !== 'backend'
      || !packagedOpenConfig
      || packagedActivationEvidenceRef.current.has(pendingOpenIntent.id)
    ) return;
    packagedActivationEvidenceRef.current.add(pendingOpenIntent.id);
    void recordPackagedEvidence(pendingOpenIntent, 'app_activated', {
      dirty,
      activeFileBefore: activePath,
    }).catch(reportPackagedEvidenceFailure);
  }, [
    activePath,
    dirty,
    packagedOpenConfig,
    pendingOpenIntent,
    recordPackagedEvidence,
    reportPackagedEvidenceFailure,
  ]);

  useEffect(() => {
    if (
      pendingOpenIntent?.origin !== 'backend'
      || !unsavedFileSwitchPrompt
      || !packagedOpenConfig
      || packagedModalEvidenceRef.current.has(pendingOpenIntent.id)
    ) return;
    packagedModalEvidenceRef.current.add(pendingOpenIntent.id);
    void recordPackagedEvidence(pendingOpenIntent, 'dirty_modal_opened', {
      modalId: `dirty-${pendingOpenIntent.id}`,
    }).catch(reportPackagedEvidenceFailure);
  }, [
    packagedOpenConfig,
    pendingOpenIntent,
    recordPackagedEvidence,
    reportPackagedEvidenceFailure,
    unsavedFileSwitchPrompt,
  ]);

  useEffect(() => {
    if (isPopout || !isTauriRuntime() || typeof peekOpenIntent !== 'function') return undefined;
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    Promise.all([
      listen<unknown>(OPEN_INTENT_PENDING_EVENT, () => {
        if (!disposed) setOpenIntentPollRevision((revision) => revision + 1);
      }),
      listen<unknown>(OPEN_INTENT_FOCUS_EVENT, () => {
        if (!disposed) {
          void focusMainWindow(activeOpenIntentIdRef.current ?? undefined, true).catch(() => undefined);
        }
      }),
    ]).then((cleanups) => {
      if (disposed) cleanups.forEach((cleanup) => cleanup());
      else {
        unlisteners.push(...cleanups);
        if (sessionRestoreRequestStateRef.current === 'pending') {
          sessionRestoreRequestStateRef.current = 'requested';
          void requestSessionRestore().then(() => {
            if (mountedRef.current) setOpenIntentPollRevision((revision) => revision + 1);
          }).catch((err: unknown) => {
            sessionRestoreRequestStateRef.current = 'failed';
            settleWorkspaceSessionRestore();
            if (mountedRef.current) {
              setError(normalizeAppError(err, locale));
              setNotice(null);
            }
          });
        }
      }
    }).catch((err: unknown) => {
      if (!disposed) {
        if (sessionRestoreRequestStateRef.current === 'pending') {
          sessionRestoreRequestStateRef.current = 'failed';
          settleWorkspaceSessionRestore();
        }
        setError(normalizeAppError(err, locale));
        setNotice(null);
      }
    });
    return () => {
      disposed = true;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, [isPopout, locale, setError, setNotice, settleWorkspaceSessionRestore]);

  useEffect(() => {
    syncOpenIntentCoordinatorModalState(
      openIntentCoordinator,
      openIntentModalActive,
      packagedSettlementBarrierRef,
    );
  }, [openIntentCoordinator, openIntentModalActive]);

  useEffect(() => {
    if (
      isPopout
      || !isTauriRuntime()
      || typeof peekOpenIntent !== 'function'
      || (packagedOpenEvidenceEnabled && packagedOpenConfig === undefined)
      || openIntentModalActive
    ) return undefined;
    let disposed = false;
    void Promise.resolve().then(() => peekOpenIntent()).then((preview) => {
      if (disposed) return;
      if (preview) openIntentCoordinator.enqueue(adaptBackendOpenIntent(preview));
    }).catch((err: unknown) => {
      if (disposed) return;
      setError(normalizeAppError(err, locale));
      setNotice(null);
    });
    return () => {
      disposed = true;
    };
  }, [
    isPopout,
    locale,
    openIntentCoordinator,
    openIntentModalActive,
    openIntentPollRevision,
    packagedOpenConfig,
    packagedOpenEvidenceEnabled,
    setError,
    setNotice,
  ]);

  const handleDocumentPreviewFeedback = useCallback((
    feedback: DocxPreviewFeedback | PdfPreviewFeedback,
  ) => {
    if (feedback.kind === 'error') {
      setError(feedback.message);
      setNotice(null);
    } else {
      setNotice(feedback.message);
      setError(null);
    }
  }, [setError, setNotice]);

  const handleExcalidrawError = useCallback((message: string) => {
    setError(message);
    setNotice(null);
  }, [setError, setNotice]);

  const documentPreview = isPdfFile
    ? (
      <PdfPreview
        bytesBase64={bytesBase64}
        documentEpoch={documentEpoch}
        documentId={documentId}
        enabled={documentAssetsEnabled}
        loadingLabel={t('loadingPdf')}
        locale={locale}
        onFeedback={handleDocumentPreviewFeedback}
      />
    )
    : isDocxFile
      ? (
        <DocxPreview
          bytesBase64={bytesBase64}
          documentEpoch={documentEpoch}
          documentId={documentId}
          enabled={documentAssetsEnabled}
          loadingLabel={t('loadingDocx')}
          locale={locale}
          onFeedback={handleDocumentPreviewFeedback}
        />
      )
      : null;

  const {
    editorPaneRef,
    movePaneResize,
    previewPaneRef,
    resizePaneWithKeyboard,
    startPaneResize,
    stopPaneResize,
  } = usePaneResize({ editorPaneRatio, setEditorPaneRatio });
  const {
    moveWorkspaceSidebarResize,
    resizeWorkspaceSidebarWithKeyboard,
    startWorkspaceSidebarResize,
    stopWorkspaceSidebarResize,
  } = useWorkspaceSidebarResize({
    setSidebarWidth: setWorkspaceSidebarWidth,
    sidebarWidth: workspaceSidebarWidth,
  });
  const { closePopoutWindows, editorPopoutButton, openPanePopout, previewPopoutButton } = usePanePopouts({ broadcastPaneState, isPopout, setError, setNotice });
  const editorPopoutOpen = editorPopoutButton?.isPoppedOut === true;
  editorPopoutOpenRef.current = editorPopoutOpen || editorPopoutOpenRequestRef.current !== null;
  const flushSessionBeforeProgramClose = useCallback(async () => {
    await flushCrashDraft();
    await flushWorkspaceSession();
  }, [flushCrashDraft, flushWorkspaceSession]);
  const { forceCloseProgram } = useProgramCloseGuard({
    closePopoutWindows,
    dirty,
    flushWorkspaceSession: flushSessionBeforeProgramClose,
    isPopout,
    setError,
    setNotice,
    setShowUnsavedExitPrompt,
  });

  const sendCursorInsertionToEditorPopout = useCallback((insertion: MarkdownMediaCursorInsertion) => {
    const generation = popoutMediaInsertionGenerationRef.current;
    const delivery = popoutMediaInsertionTailRef.current
      .catch(() => undefined)
      .then(() => {
        return emitToWithRetry(
          getPanePopoutLabel('editor'),
          MARKDOWN_MEDIA_INSERTION_EVENT,
          insertion,
          () => generation === popoutMediaInsertionGenerationRef.current
            && editorPopoutOpenRef.current
            && mountedRef.current,
          markdownMediaRetryControllerRef.current,
        );
      });
    popoutMediaInsertionTailRef.current = delivery;
    void delivery.catch((err: unknown) => {
      if (generation !== popoutMediaInsertionGenerationRef.current || !mountedRef.current) return;
      setError(normalizeAppError(err, locale));
      setNotice(null);
    });
  }, [locale, setError, setNotice]);

  useEffect(() => {
    const retryController = createMarkdownMediaRetryController();
    markdownMediaRetryControllerRef.current = retryController;
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelMarkdownMediaRetries(retryController);
    };
  }, []);

  useEffect(() => {
    popoutMediaInsertionGenerationRef.current += 1;
    cancelMarkdownMediaInsertionHandshake(editorPopoutHandshakeRef.current);
    editorPopoutHandshakeRef.current = null;
    const ready = editorPopoutReadyRef.current;
    if (
      ready
      && (ready.documentId !== documentId || ready.documentEpoch !== documentEpoch)
    ) editorPopoutReadyRef.current = null;
    pendingEditorPopoutReadyRequestIdRef.current = null;
    pendingPopoutMediaInsertionsRef.current = pendingPopoutMediaInsertionsRef.current.filter((insertion) => (
      insertion.documentId === documentId && insertion.documentEpoch === documentEpoch
    ));
  }, [documentEpoch, documentId]);

  useEffect(() => () => {
    editorPopoutOpenRequestRef.current = null;
  }, []);

  useEffect(() => {
    if (editorPopoutOpen) return;
    popoutMediaInsertionGenerationRef.current += 1;
    cancelMarkdownMediaInsertionHandshake(editorPopoutHandshakeRef.current);
    editorPopoutHandshakeRef.current = null;
    editorPopoutReadyRef.current = null;
    expectedEditorPopoutInstanceIdRef.current = null;
    pendingEditorPopoutReadyRequestIdRef.current = null;
    pendingPopoutMediaInsertionsRef.current = [];
  }, [editorPopoutOpen]);

  useEffect(() => {
    const handleFeedbackError = (event: Event) => {
      if (event instanceof CustomEvent && typeof event.detail === 'string') {
        setError(event.detail);
        setNotice(null);
      }
    };
    window.addEventListener(APP_FEEDBACK_ERROR_EVENT, handleFeedbackError);
    return () => window.removeEventListener(APP_FEEDBACK_ERROR_EVENT, handleFeedbackError);
  }, [setError, setNotice]);

  useEffect(() => {
    if (isPopout) return undefined;
    let current = true;
    const update = nativeSaveMenuSyncRef.current
      .catch(() => undefined)
      .then(() => setNativeSaveMenuEnabled(nativeSaveMenuEnabled));
    nativeSaveMenuSyncRef.current = update;
    void update.catch((err: unknown) => {
      if (!current) return;
      setError(normalizeAppError(err, locale));
      setNotice(null);
    });
    return () => {
      current = false;
    };
  }, [isPopout, locale, nativeSaveMenuEnabled, setError, setNotice]);

  useEffect(() => {
    if (isPopout) return undefined;
    let disposed = false;
    let unlistenFeedback: (() => void) | undefined;
    listen<string>(APP_FEEDBACK_ERROR_EVENT, (event) => {
      setError(normalizeAppError(event.payload, locale));
      setNotice(null);
    }).then((fn) => {
      if (disposed) fn();
      else unlistenFeedback = fn;
    }).catch((err: unknown) => setError(normalizeAppError(err, locale)));
    return () => {
      disposed = true;
      unlistenFeedback?.();
    };
  }, [isPopout, locale, setError, setNotice]);

  useEffect(() => {
    if (!isPopout) return undefined;
    let disposed = false;
    let unlistenOutlineJump: (() => void) | undefined;
    listen<unknown>(OUTLINE_JUMP_EVENT, (event) => {
      const jump = decodeMarkdownOutlineJump(event.payload);
      if (
        !jump
        || jump.documentId !== documentId
        || jump.documentEpoch !== documentEpoch
      ) return;
      setOutlineJump(jump);
    }).then((fn) => {
      if (disposed) fn();
      else unlistenOutlineJump = fn;
    }).catch((err: unknown) => setError(normalizeAppError(err, locale)));
    return () => {
      disposed = true;
      unlistenOutlineJump?.();
    };
  }, [documentEpoch, documentId, isPopout, locale, setError]);

  useEffect(() => {
    if (isPopout) return undefined;
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    const isHandshakeCurrent = (pending: PendingMarkdownMediaInsertionHandshake) => (
      !disposed
      && editorPopoutOpenRef.current
      && pending.generation === popoutMediaInsertionGenerationRef.current
      && editorPopoutHandshakeRef.current === pending
      && pending.handshake.documentId === documentId
      && pending.handshake.documentEpoch === documentEpoch
      && pending.handshake.popoutInstanceId === expectedEditorPopoutInstanceIdRef.current
    );
    const failHandshake = (pending: PendingMarkdownMediaInsertionHandshake, _error: unknown) => {
      if (!isHandshakeCurrent(pending)) return;
      cancelMarkdownMediaInsertionHandshake(pending);
      editorPopoutHandshakeRef.current = null;
      setError(t('popoutInsertionUnavailable'));
      setNotice(null);
    };
    function scheduleHandshakeRetry(
      pending: PendingMarkdownMediaInsertionHandshake,
      delayMs: number,
      failure: unknown,
    ) {
      cancelMarkdownMediaInsertionHandshake(pending);
      pending.retryTimer = globalThis.setTimeout(() => {
        pending.retryTimer = null;
        if (!isHandshakeCurrent(pending)) return;
        if (pending.attempt >= MEDIA_INSERTION_HANDSHAKE_ATTEMPTS) {
          failHandshake(pending, failure);
          return;
        }
        pending.attempt += 1;
        sendHandshake(pending);
      }, delayMs);
    }
    function sendHandshake(pending: PendingMarkdownMediaInsertionHandshake) {
      if (!isHandshakeCurrent(pending) || pending.sending) return;
      pending.sending = true;
      void emitTo(
        getPanePopoutLabel('editor'),
        MARKDOWN_MEDIA_INSERTION_HANDSHAKE_EVENT,
        pending.handshake,
      ).then(() => {
        pending.sending = false;
        if (!isHandshakeCurrent(pending)) return;
        scheduleHandshakeRetry(
          pending,
          MEDIA_INSERTION_HANDSHAKE_ACK_TIMEOUT_MS,
          new Error('Markdown media insertion handshake timed out'),
        );
      }).catch((err: unknown) => {
        pending.sending = false;
        if (!isHandshakeCurrent(pending)) return;
        scheduleHandshakeRetry(
          pending,
          MEDIA_EVENT_RETRY_DELAYS_MS[pending.attempt] ?? MEDIA_INSERTION_HANDSHAKE_ACK_TIMEOUT_MS,
          err,
        );
      });
    }
    const startHandshake = (ready: MarkdownMediaInsertionReady) => {
      if (disposed || !editorPopoutOpenRef.current) return;
      const current = editorPopoutHandshakeRef.current;
      if (
        current
        && isHandshakeCurrent(current)
        && current.handshake.documentId === ready.documentId
        && current.handshake.documentEpoch === ready.documentEpoch
        && current.handshake.popoutInstanceId === ready.popoutInstanceId
      ) {
        if (current.sending || current.attempt >= MEDIA_INSERTION_HANDSHAKE_ATTEMPTS) return;
        cancelMarkdownMediaInsertionHandshake(current);
        current.attempt += 1;
        sendHandshake(current);
        return;
      }
      cancelMarkdownMediaInsertionHandshake(editorPopoutHandshakeRef.current);
      editorPopoutReadyRef.current = null;
      const { readyRequestId: _readyRequestId, ...handshakeReady } = ready;
      const pending: PendingMarkdownMediaInsertionHandshake = {
        attempt: 1,
        generation: popoutMediaInsertionGenerationRef.current,
        handshake: {
          ...handshakeReady,
          handshakeId: createPaneProtocolId('markdown-media-handshake'),
        },
        retryTimer: null,
        sending: false,
      };
      editorPopoutHandshakeRef.current = pending;
      sendHandshake(pending);
    };
    startEditorPopoutHandshakeRef.current = startHandshake;
    const handleMediaInsertionReady = (event: { payload: unknown }) => {
      if (disposed) return;
      const ready = decodeMarkdownMediaInsertionReady(event.payload);
      if (
        !ready
        || ready.documentId !== documentId
        || ready.documentEpoch !== documentEpoch
        || !editorPopoutOpenRef.current
      ) return;
      const expectedInstanceId = expectedEditorPopoutInstanceIdRef.current;
      const pendingReadyRequestId = pendingEditorPopoutReadyRequestIdRef.current;
      if (expectedInstanceId && ready.popoutInstanceId !== expectedInstanceId) return;
      if (pendingReadyRequestId && ready.readyRequestId !== pendingReadyRequestId) return;
      if (!expectedInstanceId) expectedEditorPopoutInstanceIdRef.current = ready.popoutInstanceId;
      if (pendingReadyRequestId) pendingEditorPopoutReadyRequestIdRef.current = null;
      startHandshake(ready);
    };
    const handleMediaInsertionHandshakeAck = (event: { payload: unknown }) => {
      if (disposed) return;
      const handshake = decodeMarkdownMediaInsertionHandshake(event.payload);
      const pendingHandshake = editorPopoutHandshakeRef.current;
      if (
        !handshake
        || !pendingHandshake
        || !editorPopoutOpenRef.current
        || pendingHandshake.generation !== popoutMediaInsertionGenerationRef.current
        || handshake.handshakeId !== pendingHandshake.handshake.handshakeId
        || handshake.documentId !== pendingHandshake.handshake.documentId
        || handshake.documentEpoch !== pendingHandshake.handshake.documentEpoch
        || handshake.popoutInstanceId !== pendingHandshake.handshake.popoutInstanceId
        || handshake.popoutInstanceId !== expectedEditorPopoutInstanceIdRef.current
        || handshake.documentId !== documentId
        || handshake.documentEpoch !== documentEpoch
      ) return;
      cancelMarkdownMediaInsertionHandshake(pendingHandshake);
      editorPopoutHandshakeRef.current = null;
      editorPopoutReadyRef.current = {
        documentId: handshake.documentId,
        documentEpoch: handshake.documentEpoch,
        popoutInstanceId: handshake.popoutInstanceId,
      };
      const pending = pendingPopoutMediaInsertionsRef.current.filter((insertion) => (
        insertion.documentId === handshake.documentId && insertion.documentEpoch === handshake.documentEpoch
      ));
      pendingPopoutMediaInsertionsRef.current = pendingPopoutMediaInsertionsRef.current.filter((insertion) => (
        insertion.documentId !== handshake.documentId || insertion.documentEpoch !== handshake.documentEpoch
      ));
      for (const insertion of pending) {
        sendCursorInsertionToEditorPopout({
          ...insertion,
          popoutInstanceId: handshake.popoutInstanceId,
        });
      }
    };
    void Promise.allSettled([
      listen<unknown>(MARKDOWN_MEDIA_INSERTION_READY_EVENT, handleMediaInsertionReady),
      listen<unknown>(MARKDOWN_MEDIA_INSERTION_HANDSHAKE_ACK_EVENT, handleMediaInsertionHandshakeAck),
    ]).then((registrations) => {
      const registered = registrations.flatMap((registration) => (
        registration.status === 'fulfilled' ? [registration.value] : []
      ));
      const failure = registrations.find((registration) => registration.status === 'rejected');
      if (disposed || failure) {
        for (const unlisten of registered) unlisten();
      } else {
        unlisteners.push(...registered);
        if (
          editorPopoutOpenRef.current
          && pendingPopoutMediaInsertionsRef.current.some((insertion) => (
            insertion.documentId === documentId && insertion.documentEpoch === documentEpoch
          ))
        ) {
          const expectedInstanceId = expectedEditorPopoutInstanceIdRef.current;
          if (expectedInstanceId) {
            startHandshake({
              documentEpoch,
              documentId,
              popoutInstanceId: expectedInstanceId,
            });
          }
        }
      }
      if (!disposed && failure?.status === 'rejected') {
        setError(normalizeAppError(failure.reason, locale));
        setNotice(null);
      }
    });
    return () => {
      disposed = true;
      if (startEditorPopoutHandshakeRef.current === startHandshake) {
        startEditorPopoutHandshakeRef.current = null;
      }
      const pendingHandshake = editorPopoutHandshakeRef.current;
      if (
        pendingHandshake
        && pendingHandshake.handshake.documentId === documentId
        && pendingHandshake.handshake.documentEpoch === documentEpoch
      ) {
        cancelMarkdownMediaInsertionHandshake(pendingHandshake);
        editorPopoutHandshakeRef.current = null;
      }
      for (const unlisten of unlisteners) unlisten();
    };
  }, [documentEpoch, documentId, isPopout, locale, sendCursorInsertionToEditorPopout, setError, setNotice, t]);

  useEffect(() => {
    if (
      popoutPane !== 'editor'
      || activeFileKind !== 'markdown'
      || authorityStatus !== 'committed'
      || !editorPopoutInstanceId
    ) return undefined;
    const popoutInstanceId = editorPopoutInstanceId;
    let disposed = false;
    let handshakeReceived = false;
    const unlisteners: Array<() => void> = [];
    const announceReady = (readyRequestId?: string) => emitToWithRetry(
      MAIN_WINDOW_LABEL,
      MARKDOWN_MEDIA_INSERTION_READY_EVENT,
      readyRequestId
        ? { documentEpoch, documentId, popoutInstanceId, readyRequestId }
        : { documentEpoch, documentId, popoutInstanceId },
      () => !disposed,
      markdownMediaRetryControllerRef.current,
    ).catch((err: unknown) => {
      if (disposed) return;
      setError(normalizeAppError(err, locale));
      setNotice(null);
    });
    const handleMediaInsertion = (event: { payload: unknown }) => {
      if (disposed) return;
      const insertion = decodeMarkdownMediaCursorInsertion(event.payload);
      if (
        !insertion
        || insertion.documentId !== documentId
        || insertion.documentEpoch !== documentEpoch
        || insertion.popoutInstanceId !== popoutInstanceId
        || activeFileKind !== 'markdown'
        || authorityStatus !== 'committed'
      ) return;
      const requestKey = `${insertion.documentId}:${insertion.documentEpoch}`;
      const highestRequestId = mediaInsertionHighWaterRef.current.get(requestKey) ?? 0;
      const currentRelativePath = getWorkspaceRelativePath(workspaceRoot, activePath);
      if (insertion.requestId <= highestRequestId || currentRelativePath !== insertion.documentRelativePath) return;
      const markdown = createMarkdownMediaReference(insertion.asset, { relative_path: currentRelativePath });
      if (!markdown) return;
      mediaInsertionHighWaterRef.current.set(requestKey, insertion.requestId);
      setMediaInsertion({
        documentEpoch: insertion.documentEpoch,
        documentId: insertion.documentId,
        markdown,
        requestId: insertion.requestId,
        target: { kind: 'cursor' },
      });
    };
    const handleMediaInsertionHandshake = (event: { payload: unknown }) => {
      if (disposed) return;
      const handshake = decodeMarkdownMediaInsertionHandshake(event.payload);
      if (
        !handshake
        || handshake.documentId !== documentId
        || handshake.documentEpoch !== documentEpoch
        || handshake.popoutInstanceId !== popoutInstanceId
        || activeFileKind !== 'markdown'
        || authorityStatus !== 'committed'
      ) return;
      handshakeReceived = true;
      void emitToWithRetry(
        MAIN_WINDOW_LABEL,
        MARKDOWN_MEDIA_INSERTION_HANDSHAKE_ACK_EVENT,
        handshake,
        () => !disposed,
        markdownMediaRetryControllerRef.current,
      ).catch((err: unknown) => {
        if (disposed) return;
        setError(normalizeAppError(err, locale));
        setNotice(null);
      });
    };
    const handleMediaInsertionReadyRequest = (event: { payload: unknown }) => {
      if (disposed) return;
      const request = decodeMarkdownMediaInsertionReadyRequest(event.payload);
      if (!request || request.documentId !== documentId || request.documentEpoch !== documentEpoch) return;
      void announceReady(request.readyRequestId);
    };
    void Promise.allSettled([
      listen<unknown>(MARKDOWN_MEDIA_INSERTION_EVENT, handleMediaInsertion),
      listen<unknown>(MARKDOWN_MEDIA_INSERTION_HANDSHAKE_EVENT, handleMediaInsertionHandshake),
      listen<unknown>(MARKDOWN_MEDIA_INSERTION_REQUEST_READY_EVENT, handleMediaInsertionReadyRequest),
    ]).then((registrations) => {
      const registered = registrations.flatMap((registration) => (
        registration.status === 'fulfilled' ? [registration.value] : []
      ));
      const failure = registrations.find((registration) => registration.status === 'rejected');
      if (disposed || failure) {
        for (const unlisten of registered) unlisten();
      } else {
        unlisteners.push(...registered);
        if (!handshakeReceived) void announceReady();
      }
      if (!disposed && failure?.status === 'rejected') {
        setError(normalizeAppError(failure.reason, locale));
        setNotice(null);
      }
    });
    return () => {
      disposed = true;
      for (const unlisten of unlisteners) unlisten();
    };
  }, [activeFileKind, activePath, authorityStatus, documentEpoch, documentId, editorPopoutInstanceId, locale, popoutPane, setError, setNotice, workspaceRoot]);

  const showWorkspaceSearchDialog = useCallback((mode: WorkspaceSearchMode) => {
    if (openIntentModalActive) return;
    if (!workspaceRoot || !workspaceToken) {
      setError(t('searchUnavailable'));
      setNotice(null);
      return;
    }
    setWorkspaceSearchMode(mode);
  }, [openIntentModalActive, setError, setNotice, t, workspaceRoot, workspaceToken]);

  const discardCurrentWorkspaceIndex = useCallback(async () => {
    if (!workspaceRoot || !workspaceToken) return;
    setWorkspaceIndexActionBusy(true);
    try {
      await discardWorkspaceIndex(workspaceToken, workspaceRoot);
      setShowSettings(false);
      setError(null);
      setNotice(t('workspaceIndexDiscarded'));
    } catch (err) {
      setShowSettings(false);
      setError(normalizeAppError(err, locale));
      setNotice(null);
    } finally {
      setWorkspaceIndexActionBusy(false);
    }
  }, [locale, setError, setNotice, t, workspaceRoot, workspaceToken]);

  const rebuildCurrentWorkspaceIndex = useCallback(async () => {
    if (!workspaceRoot || !workspaceToken) return;
    setWorkspaceIndexActionBusy(true);
    try {
      const response = await rebuildWorkspaceIndex(
        workspaceToken,
        workspaceRoot,
        createWorkspaceIndexOperationId('rebuild'),
      );
      if (response.status !== 'ready') {
        throw new Error('Workspace index rebuild did not complete');
      }
      setShowSettings(false);
      setError(null);
      setNotice(t('workspaceIndexRebuilt'));
    } catch (err) {
      setShowSettings(false);
      setError(normalizeAppError(err, locale));
      setNotice(null);
    } finally {
      setWorkspaceIndexActionBusy(false);
    }
  }, [locale, setError, setNotice, t, workspaceRoot, workspaceToken]);

  useEffect(() => {
    if (isPopout) return undefined;
    let disposed = false;
    let unlistenNativeMenu: (() => void) | undefined;
    listen<unknown>(NATIVE_MENU_EVENT, (event) => {
      const command = decodeNativeMenuCommand(event.payload);
      if (!command) return;
      if (typeof command === 'object') {
        if (command.type === 'open-recent') enqueueLocalOpenIntent(
          'native_menu',
          locale === 'zh-CN' ? '最近文档' : 'Recent document',
          { kind: 'open_recent', entryId: command.entryId },
        );
        else void handleClearRecent();
        return;
      }
      if (!nativeSaveMenuEnabled && (command === 'save' || command === 'save-as')) return;
      if (command === 'new') enqueueLocalOpenIntent(
        'native_menu',
        locale === 'zh-CN' ? '新建文档' : 'New document',
        { kind: 'new_document' },
      );
      else if (command === 'open-file') enqueueLocalOpenIntent(
        'native_menu',
        locale === 'zh-CN' ? '选择文件' : 'Choose a file',
        { kind: 'open_file' },
      );
      else if (command === 'open-directory') enqueueLocalOpenIntent(
        'native_menu',
        locale === 'zh-CN' ? '选择文件夹' : 'Choose a folder',
        { kind: 'open_directory' },
      );
      else if (command === 'quick-open') showWorkspaceSearchDialog('quick-open');
      else if (command === 'workspace-search') showWorkspaceSearchDialog('workspace-search');
      else if (command === 'save') void handleSave();
      else if (command === 'save-as') void handleSaveAs();
    }).then((fn) => {
      if (disposed) fn();
      else unlistenNativeMenu = fn;
    }).catch((err: unknown) => setError(normalizeAppError(err, locale)));
    return () => {
      disposed = true;
      unlistenNativeMenu?.();
    };
  }, [enqueueLocalOpenIntent, handleClearRecent, handleSave, handleSaveAs, isPopout, locale, nativeSaveMenuEnabled, setError, showWorkspaceSearchDialog]);

  const handleSaveAndQuit = useCallback(async () => {
    const saved = await saveCurrentDocument();
    if (!saved) return;
    setShowUnsavedExitPrompt(false);
    void forceCloseProgram().catch((err: unknown) => setError(normalizeAppError(err, locale)));
  }, [forceCloseProgram, locale, saveCurrentDocument, setError]);

  const handleCancelExit = useCallback(() => {
    setShowUnsavedExitPrompt(false);
  }, []);

  const handleQuitWithoutSaving = useCallback(() => {
    setShowUnsavedExitPrompt(false);
    void forceCloseProgram().catch((err: unknown) => setError(normalizeAppError(err, locale)));
  }, [forceCloseProgram, locale, setError]);

  const requestWorkspaceFileOpen = useCallback((path: string) => {
    if (path === activePath) return;
    setError(null);
    setNotice(null);
    enqueueLocalOpenIntent('sidebar', path, { kind: 'workspace_file', path });
  }, [activePath, enqueueLocalOpenIntent, setError, setNotice]);

  const requestWorkspaceSearchOpen = useCallback((selection: WorkspaceSearchSelection) => {
    setWorkspaceSearchMode(null);
    setError(null);
    setNotice(null);
    enqueueLocalOpenIntent(
      'workspace_search',
      selection.relativePath,
      { kind: 'workspace_search_result', selection },
    );
  }, [enqueueLocalOpenIntent, setError, setNotice]);

  const settleOpenIntent = useCallback((
    intent: AppOpenIntent,
    settlement: 'accepted' | 'cancelled' | 'failed',
    error?: unknown,
  ) => {
    const deferSuccessor = packagedOpenEvidenceEnabled && intent.origin === 'backend';
    if (deferSuccessor) {
      setPackagedSettlementBarrierActive(true);
      openIntentCoordinator.setModalActive(true);
    }
    const settled = settlement === 'accepted'
      ? openIntentCoordinator.acceptActive(intent.id)
      : settlement === 'cancelled'
        ? openIntentCoordinator.cancelActive(intent.id)
        : openIntentCoordinator.failActive(intent.id, error ?? new Error('Open request failed'));
    if (!settled && deferSuccessor) setPackagedSettlementBarrierActive(false);
  }, [openIntentCoordinator, packagedOpenEvidenceEnabled, setPackagedSettlementBarrierActive]);

  const processOpenIntent = useCallback(async (
    saveBeforeOpen: boolean,
  ): Promise<void> => {
    const intent = pendingOpenIntent;
    if (
      !intent
      || activeOpenIntentIdRef.current !== intent.id
      || openIntentSettlementRef.current.has(intent.id)
    ) return;
    openIntentSettlementRef.current.add(intent.id);
    try {
      if (intent.origin === 'backend') await packagedEvidenceTailRef.current;
      if (saveBeforeOpen) {
        const saved = await saveCurrentDocument();
        if (!saved) {
          openIntentSettlementRef.current.delete(intent.id);
          return;
        }
        if (intent.origin === 'backend') {
          await recordPackagedEvidence(intent, 'dirty_decision', { decision: 'save' });
        }
      }
      if (intent.origin === 'local') {
        const { action } = intent;
        if (action.kind === 'new_document') await handleNew();
        else if (action.kind === 'open_file') await handleOpenFile();
        else if (action.kind === 'open_directory') await handleOpenDirectory();
        else if (action.kind === 'open_recent') await handleOpenRecent(action.entryId);
        else if (action.kind === 'workspace_file') await openWorkspaceFilePath(action.path);
        else if (action.kind === 'workspace_search_result') {
          const { selection } = action;
          await openWorkspaceIndexResult(
            selection.workspaceToken,
            selection.workspaceRoot,
            selection.indexGeneration,
            selection.relativePath,
          );
        } else {
          await recoverCrashDraft(action.draft);
        }
        settleOpenIntent(intent, 'accepted');
      } else {
        const outcome = !saveBeforeOpen && dirty
          ? await resolveOpenIntentRequest(intent.id, intent.targetKind, true)
          : await resolveOpenIntentRequest(intent.id, intent.targetKind);
        if (outcome === 'accepted') {
          await recordPackagedEvidence(intent, 'app_applied', {
            status: 'accepted',
            targetKind: intent.targetKind,
          });
          settleOpenIntent(intent, 'accepted');
        } else if (outcome === 'blocked') {
          // A concurrent external/save-conflict modal owns the decision for now.
          openIntentSettlementRef.current.delete(intent.id);
        } else {
          settleOpenIntent(intent, 'failed', new Error('The requested file or directory could not be opened.'));
        }
      }
    } catch (err) {
      openIntentSettlementRef.current.delete(intent.id);
      setError(normalizeAppError(err, locale));
      setNotice(null);
      settleOpenIntent(intent, 'failed', err);
    }
  }, [
    dirty,
    locale,
    handleNew,
    handleOpenDirectory,
    handleOpenFile,
    handleOpenRecent,
    openWorkspaceFilePath,
    openWorkspaceIndexResult,
    pendingOpenIntent,
    recoverCrashDraft,
    recordPackagedEvidence,
    resolveOpenIntentRequest,
    saveCurrentDocument,
    setError,
    setNotice,
    settleOpenIntent,
  ]);

  const cancelOpenIntent = useCallback(async (): Promise<void> => {
    const intent = pendingOpenIntent;
    if (
      !intent
      || activeOpenIntentIdRef.current !== intent.id
      || openIntentSettlementRef.current.has(intent.id)
    ) return;
    openIntentSettlementRef.current.add(intent.id);
    try {
      if (intent.origin === 'backend' && typeof discardOpenIntent === 'function') {
        await packagedEvidenceTailRef.current;
        await discardOpenIntent(intent.id);
      }
      if (intent.origin === 'backend' && intent.targetKind === 'session_restore') settleWorkspaceSessionRestore();
      settleOpenIntent(intent, 'cancelled');
    } catch (err) {
      openIntentSettlementRef.current.delete(intent.id);
      setError(normalizeAppError(err, locale));
      setNotice(null);
    }
  }, [locale, pendingOpenIntent, setError, setNotice, settleOpenIntent, settleWorkspaceSessionRestore]);

  const packagedUnicodeRenamePending = pendingOpenIntent?.origin === 'backend'
    && packagedOpenConfig != null
    && pendingOpenIntent.displayPath === packagedOpenConfig.paths.unicodeFile
    && !packagedOpenConfig.unicodeRenameReady;

  useEffect(() => {
    if (!packagedUnicodeRenamePending || dirty || unsavedFileSwitchPrompt) return undefined;
    let disposed = false;
    let attempts = 0;
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
    const poll = async () => {
      attempts += 1;
      try {
        const config = await getPackagedOpenE2eConfig();
        if (disposed || !config) return;
        if (config.unicodeRenameReady) {
          setPackagedOpenConfig(config);
          return;
        }
      } catch {
        // A transient instrumentation read must not bypass the rename gate.
      }
      if (!disposed && attempts < PACKAGED_UNICODE_READY_MAX_ATTEMPTS) {
        timer = globalThis.setTimeout(poll, PACKAGED_UNICODE_READY_POLL_INTERVAL_MS);
      }
    };
    void poll();
    return () => {
      disposed = true;
      if (timer !== undefined) globalThis.clearTimeout(timer);
    };
  }, [dirty, packagedUnicodeRenamePending, pendingOpenIntent, unsavedFileSwitchPrompt]);

  // A clean document can accept an active request without showing a dialog. Dirty requests
  // remain active until one of the explicit save/switch/cancel actions below runs.
  useEffect(() => {
    if (
      isPopout
      || !pendingOpenIntent
      || dirty
      || openIntentModalActive
      || packagedUnicodeRenamePending
      || openIntentSettlementRef.current.has(pendingOpenIntent.id)
    ) return;
    void processOpenIntent(false);
  }, [
    dirty,
    isPopout,
    openIntentModalActive,
    packagedUnicodeRenamePending,
    pendingOpenIntent,
    processOpenIntent,
  ]);

  const handleCancelFileSwitch = useCallback(() => {
    const intent = pendingOpenIntent;
    if (intent && activeOpenIntentIdRef.current === intent.id) {
      if (intent.origin === 'backend') {
        void recordPackagedEvidence(intent, 'dirty_decision', { decision: 'cancel' })
          .catch(reportPackagedEvidenceFailure);
      }
      void cancelOpenIntent();
    }
  }, [cancelOpenIntent, pendingOpenIntent, recordPackagedEvidence, reportPackagedEvidenceFailure]);

  const handleFileSwitchWithoutSaving = useCallback(() => {
    const intent = pendingOpenIntent;
    if (intent && activeOpenIntentIdRef.current === intent.id) {
      if (intent.origin === 'backend') {
        void recordPackagedEvidence(intent, 'dirty_decision', { decision: 'discard' })
          .catch(reportPackagedEvidenceFailure);
      }
      void processOpenIntent(false);
    }
  }, [pendingOpenIntent, processOpenIntent, recordPackagedEvidence, reportPackagedEvidenceFailure]);

  const handleSaveAndSwitchFile = useCallback(async () => {
    if (pendingOpenIntent) {
      await processOpenIntent(true);
    }
  }, [pendingOpenIntent, processOpenIntent]);

  useEffect(() => {
    const intent = pendingOpenIntent;
    if (
      intent?.origin !== 'backend'
      || !packagedOpenConfig
      || !unsavedFileSwitchPrompt
      || packagedAutomatedDecisionRef.current.has(intent.id)
    ) return undefined;

    const decide = (config: PackagedOpenE2eConfig) => {
      if (packagedAutomatedDecisionRef.current.has(intent.id)) return;
      packagedAutomatedDecisionRef.current.add(intent.id);
      if (config.profile === 'restore-cancel' && intent.source === 'session_restore') {
        handleCancelFileSwitch();
      } else {
        handleFileSwitchWithoutSaving();
      }
    };

    const waitsForUnicodeRename = intent.displayPath === packagedOpenConfig.paths.unicodeFile
      && !packagedOpenConfig.unicodeRenameReady;
    if (!waitsForUnicodeRename) {
      decide(packagedOpenConfig);
      return undefined;
    }

    let disposed = false;
    let attempts = 0;
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
    const poll = async () => {
      attempts += 1;
      try {
        const config = await getPackagedOpenE2eConfig();
        if (disposed || !config) return;
        if (config.unicodeRenameReady) {
          setPackagedOpenConfig(config);
          decide(config);
          return;
        }
      } catch {
        // A transient instrumentation read must not bypass the rename gate.
      }
      if (!disposed && attempts < PACKAGED_UNICODE_READY_MAX_ATTEMPTS) {
        timer = globalThis.setTimeout(poll, PACKAGED_UNICODE_READY_POLL_INTERVAL_MS);
      }
    };
    void poll();
    return () => {
      disposed = true;
      if (timer !== undefined) globalThis.clearTimeout(timer);
    };
  }, [
    handleCancelFileSwitch,
    handleFileSwitchWithoutSaving,
    packagedOpenConfig,
    pendingOpenIntent,
    unsavedFileSwitchPrompt,
  ]);

  const dismissFeedbackDialog = useCallback(() => {
    setError(null);
    setNotice(null);
  }, [setError, setNotice]);

  const openExportDialog = useCallback(() => {
    if (activeFileKind !== 'markdown' && activeFileKind !== 'excalidraw') return;
    const preview = previewPaneRef.current?.querySelector<HTMLElement>('.mmd-preview-content');
    const diagramErrors = preview
      ? Array.from(preview.querySelectorAll<HTMLElement>('.image-error, .mmd-excalidraw-embed-status:not([aria-busy="true"])')).map((node) => node.textContent?.trim() || 'diagram error')
      : [];
    const imageSources = preview ? Array.from(preview.querySelectorAll<HTMLImageElement>('img')).map((image) => ({
      src: image.currentSrc || image.src,
      available: image.complete && image.naturalWidth > 0,
    })) : [];
    setExportIssues(collectExportPreflightIssues({ document: content, diagramErrors, imageSources }));
    setExportValue((current) => ({ ...current, format: activeFileKind === 'excalidraw' ? 'excalidraw' : current.format === 'excalidraw' ? 'html' : current.format }));
    setShowExport(true);
  }, [activeFileKind, content, previewPaneRef]);

  useEffect(() => {
    if (isPopout) return;
    const shortcuts = resolveShortcutProfile(settingsState.settings?.shortcuts ?? {});
    const actions: Record<ShortcutAction, () => void> = {
      save: () => void handleSave(),
      saveAs: () => void handleSaveAs(),
      quickOpen: () => showWorkspaceSearchDialog('quick-open'),
      workspaceSearch: () => showWorkspaceSearchDialog('workspace-search'),
      export: openExportDialog,
      settings: () => setShowSettings(true),
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (openIntentModalActive) return;
      const target = event.target as HTMLElement | null;
      const typing = target?.matches('input, textarea, select, [contenteditable="true"]') ?? false;
      for (const action of Object.keys(shortcuts) as ShortcutAction[]) {
        if (typing && action !== 'save' && action !== 'saveAs') continue;
        if (!shortcutMatchesEvent(shortcuts[action], event)) continue;
        event.preventDefault();
        actions[action]();
        return;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleSave, handleSaveAs, isPopout, openExportDialog, openIntentModalActive, settingsState.settings?.shortcuts, showWorkspaceSearchDialog]);

  const runExport = useCallback(async () => {
    setExportBusy(true);
    try {
      const baseName = (activePath?.split(/[\\/]/u).pop() ?? 'document').replace(/\.(?:md|markdown|mdx|excalidraw)$/iu, '') || 'document';
      const appearanceForExport = exportValue.theme === 'current' ? appearance : exportValue.theme;
      const skinForExport = exportValue.theme === 'current'
        ? skin
        : resolveThemeForAppearance({ appearance, skin }, appearanceForExport).skin;
      if (exportValue.format === 'excalidraw') {
        if (activeFileKind !== 'excalidraw') throw new Error('Excalidraw bundle export requires an Excalidraw document');
        const runtime = await loadLazyModuleWithRetry(() => import('./lib/excalidrawRuntime'));
        const [one, two, three] = await Promise.all([
          runtime.exportExcalidrawSceneAssets(content, appearanceForExport, 1),
          runtime.exportExcalidrawSceneAssets(content, appearanceForExport, 2),
          runtime.exportExcalidrawSceneAssets(content, appearanceForExport, 3),
        ]);
        const toBase64 = async (blob: Blob) => {
          const bytes = new Uint8Array(await blob.arrayBuffer());
          let binary = '';
          for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
          return btoa(binary);
        };
        const saved = await saveExcalidrawBundle({
          baseName,
          source: content,
          svgBase64: await toBase64(new Blob([two.svgText], { type: 'image/svg+xml' })),
          png1xBase64: await toBase64(one.pngBlob),
          png2xBase64: await toBase64(two.pngBlob),
          png3xBase64: await toBase64(three.pngBlob),
        });
        if (!saved) return;
      } else {
        const preview = previewPaneRef.current?.querySelector<HTMLElement>('.mmd-preview-content');
        if (!preview) throw new Error('Export preview is unavailable');
        let bytes: Uint8Array;
        if (exportValue.format === 'html') {
          const [module, assets] = await Promise.all([
            import('./lib/offlineHtmlExport'),
            import('./lib/exportAssetInlining').then((assetModule) => assetModule.collectOfflineExportAssets(preview)),
          ]);
          const html = module.buildOfflineHtml({ title: baseName, bodyHtml: preview.innerHTML, themeCss: assets.css, theme: appearanceForExport, skin: skinForExport, assetDataUrls: assets.assetDataUrls });
          bytes = new TextEncoder().encode(html);
        } else {
          const [module, assets] = await Promise.all([
            import('./lib/longPngExport'),
            import('./lib/exportAssetInlining').then((assetModule) => assetModule.collectOfflineExportAssets(preview)),
          ]);
          const sourceRect = preview.getBoundingClientRect();
          const clone = preview.cloneNode(true) as HTMLElement;
          for (const image of Array.from(clone.querySelectorAll<HTMLImageElement>('img'))) {
            const source = image.getAttribute('src') ?? '';
            if (assets.assetDataUrls[source]) image.setAttribute('src', assets.assetDataUrls[source]);
          }
          const blob = await module.renderElementToLongPng(clone, { scale: exportValue.scale, appearance: appearanceForExport, skin: skinForExport, background: appearanceForExport === 'dark' ? '#171717' : '#ffffff', cssText: assets.css, sourceWidth: sourceRect.width, sourceHeight: preview.scrollHeight || sourceRect.height });
          bytes = new Uint8Array(await blob.arrayBuffer());
        }
        let binary = '';
        for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
        const saved = await saveExport({ kind: exportValue.format, defaultName: baseName, bytesBase64: btoa(binary) });
        if (!saved) return;
      }
      setShowExport(false);
      setError(null);
      setNotice(locale === 'zh-CN' ? '导出已完成。' : 'Export completed.');
    } catch (exportError) {
      setShowExport(false);
      setError(normalizeAppError(exportError, locale));
      setNotice(null);
    } finally {
      setExportBusy(false);
    }
  }, [activeFileKind, activePath, appearance, content, exportValue, locale, previewPaneRef, setError, setNotice, skin]);

  const handleWorkspaceEntryConfirm = useCallback((name?: string) => {
    const operation = workspaceEntryOperation;
    if (!operation) return;
    setWorkspaceEntryOperation(null);
    if (operation.kind === 'create-file') {
      void createFileInWorkspace(operation.parentPath, name ?? '', operation.fileKind);
    } else if (operation.kind === 'create-folder') {
      void createFolderInWorkspace(operation.parentPath, name ?? '');
    } else if (operation.kind === 'rename') {
      void renameWorkspaceEntryPath(operation.path, name ?? '');
    } else {
      void deleteWorkspaceEntryPath(operation.path);
    }
  }, [createFileInWorkspace, createFolderInWorkspace, deleteWorkspaceEntryPath, renameWorkspaceEntryPath, workspaceEntryOperation]);

  const handleWorkspaceMoveConfirm = useCallback((destinationParentPath: string) => {
    const operation = workspaceMoveOperation;
    if (!operation) return;
    setWorkspaceMoveOperation(null);
    void moveWorkspaceEntryPath(operation.path, destinationParentPath);
  }, [moveWorkspaceEntryPath, workspaceMoveOperation]);

  const toggleFolder = useCallback((path: string) => {
    setCollapsedFolders((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const handleOutlineItemSelect = useCallback((item: MarkdownOutlineItem) => {
    outlineJumpRequestIdRef.current += 1;
    const jump: MarkdownOutlineJump = {
      documentId,
      documentEpoch,
      item,
      requestId: outlineJumpRequestIdRef.current,
    };
    setOutlineJump(jump);
    void emit(OUTLINE_JUMP_EVENT, jump).catch((err: unknown) => {
      setError(normalizeAppError(err, locale));
      setNotice(null);
    });
  }, [documentEpoch, documentId, locale, setError, setNotice]);

  const requestEditorPopoutReady = useCallback(() => {
    if (pendingEditorPopoutReadyRequestIdRef.current) return;
    const readyRequestId = createPaneProtocolId('markdown-media-ready-request');
    pendingEditorPopoutReadyRequestIdRef.current = readyRequestId;
    editorPopoutReadyRef.current = null;
    cancelMarkdownMediaInsertionHandshake(editorPopoutHandshakeRef.current);
    editorPopoutHandshakeRef.current = null;
    editorPopoutOpenRef.current = true;
    void emitToWithRetry(
      getPanePopoutLabel('editor'),
      MARKDOWN_MEDIA_INSERTION_REQUEST_READY_EVENT,
      { documentEpoch, documentId, readyRequestId },
      () => mountedRef.current,
      markdownMediaRetryControllerRef.current,
    ).catch((err: unknown) => {
      if (!mountedRef.current) return;
      setError(normalizeAppError(err, locale));
      setNotice(null);
    });
  }, [documentEpoch, documentId, locale, setError, setNotice]);

  const handleEditorPopoutOpen = useCallback(() => {
    if (editorPopoutOpen) {
      void openPanePopout('editor').then((outcome) => {
        if (outcome.status !== 'existing') return;
        const ready = editorPopoutReadyRef.current;
        const expectedInstanceId = expectedEditorPopoutInstanceIdRef.current;
        if (
          ready?.documentId === documentId
          && ready.documentEpoch === documentEpoch
        ) return;
        if (expectedInstanceId || pendingEditorPopoutReadyRequestIdRef.current) return;
        requestEditorPopoutReady();
      });
      return;
    }
    if (editorPopoutOpenRequestRef.current) return;
    const instanceId = createPaneProtocolId('markdown-media-popout');
    expectedEditorPopoutInstanceIdRef.current = instanceId;
    pendingEditorPopoutReadyRequestIdRef.current = null;
    const openRequest = openPanePopout('editor', instanceId).then((outcome) => {
      if (expectedEditorPopoutInstanceIdRef.current !== instanceId) return;
      if (outcome.status !== 'failed') editorPopoutOpenRef.current = true;
      if (outcome.status === 'existing') {
        // An existing popout owns its URL-derived instance ID, not this speculative one.
        expectedEditorPopoutInstanceIdRef.current = null;
        const ready = editorPopoutReadyRef.current;
        if (ready?.documentId === documentId && ready.documentEpoch === documentEpoch) {
          expectedEditorPopoutInstanceIdRef.current = ready.popoutInstanceId;
          startEditorPopoutHandshakeRef.current?.(ready);
        } else {
          requestEditorPopoutReady();
        }
      } else if (outcome.status === 'failed') {
        expectedEditorPopoutInstanceIdRef.current = null;
        editorPopoutOpenRef.current = false;
      }
    }).finally(() => {
      if (editorPopoutOpenRequestRef.current === openRequest) {
        editorPopoutOpenRequestRef.current = null;
      }
    });
    editorPopoutOpenRequestRef.current = openRequest;
  }, [documentEpoch, documentId, editorPopoutOpen, openPanePopout, requestEditorPopoutReady]);

  const handleWorkspaceAssetInsert = useCallback((
    asset: WorkspaceFileEntry,
    target: MarkdownMediaInsertionTarget,
  ): void => {
    if (
      activeFileKind !== 'markdown'
      || authorityStatus !== 'committed'
      || !activeWorkspaceMarkdownFile
      || !activePath
      || !workspaceRoot
      || !workspaceToken
    ) return;
    const insertionContext = {
      activePath,
      documentEpoch,
      documentId,
      workspaceRoot,
      workspaceToken,
    };
    const isCurrentContext = () => {
      const current = editorPasteContextRef.current;
      return current.activeFileKind === 'markdown'
        && current.authorityStatus === 'committed'
        && current.activePath === insertionContext.activePath
        && current.documentEpoch === insertionContext.documentEpoch
        && current.documentId === insertionContext.documentId
        && current.workspaceRoot === insertionContext.workspaceRoot
        && current.workspaceToken === insertionContext.workspaceToken;
    };
    const commitMarkdown = (markdown: string | null) => {
      if (!markdown) return;
      mediaInsertionRequestIdRef.current += 1;
      const insertion: MarkdownMediaInsertion = {
        documentEpoch,
        documentId,
        markdown,
        requestId: mediaInsertionRequestIdRef.current,
        target,
      };
      if (target.kind === 'cursor' && editorPopoutOpenRef.current) {
        const popoutInsertion: PendingMarkdownMediaCursorInsertion = {
          asset: {
            kind: asset.kind,
            name: asset.name,
            relative_path: asset.relative_path,
          },
          documentRelativePath: activeWorkspaceMarkdownFile.relative_path,
          documentEpoch,
          documentId,
          requestId: insertion.requestId,
        };
        const ready = editorPopoutReadyRef.current;
        if (ready?.documentId === documentId && ready.documentEpoch === documentEpoch) {
          sendCursorInsertionToEditorPopout({
            ...popoutInsertion,
            popoutInstanceId: ready.popoutInstanceId,
          });
        } else {
          pendingPopoutMediaInsertionsRef.current.push(popoutInsertion);
          const expectedInstanceId = expectedEditorPopoutInstanceIdRef.current;
          if (expectedInstanceId) {
            startEditorPopoutHandshakeRef.current?.({
              documentEpoch,
              documentId,
              popoutInstanceId: expectedInstanceId,
            });
          } else if (!pendingEditorPopoutReadyRequestIdRef.current) {
            requestEditorPopoutReady();
          }
        }
        return;
      }
      setMediaInsertion(insertion);
    };

    if (asset.kind !== 'excalidraw') {
      commitMarkdown(createMarkdownMediaReference(asset, activeWorkspaceMarkdownFile));
      return;
    }
    if (!excalidrawAssetSync) {
      // Settings may still be loading. Preserve the source embed until a
      // resource directory is available rather than losing the insertion.
      commitMarkdown(createMarkdownMediaReference(asset, activeWorkspaceMarkdownFile));
      return;
    }
    void (async () => {
      try {
        const syncModule = await loadLazyModuleWithRetry(() => import('./lib/excalidrawAssetSync'));
        const result = await syncModule.renderAndSyncExcalidrawAssetPair({
          appearance,
          document: activeWorkspaceMarkdownFile,
          documentPath: activePath,
          name: asset.name,
          resourceDirectory: excalidrawAssetSync.resourceDirectory,
          ...(excalidrawAssetSync.resourceDirectoryToken
            ? { resourceDirectoryToken: excalidrawAssetSync.resourceDirectoryToken }
            : {}),
          sourceRelativePath: asset.relative_path,
          workspaceRoot: excalidrawAssetSync.workspaceRoot,
          workspaceToken: excalidrawAssetSync.workspaceToken,
        });
        if (!isCurrentContext()) return;
        commitMarkdown(result.markdown);
      } catch (error) {
        if (mountedRef.current) {
          setError(normalizeAppError(error, locale));
          setNotice(null);
        }
      }
    })();
  }, [
    activeFileKind,
    activePath,
    activeWorkspaceMarkdownFile,
    appearance,
    authorityStatus,
    documentEpoch,
    documentId,
    excalidrawAssetSync,
    locale,
    requestEditorPopoutReady,
    sendCursorInsertionToEditorPopout,
    setError,
    setNotice,
    workspaceRoot,
    workspaceToken,
  ]);

  if (popoutPane === 'editor') {
    return (
      <PopoutPaneShell>
        {settingsState.recovery && <SettingsDialog busy={settingsState.busy} locale={locale} recovery={settingsState.recovery} onReset={settingsState.reset} onRetry={settingsState.retry} />}
        {!settingsState.recovery && feedbackDialog && <FeedbackDialog dialog={feedbackDialog} onDismiss={dismissFeedbackDialog} />}
        {isExcalidrawFile
          ? (
            <ExcalidrawPane
              activePath={activePath}
              content={content}
              documentEpoch={documentEpoch}
              documentId={documentId}
              editable={authorityStatus === 'committed'}
              loadingLabel={t('loadingExcalidraw')}
              locale={locale}
              onContentChange={updateContent}
              onInvalidScene={handleExcalidrawError}
              popout
            />
          )
          : isDocumentFile
          ? <PreviewPane dirty={dirty} popout>{documentPreview}</PreviewPane>
          : isImageFile && activePath
          ? <WorkspaceImagePreview key={activePath} enabled={documentAssetsEnabled} path={activePath} popout previewRevision={previewRevision} />
          : isMediaFile && activePath
            ? <WorkspaceMediaPreview key={activePath} enabled={documentAssetsEnabled} kind={mediaKind} mimeType={mediaMimeType} path={activePath} popout previewRevision={previewRevision} />
            : <EditorPane activePath={activePath} content={content} documentEpoch={documentEpoch} documentId={documentId} editable={authorityStatus === 'committed'} fileKind={editorFileKind} mediaInsertion={currentMediaInsertion} outlineJump={currentOutlineJump} onContentChange={updateContent} onPasteError={handleEditorPasteError} onPasteImage={handleClipboardImagePaste} popout spellcheckEnabled={settingsState.settings?.spellcheckEnabled ?? true} />}
      </PopoutPaneShell>
    );
  }

  if (popoutPane === 'preview') {
    return (
      <PopoutPaneShell>
        {settingsState.recovery && <SettingsDialog busy={settingsState.busy} locale={locale} recovery={settingsState.recovery} onReset={settingsState.reset} onRetry={settingsState.retry} />}
        {!settingsState.recovery && feedbackDialog && <FeedbackDialog dialog={feedbackDialog} onDismiss={dismissFeedbackDialog} />}
        {isExcalidrawFile
          ? (
            <ExcalidrawPane
              activePath={activePath}
              content={content}
              documentEpoch={documentEpoch}
              documentId={documentId}
              editable={false}
              loadingLabel={t('loadingExcalidraw')}
              locale={locale}
              onContentChange={updateContent}
              onInvalidScene={handleExcalidrawError}
              popout
            />
          )
          : isDocumentFile
          ? <PreviewPane dirty={dirty} popout>{documentPreview}</PreviewPane>
          : isImageFile && activePath
          ? <WorkspaceImagePreview key={activePath} enabled={documentAssetsEnabled} path={activePath} popout previewRevision={previewRevision} />
          : isMediaFile && activePath
            ? <WorkspaceMediaPreview key={activePath} enabled={documentAssetsEnabled} kind={mediaKind} mimeType={mediaMimeType} path={activePath} popout previewRevision={previewRevision} />
          : (
            <PreviewPane dirty={dirty} outlineJump={currentOutlineJump} popout>
              {activePresentation.preview === 'html' && activePath
                ? <WorkspaceHtmlPreview content={content} enabled={documentAssetsEnabled} path={activePath} />
                : <JinxiuMarkdown
                  currentFilePath={activePath}
                  documentRelativePath={activeWorkspaceMarkdownFile?.relative_path ?? null}
                  excalidrawAssetSync={excalidrawAssetSync}
                  localAssetsEnabled={documentAssetsEnabled}
                  workspaceRoot={workspaceRoot}
                >{content}</JinxiuMarkdown>}
            </PreviewPane>
          )}
      </PopoutPaneShell>
    );
  }

  return (
    <div className="app-shell">
      <AppToolbar
        activePath={activePath}
        busy={busy}
        canSearch={Boolean(workspaceRoot && workspaceToken) && !busy && workspaceSearchMode === null}
        dirty={dirty}
        onQuickOpen={() => showWorkspaceSearchDialog('quick-open')}
        onWorkspaceSearch={() => showWorkspaceSearchDialog('workspace-search')}
        onExport={activeFileKind === 'markdown' || activeFileKind === 'excalidraw' ? openExportDialog : undefined}
      />
      <button
        type="button"
        className="settings-launch-button"
        aria-label={locale === 'zh-CN' ? '打开设置' : 'Open settings'}
        title={locale === 'zh-CN' ? '设置' : 'Settings'}
        disabled={settingsState.busy || settingsState.settings === null}
        onClick={() => setShowSettings(true)}
      >
        <Settings size={17} />
      </button>

      {showExport ? (
        <ExportDialog busy={exportBusy} canExportExcalidraw={activeFileKind === 'excalidraw'} issues={exportIssues} locale={locale} value={exportValue} onCancel={() => setShowExport(false)} onChange={setExportValue} onExport={() => void runExport()} />
      ) : workspaceSearchMode && workspaceRoot && workspaceToken ? (
        workspaceSearchMode === 'quick-open' ? (
          <QuickOpenDialog
            workspaceRoot={workspaceRoot}
            workspaceToken={workspaceToken}
            onCancel={() => setWorkspaceSearchMode(null)}
            onError={(error) => {
              setWorkspaceSearchMode(null);
              setError(normalizeAppError(error, locale));
              setNotice(null);
            }}
            onSelect={requestWorkspaceSearchOpen}
          />
        ) : (
          <WorkspaceSearchDialog
            mode="workspace-search"
            workspaceRoot={workspaceRoot}
            workspaceToken={workspaceToken}
            onCancel={() => setWorkspaceSearchMode(null)}
            onError={(error) => {
              setWorkspaceSearchMode(null);
              setError(normalizeAppError(error, locale));
              setNotice(null);
            }}
            onSelect={requestWorkspaceSearchOpen}
          />
        )
      ) : crashDraftRecovery.error ? (
        <CrashDraftStoreRepairDialog
          busy={crashDraftRecovery.busy}
          canRepairOverflow={crashDraftRecovery.canRepairOverflow}
          error={crashDraftRecovery.error}
          locale={locale}
          overflowRepairProgress={crashDraftRecovery.overflowRepairProgress}
          onRepairOverflow={crashDraftRecovery.repairOverflowBatch}
          onRetry={crashDraftRecovery.retry}
        />
      ) : settingsState.recovery ? (
        <SettingsDialog
          busy={settingsState.busy}
          locale={locale}
          recovery={settingsState.recovery}
          onReset={settingsState.reset}
          onRetry={settingsState.retry}
        />
      ) : externalFileAction ? (
        <ExternalFileChangeDialog
          action={externalFileAction}
          onCloseDeletedDraft={() => void handleCloseDeletedDraft()}
          onKeepCurrent={() => void handleKeepCurrentExternal()}
          onSaveDeletedDraftAs={() => void handleSaveDeletedDraftAs()}
          onUseExternal={() => void handleUseExternal()}
        />
      ) : saveConflict ? (
        <DocumentSaveConflictDialog
          conflict={saveConflict}
          onCancel={handleCancelSaveConflict}
          onOverwrite={() => void handleOverwriteSaveConflict()}
        />
      ) : showUnsavedExitPrompt ? (
        <UnsavedExitDialog
          busy={busy}
          prompt={unsavedExitPrompt}
          onCancelExit={handleCancelExit}
          onQuitWithoutSaving={handleQuitWithoutSaving}
          onSaveAndQuit={handleSaveAndQuit}
        />
      ) : unsavedFileSwitchPrompt ? (
        <UnsavedExitDialog
          busy={busy}
          prompt={unsavedFileSwitchPrompt}
          onCancelExit={handleCancelFileSwitch}
          onQuitWithoutSaving={handleFileSwitchWithoutSaving}
          onSaveAndQuit={() => void handleSaveAndSwitchFile()}
        />
      ) : workspaceEntryOperation ? (
        <WorkspaceEntryDialog
          busy={busy}
          operation={workspaceEntryOperation}
          onCancel={() => setWorkspaceEntryOperation(null)}
          onConfirm={handleWorkspaceEntryConfirm}
        />
      ) : workspaceMoveOperation ? (
        <WorkspaceMoveDialog
          busy={busy}
          destinations={workspaceMoveDestinations}
          operation={workspaceMoveOperation}
          onCancel={() => setWorkspaceMoveOperation(null)}
          onConfirm={handleWorkspaceMoveConfirm}
        />
      ) : showSettings && settingsState.settings ? (
        <SettingsDialog
          busy={settingsState.busy || workspaceIndexActionBusy}
          locale={locale}
          settings={settingsState.settings}
          workspaceAvailable={Boolean(workspaceRoot && workspaceToken)}
          onAuthorizeResourceDirectory={handleAuthorizeResourceDirectory}
          onClose={() => setShowSettings(false)}
          onDiscardWorkspaceIndex={discardCurrentWorkspaceIndex}
          onRebuildWorkspaceIndex={rebuildCurrentWorkspaceIndex}
          onReset={async () => {
            await settingsState.reset();
            setShowSettings(false);
          }}
          onSave={async (nextSettings) => {
            await settingsState.updateSettings(nextSettings);
            setShowSettings(false);
          }}
        />
      ) : appUpdater.update ? (
        <UpdateAvailableDialog
          locale={locale}
          version={appUpdater.update.version}
          currentVersion={appUpdater.update.currentVersion}
          body={appUpdater.update.body}
          busy={appUpdater.installing}
          onLater={appUpdater.later}
          onSkip={appUpdater.skip}
          onUpdate={async () => {
            try {
              await appUpdater.install();
            } catch (updateError) {
              setError(normalizeAppError(updateError, locale));
              setNotice(null);
              appUpdater.later();
            }
          }}
        />
      ) : feedbackDialog ? (
        <FeedbackDialog dialog={feedbackDialog} onDismiss={dismissFeedbackDialog} />
      ) : null}

      <main className={getWorkspaceLayoutClassName(fileTreeCollapsed, activeFileKind)} style={workspaceLayoutStyle}>
        <FileSidebar
          activePath={activePath}
          collapsed={fileTreeCollapsed}
          collapsedFolders={collapsedFolders}
          disabled={busy || externalFileAction !== null || pendingOpenIntent !== null}
          fileTree={fileTree}
          onCollapseChange={setFileTreeCollapsed}
          onCreateFile={(parentPath, parentName, fileKind) => setWorkspaceEntryOperation({
            fileKind,
            kind: 'create-file',
            parentName,
            parentPath,
          })}
          onCreateFolder={(parentPath, parentName) => setWorkspaceEntryOperation({ kind: 'create-folder', parentName, parentPath })}
          onDeleteEntry={(path, currentName, entryKind) => setWorkspaceEntryOperation({ currentName, entryKind, kind: 'delete', path })}
          onInsertWorkspaceAsset={activeFileKind === 'markdown'
            && authorityStatus === 'committed'
            && activeWorkspaceMarkdownFile
            ? handleWorkspaceAssetInsert
            : undefined}
          onMoveEntry={(path, destinationParentPath) => void moveWorkspaceEntryPath(path, destinationParentPath)}
          onOpenFile={requestWorkspaceFileOpen}
          onRenameEntry={(path, newName) => void renameWorkspaceEntryPath(path, newName)}
          onRequestMove={(target) => setWorkspaceMoveOperation({
            currentName: target.name,
            entryKind: target.kind,
            path: target.path,
          })}
          onSelectOutlineItem={handleOutlineItemSelect}
          onRefreshWorkspace={() => void refreshWorkspace()}
          onToggleFolder={toggleFolder}
          outlineItems={outlineItems}
          workspaceRoot={workspaceRoot}
        />

        {!fileTreeCollapsed && (
          <WorkspaceSidebarResizer
            sidebarWidth={workspaceSidebarWidth}
            onKeyDown={resizeWorkspaceSidebarWithKeyboard}
            onPointerCancel={stopWorkspaceSidebarResize}
            onPointerDown={startWorkspaceSidebarResize}
            onPointerMove={moveWorkspaceSidebarResize}
            onPointerUp={stopWorkspaceSidebarResize}
          />
        )}

        {isExcalidrawFile ? (
          <ExcalidrawPane
            activePath={activePath}
            content={content}
            documentEpoch={documentEpoch}
            documentId={documentId}
            editable={authorityStatus === 'committed'}
            loadingLabel={t('loadingExcalidraw')}
            locale={locale}
            paneRef={editorPaneRef}
            popoutButton={editorPopoutButton}
            onContentChange={updateContent}
            onInvalidScene={handleExcalidrawError}
            onPopout={handleEditorPopoutOpen}
          />
        ) : isDocumentFile ? (
          <PreviewPane
            dirty={dirty}
            paneRef={previewPaneRef}
            popoutButton={previewPopoutButton}
            onPopout={() => void openPanePopout('preview')}
          >
            {documentPreview}
          </PreviewPane>
        ) : isImageFile && activePath ? (
          <WorkspaceImagePreview
            key={activePath}
            enabled={documentAssetsEnabled}
            path={activePath}
            paneRef={previewPaneRef}
            popoutButton={previewPopoutButton}
            previewRevision={previewRevision}
            onPopout={() => void openPanePopout('preview')}
          />
        ) : isMediaFile && activePath ? (
          <WorkspaceMediaPreview
            key={activePath}
            enabled={documentAssetsEnabled}
            kind={mediaKind}
            mimeType={mediaMimeType}
            path={activePath}
            paneRef={previewPaneRef}
            popoutButton={previewPopoutButton}
            previewRevision={previewRevision}
            onPopout={() => void openPanePopout('preview')}
          />
        ) : (
          <>
            <EditorPane
              activePath={activePath}
              content={content}
              documentEpoch={documentEpoch}
              documentId={documentId}
              editable={authorityStatus === 'committed'}
              fileKind={editorFileKind}
              mediaInsertion={currentMediaInsertion}
              outlineJump={currentOutlineJump}
              paneRef={editorPaneRef}
              popoutButton={editorPopoutButton}
              onContentChange={updateContent}
              onPasteError={handleEditorPasteError}
              onPasteImage={handleClipboardImagePaste}
              onPopout={handleEditorPopoutOpen}
              spellcheckEnabled={settingsState.settings?.spellcheckEnabled ?? true}
            />

            <PaneResizer
              editorPaneRatio={editorPaneRatio}
              onKeyDown={resizePaneWithKeyboard}
              onPointerCancel={stopPaneResize}
              onPointerDown={startPaneResize}
              onPointerMove={movePaneResize}
              onPointerUp={stopPaneResize}
            />

            <PreviewPane
              dirty={dirty}
              outlineJump={currentOutlineJump}
              paneRef={previewPaneRef}
              popoutButton={previewPopoutButton}
              onPopout={() => void openPanePopout('preview')}
            >
              {activePresentation.preview === 'html' && activePath
                ? <WorkspaceHtmlPreview content={content} enabled={documentAssetsEnabled} path={activePath} />
                : <JinxiuMarkdown
                  currentFilePath={activePath}
                  documentRelativePath={activeWorkspaceMarkdownFile?.relative_path ?? null}
                  excalidrawAssetSync={excalidrawAssetSync}
                  localAssetsEnabled={documentAssetsEnabled}
                  workspaceRoot={workspaceRoot}
                >{content}</JinxiuMarkdown>}
            </PreviewPane>
          </>
        )}
      </main>
    </div>
  );
}
