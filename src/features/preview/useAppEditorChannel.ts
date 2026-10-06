import { useCallback, useEffect } from 'react';
import type { EffectiveLocale } from '../../lib/locale';
import type { DocumentAuthorityStatus } from '../../lib/documentSession';
import type { MediaEmbedCommandId } from '../../lib/markdownFormatCommands';
import type { MarkdownMediaInsertion } from '../../lib/markdownMedia';
import type { WorkspaceFileEntry } from '../../types';
import { useEditorPopoutMediaChannel } from './editorPopoutMediaChannel';
import { useWorkspaceAssetInsertion } from './workspaceAssetInsertion';
import type { EditorPasteContextSnapshot } from '../document/editorPasteBridge';
import type { AppPaneSurfaceView } from './appPaneSurface';

export interface AppEditorChannelSession {
  authorityStatus: DocumentAuthorityStatus;
  documentEpoch: number;
  documentId: string;
  setError: (message: string | null) => void;
  setNotice: (message: string | null) => void;
  workspaceRoot: string | null;
  workspaceToken: string | null;
}

export interface AppEditorChannelDocumentScope {
  activePath: string | null;
  activeWorkspaceMarkdownFile: WorkspaceFileEntry | null;
  appearance: 'light' | 'dark';
}

// 编辑器与外部的通道编排：弹出媒体通道、工作区资产插入与挂载生命周期。
export function useAppEditorChannel(deps: {
  activeFileKind: Parameters<typeof useEditorPopoutMediaChannel>[0]['activeFileKind'];
  dispatchEditorMediaCommandPick: (
    command: MediaEmbedCommandId,
    enqueue: (next: MarkdownMediaInsertion) => void,
  ) => Promise<void>;
  editorPopoutInstanceId: string | null;
  editorPopoutOpen: boolean;
  excalidrawAssetSync: AppPaneSurfaceView['excalidrawAssetSync'];
  isPopout: boolean;
  locale: EffectiveLocale;
  mountedRef: React.RefObject<boolean>;
  openPanePopout: Parameters<typeof useEditorPopoutMediaChannel>[0]['openPanePopout'];
  documentScope: AppEditorChannelDocumentScope;
  pasteContextRef: React.RefObject<EditorPasteContextSnapshot>;
  popoutPane: string;
  session: AppEditorChannelSession;
  translate: Parameters<typeof useEditorPopoutMediaChannel>[0]['translate'];
}) {
  const { session } = deps;
  const channel = useEditorPopoutMediaChannel({
    activeFileKind: deps.activeFileKind,
    activePath: deps.documentScope.activePath,
    authorityStatus: session.authorityStatus,
    documentEpoch: session.documentEpoch,
    documentId: session.documentId,
    editorPopoutInstanceId: deps.editorPopoutInstanceId,
    editorPopoutOpen: deps.editorPopoutOpen,
    isPopout: deps.isPopout,
    locale: deps.locale,
    mountedRef: deps.mountedRef,
    openPanePopout: deps.openPanePopout,
    popoutPane: deps.popoutPane,
    setError: session.setError,
    setNotice: session.setNotice,
    translate: deps.translate,
    workspaceRoot: session.workspaceRoot });
  const handleEditorMediaCommandPick = useEditorMediaPickDispatch(
    deps.dispatchEditorMediaCommandPick, channel.enqueueMediaInsertion);
  const handleWorkspaceAssetInsert = useAppWorkspaceAssetInsertion(deps, session, channel);
  useMountedFlag(deps.mountedRef);

  return {
    channel,
    currentMediaInsertion: currentMediaInsertionOf(channel, session),
    handleEditorMediaCommandPick,
    handleWorkspaceAssetInsert };
}

function useAppWorkspaceAssetInsertion(
  deps: Parameters<typeof useAppEditorChannel>[0],
  session: AppEditorChannelSession,
  channel: ReturnType<typeof useEditorPopoutMediaChannel>,
) {
  return useWorkspaceAssetInsertion({
    channel,
    excalidrawAssetSync: deps.excalidrawAssetSync,
    locale: deps.locale,
    mountedRef: deps.mountedRef,
    pasteContextRef: deps.pasteContextRef,
    session: {
      activePath: deps.documentScope.activePath,
      activeWorkspaceMarkdownFile: deps.documentScope.activeWorkspaceMarkdownFile,
      appearance: deps.documentScope.appearance,
      documentEpoch: session.documentEpoch,
      documentId: session.documentId,
      workspaceRoot: session.workspaceRoot,
      workspaceToken: session.workspaceToken },
    setError: session.setError,
    setNotice: session.setNotice });
}

// 媒体插入归属当前文档时才下发，其余丢弃。
function currentMediaInsertionOf(
  channel: ReturnType<typeof useEditorPopoutMediaChannel>,
  session: AppEditorChannelSession,
): MarkdownMediaInsertion | null {
  return channel.mediaInsertion?.documentId === session.documentId
    && channel.mediaInsertion.documentEpoch === session.documentEpoch
    ? channel.mediaInsertion
    : null;
}

function useEditorMediaPickDispatch(
  dispatch: Parameters<typeof useAppEditorChannel>[0]['dispatchEditorMediaCommandPick'],
  enqueueMediaInsertion: (next: MarkdownMediaInsertion) => void,
) {
  return useCallback(async (command: MediaEmbedCommandId) => {
    await dispatch(command, enqueueMediaInsertion);
  }, [dispatch, enqueueMediaInsertion]);
}

// 挂载标志：供弹窗/插入通道判断是否仍活跃。
function useMountedFlag(mountedRef: React.RefObject<boolean>): void {
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, [mountedRef]);
}
