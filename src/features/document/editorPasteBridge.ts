import { useCallback, useRef, useState } from 'react';
import type { ClipboardImagePasteRequest } from '../workspace/EditorPane';
import type { DocumentAuthorityStatus } from '../../lib/documentSession';
import { normalizeAppError } from '../../lib/appFeedback';
import {
  createMarkdownImageReference,
  createMarkdownPickedMediaReference,
  type MarkdownMediaInsertion } from '../../lib/markdownMedia';
import type { MediaEmbedCommandId } from '../../lib/markdownFormatCommands';
import {
  authorizeResourceDirectory,
  pickMediaResources,
  writeWorkspaceResource,
  type ResourceDirectoryAuthorization } from '../../lib/tauriCommands';
import type { EffectiveLocale } from '../../lib/locale';
import type { WorkspaceFileKind, WorkspaceFileEntry } from '../../types';

export type EditorPasteContextSnapshot = {
  activeFileKind: WorkspaceFileKind;
  activePath: string | null;
  activeWorkspaceMarkdownFile: WorkspaceFileEntry | null;
  authorityStatus: DocumentAuthorityStatus;
  documentEpoch: number | null;
  documentId: string | null;
  resourceDirectory: string | null;
  resourceDirectoryAuthorization: { path: string; token: string } | null;
  workspaceRoot: string | null;
  workspaceToken: string | null;
};

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunkSize = 32_768;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function editorPasteContextIsCurrent(
  current: EditorPasteContextSnapshot,
  request: ClipboardImagePasteRequest,
  context: EditorPasteContextSnapshot,
): boolean {
  if (
    current.documentId !== request.documentId
    || current.documentEpoch !== request.documentEpoch
    || current.activeFileKind !== 'markdown'
    || current.authorityStatus !== 'committed'
  ) return false;
  return editorPasteContextMatches(current, context);
}

function editorPasteContextMatches(
  current: EditorPasteContextSnapshot,
  context: EditorPasteContextSnapshot,
): boolean {
  return current.activePath === context.activePath
    && current.workspaceRoot === context.workspaceRoot
    && current.workspaceToken === context.workspaceToken
    && current.resourceDirectoryAuthorization?.path
      === context.resourceDirectoryAuthorization?.path
    && current.resourceDirectoryAuthorization?.token
      === context.resourceDirectoryAuthorization?.token;
}

function clipboardPasteIsAuthorized(
  isCurrent: boolean,
  context: EditorPasteContextSnapshot,
): boolean {
  return isCurrent
    && context.activePath !== null
    && context.activeWorkspaceMarkdownFile !== null
    && context.resourceDirectory !== null
    && context.workspaceRoot !== null
    && context.workspaceToken !== null;
}

async function writeClipboardImageResource(
  context: EditorPasteContextSnapshot,
  request: ClipboardImagePasteRequest,
  bytesBase64: string,
) {
  return writeWorkspaceResource({
    workspaceToken: context.workspaceToken as string,
    workspaceRoot: context.workspaceRoot as string,
    documentPath: context.activePath as string,
    resourceDirectory: context.resourceDirectory as string,
    bytesBase64,
    mimeType: request.mimeType,
    suggestedName: request.suggestedName,
    ...(context.resourceDirectoryAuthorization?.path === context.resourceDirectory
      ? { resourceDirectoryToken: context.resourceDirectoryAuthorization.token }
      : {}) });
}

function clipboardImageMarkdownReference(
  request: ClipboardImagePasteRequest,
  resource: { fileName?: string | null; markdownPath: string },
): string {
  const resourceName = request.suggestedName
    || resource.fileName
    || 'image';
  const markdown = createMarkdownImageReference(resourceName, resource.markdownPath);
  if (!markdown) throw new Error('Clipboard image resource path could not be inserted.');
  return markdown;
}

async function pasteClipboardImageResource(
  request: ClipboardImagePasteRequest,
  deps: {
    contextRef: React.RefObject<EditorPasteContextSnapshot>;
    isMounted: () => boolean;
    onPasteError: (error: unknown) => void;
  },
): Promise<string | null> {
  const context = deps.contextRef.current;
  const isCurrentContext = () => editorPasteContextIsCurrent(deps.contextRef.current, request, context);
  try {
    if (!clipboardPasteIsAuthorized(isCurrentContext(), context)) {
      throw new Error('Clipboard image paste is not authorized for the active workspace document.');
    }
    const bytesBase64 = await blobToBase64(request.blob);
    if (!isCurrentContext()) return null;
    const resource = await writeClipboardImageResource(context, request, bytesBase64);
    if (!isCurrentContext()) return null;
    return clipboardImageMarkdownReference(request, resource);
  } catch (pasteError) {
    if (deps.isMounted()) deps.onPasteError(pasteError);
    return null;
  }
}

function mediaCommandKind(command: MediaEmbedCommandId): 'image' | 'video' | 'html' {
  if (command === 'image' || command === 'meme') return 'image';
  return command === 'video' ? 'video' : 'html';
}

function mediaPickContextIsCurrent(
  current: EditorPasteContextSnapshot,
  context: EditorPasteContextSnapshot,
): boolean {
  return current.activeFileKind === 'markdown'
    && current.authorityStatus === 'committed'
    && current.activePath === context.activePath
    && current.documentEpoch === context.documentEpoch
    && current.documentId === context.documentId
    && current.workspaceRoot === context.workspaceRoot
    && current.workspaceToken === context.workspaceToken;
}

async function pickMediaResourcesForContext(
  context: EditorPasteContextSnapshot,
  command: MediaEmbedCommandId,
) {
  return pickMediaResources({
    mediaKind: mediaCommandKind(command),
    defaultDirectory: (context.activePath as string).split(/[\\/]/u).slice(0, -1).join('/') || '/',
    workspaceToken: context.workspaceToken as string,
    workspaceRoot: context.workspaceRoot as string,
    documentPath: context.activePath as string,
    resourceDirectory: context.resourceDirectory as string,
    ...(context.resourceDirectoryAuthorization?.path === context.resourceDirectory
      ? { resourceDirectoryToken: context.resourceDirectoryAuthorization.token }
      : {}) });
}

// 格式面板媒体命令的资源选择入口：选择器默认定位当前文档所在目录；工作区内
// 的文件直接引用，工作区外的文件由后端导入资源目录后再引用（见 pick_media_resources）。
async function pickEditorMediaCommand(
  command: MediaEmbedCommandId,
  deps: {
    contextRef: React.RefObject<EditorPasteContextSnapshot>;
    onUnavailable: () => void;
    onPasteError: (error: unknown) => void;
    setMediaInsertion: (next: MarkdownMediaInsertion) => void;
  },
): Promise<void> {
  const context = deps.contextRef.current;
  if (!clipboardPasteIsAuthorized(true, context)) {
    deps.onUnavailable();
    return;
  }
  const isCurrentContext = () => mediaPickContextIsCurrent(deps.contextRef.current, context);
  try {
    const picked = await pickMediaResourcesForContext(context, command);

    if (!isCurrentContext()) return;
    if (!picked || picked.length === 0) return;
    const markdown = picked
      .map((resource) => createMarkdownPickedMediaReference(command, resource.name, resource.markdownPath))
      .filter((reference): reference is string => reference !== null)
      .join('\n\n');
    if (!markdown) throw new Error('Picked media resources could not be inserted.');
    deps.setMediaInsertion({
      documentEpoch: context.documentEpoch as number,
      documentId: context.documentId as string,
      markdown,
      requestId: 0,
      target: { kind: 'cursor' },
    });
  } catch (pickError) {
    if (isCurrentContext()) deps.onPasteError(pickError);
  }
}

function useResourceDirectoryAuthorization(
  locale: EffectiveLocale,
  setError: (message: string | null) => void,
  setNotice: (message: string | null) => void,
) {
  const [resourceDirectoryAuthorization, setResourceDirectoryAuthorization] = useState<
    ResourceDirectoryAuthorization | null
  >(null);
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
  return { handleAuthorizeResourceDirectory, resourceDirectoryAuthorization };
}

function useEditorMediaCommandPicker(
  contextRef: React.RefObject<EditorPasteContextSnapshot>,
  handleEditorPasteError: (error: unknown) => void,
  setError: (message: string | null) => void,
  setNotice: (message: string | null) => void,
  translate: (key: 'mediaPickUnavailable') => string,
) {
  return useCallback(async (
    command: MediaEmbedCommandId,
    enqueueMediaInsertion: (next: MarkdownMediaInsertion) => void,
  ) => {
    await pickEditorMediaCommand(command, {
      contextRef,
      onUnavailable: () => {
        setError(translate('mediaPickUnavailable'));
        setNotice(null);
      },
      onPasteError: handleEditorPasteError,
      setMediaInsertion: enqueueMediaInsertion,
    });
  }, [contextRef, handleEditorPasteError, setError, setNotice, translate]);
}

export function useEditorPasteBridge(deps: {
  locale: EffectiveLocale;
  mountedRef: React.RefObject<boolean>;
  setError: (message: string | null) => void;
  setNotice: (message: string | null) => void;
  session: Omit<
    EditorPasteContextSnapshot,
    'resourceDirectoryAuthorization'
  >;
  translate: (key: 'mediaPickUnavailable') => string;
}) {
  const { setError, setNotice } = deps;
  const { handleAuthorizeResourceDirectory, resourceDirectoryAuthorization } = useResourceDirectoryAuthorization(
    deps.locale, setError, setNotice);
  const contextRef = useRef<EditorPasteContextSnapshot>({
    ...deps.session,
    resourceDirectoryAuthorization: null });
  contextRef.current = {
    ...deps.session,
    resourceDirectoryAuthorization };

  const handleEditorPasteError = useCallback((pasteError: unknown) => {
    setError(normalizeAppError(pasteError, deps.locale));
    setNotice(null);
  }, [deps.locale, setError, setNotice]);

  const handleClipboardImagePaste = useCallback(async (
    request: ClipboardImagePasteRequest,
  ): Promise<string | null> => pasteClipboardImageResource(request, {
    contextRef,
    isMounted: () => deps.mountedRef.current,
    onPasteError: handleEditorPasteError,
  }), [deps.mountedRef, handleEditorPasteError]);

  const handleEditorMediaCommandPick = useEditorMediaCommandPicker(
    contextRef, handleEditorPasteError, setError, setNotice, deps.translate);

  return {
    contextRef,
    handleAuthorizeResourceDirectory,
    handleClipboardImagePaste,
    handleEditorMediaCommandPick,
    handleEditorPasteError,
    resourceDirectoryAuthorization };
}
