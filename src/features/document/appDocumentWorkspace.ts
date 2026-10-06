import { useMemo, useRef } from 'react';
import type { EffectiveLocale } from '../../lib/locale';
import { useAppSessionContext } from './appSessionContext';
import { useOutlineJumpBridge } from './outlineJumpBridge';
import { useAppDocumentSurface } from '../preview/useAppDocumentSurface';
import { useEditorPasteBridge } from './editorPasteBridge';

type SessionContext = ReturnType<typeof useAppSessionContext>;

export interface AppDocumentWorkspaceDeps {
  appearance: 'light' | 'dark';
  isPopout: boolean;
  locale: EffectiveLocale;
  popoutPane: 'editor' | 'main' | 'preview';
  settings: Parameters<typeof useAppSessionContext>[0]['settings'] & {
    resourceDirectory?: string | null;
  } | null;
  translate: (key: 'loadingDocx' | 'loadingPdf' | 'mediaPickUnavailable') => string;
}

// 文档工作台组合：会话上下文（含崩溃草稿与反馈派生）、呈现面、粘贴桥、
// Excalidraw 资源同步与大纲跳转桥。App 只消费聚合结果。
export function useAppDocumentWorkspace(deps: AppDocumentWorkspaceDeps) {
  const { locale, translate } = deps;
  const mountedRef = useRef(true);
  const crashDraftIntentSinkRef = useRef<((source: 'crash_recovery', path: string, action: { kind: 'crash_draft'; draft: never }) => void) | null>(null);
  const { crashDraftRecovery, feedbackDialog, session } = useAppSessionContext({
    enqueueCrashDraftIntent: (source, displayPath, action) => crashDraftIntentSinkRef.current?.(source, displayPath, action as { kind: 'crash_draft'; draft: never }),
    isPopout: deps.isPopout,
    locale,
    popoutPane: deps.popoutPane,
    settings: deps.settings });
  const { content, files = [] } = session;
  const currentContentRef = useRef(content);
  currentContentRef.current = content;
  const { outline, surface } = useWorkspacePresentation(deps, locale, translate, session, files, content);
  const paste = useEditorPasteBridge({
    locale,
    mountedRef,
    setError: session.setError,
    setNotice: session.setNotice,
    session: {
      activeFileKind: session.activeFileKind,
      activePath: session.activePath,
      activeWorkspaceMarkdownFile: surface.activeWorkspaceMarkdownFile,
      authorityStatus: session.authorityStatus,
      documentEpoch: session.documentEpoch,
      documentId: session.documentId,
      resourceDirectory: deps.settings?.resourceDirectory ?? null,
      workspaceRoot: session.workspaceRoot,
      workspaceToken: session.workspaceToken },
    translate });
  const excalidrawAssetSync = useExcalidrawAssetSync(session, paste.resourceDirectoryAuthorization, deps.settings);
  return {
    crashDraftIntentSinkRef,
    crashDraftRecovery,
    currentContentRef,
    excalidrawAssetSync,
    feedbackDialog,
    mountedRef,
    outline,
    paste,
    session,
    surface };
}


function useWorkspacePresentation(
  deps: AppDocumentWorkspaceDeps,
  locale: EffectiveLocale,
  translate: AppDocumentWorkspaceDeps['translate'],
  session: ReturnType<typeof useAppSessionContext>['session'],
  files: Parameters<typeof useAppDocumentSurface>[0]['files'],
  content: string,
) {
  void deps;
  const outline = useOutlineJumpBridge({
    documentEpoch: session.documentEpoch,
    documentId: session.documentId,
    isPopout: deps.isPopout,
    locale,
    setError: session.setError,
    setNotice: session.setNotice });
  const surface = useAppDocumentSurface({
    activeFileKind: session.activeFileKind,
    activeMimeType: session.activeMimeType,
    activePath: session.activePath,
    authorityStatus: session.authorityStatus,
    bytesBase64: session.bytesBase64,
    content,
    documentEpoch: session.documentEpoch,
    documentId: session.documentId,
    files,
    locale,
    setError: session.setError,
    setNotice: session.setNotice,
    translate,
    workspaceRoot: session.workspaceRoot,
    workspaceToken: session.workspaceToken });
  return { outline, surface };
}

function useExcalidrawAssetSync(
  session: SessionContext['session'],
  authorization: { path: string; token: string } | null,
  settings: AppDocumentWorkspaceDeps['settings'],
) {
  return useMemo(() => {
    const resourceDirectory = settings?.resourceDirectory;
    if (!session.workspaceRoot || !session.workspaceToken || !resourceDirectory) return null;
    const absolute = isAbsoluteResourceDirectory(resourceDirectory);
    if (absolute && authorization?.path !== resourceDirectory) return null;
    return {
      resourceDirectory,
      ...(authorization?.path === resourceDirectory
        ? { resourceDirectoryToken: authorization.token }
        : {}),
      workspaceRoot: session.workspaceRoot,
      workspaceToken: session.workspaceToken };
  }, [authorization, session.workspaceRoot, session.workspaceToken, settings?.resourceDirectory]);
}

function isAbsoluteResourceDirectory(value: string): boolean {
  return value.startsWith('/')
    || value.startsWith('\\\\')
    || /^[A-Za-z]:[\\/]/u.test(value);
}
