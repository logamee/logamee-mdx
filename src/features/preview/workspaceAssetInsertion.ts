import { useCallback } from 'react';
import { normalizeAppError } from '../../lib/appFeedback';
import { loadLazyModuleWithRetry } from '../../lib/lazyModule';
import {
  createMarkdownMediaReference,
  type MarkdownMediaInsertion,
  type MarkdownMediaInsertionTarget } from '../../lib/markdownMedia';
import type { EditorPasteContextSnapshot } from '../document/editorPasteBridge';
import type { WorkspaceFileEntry } from '../../types';
import { pendingCursorInsertionFrom } from './editorPopoutChannelHandlers';
import type { EditorPopoutMediaChannel } from './editorPopoutChannelTypes';

interface WorkspaceAssetInsertionSession {
  activePath: string | null;
  activeWorkspaceMarkdownFile: WorkspaceFileEntry | null;
  appearance: 'light' | 'dark';
  documentEpoch: number | null;
  documentId: string | null;
  workspaceRoot: string | null;
  workspaceToken: string | null;
}

interface WorkspaceAssetInsertionDeps {
  channel: EditorPopoutMediaChannel;
  mountedRef: React.RefObject<boolean>;
  excalidrawAssetSync: {
    resourceDirectory: string;
    resourceDirectoryToken?: string;
    workspaceRoot: string;
    workspaceToken: string;
  } | null;
  locale: Parameters<typeof normalizeAppError>[1];
  pasteContextRef: React.RefObject<EditorPasteContextSnapshot>;
  session: WorkspaceAssetInsertionSession;
  setError: (message: string | null) => void;
  setNotice: (message: string | null) => void;
}

function insertionContextIsCurrent(
  pasteContextRef: React.RefObject<EditorPasteContextSnapshot>,
  context: { activePath: string | null; documentEpoch: number | null; documentId: string | null; workspaceRoot: string | null; workspaceToken: string | null },
): boolean {
  const current = pasteContextRef.current;
  return current.activeFileKind === 'markdown'
    && current.authorityStatus === 'committed'
    && current.activePath === context.activePath
    && current.documentEpoch === context.documentEpoch
    && current.documentId === context.documentId
    && current.workspaceRoot === context.workspaceRoot
    && current.workspaceToken === context.workspaceToken;
}

function deliverInsertionToEditorPopout(
  deps: WorkspaceAssetInsertionDeps,
  asset: { kind: WorkspaceFileEntry['kind']; name: string; relative_path: string },
  documentRelativePath: string,
  insertion: MarkdownMediaInsertion,
): void {
  const { refs } = deps.channel;
  const popoutInsertion = pendingCursorInsertionFrom(asset, documentRelativePath, insertion);
  const ready = refs.editorPopoutReadyRef.current;
  if (ready?.documentId === insertion.documentId && ready.documentEpoch === insertion.documentEpoch) {
    deps.channel.sendCursorInsertionToEditorPopout({
      ...popoutInsertion,
      popoutInstanceId: ready.popoutInstanceId });
    return;
  }
  refs.pendingPopoutMediaInsertionsRef.current.push(popoutInsertion);
  const expectedInstanceId = refs.expectedEditorPopoutInstanceIdRef.current;
  if (expectedInstanceId) {
    refs.startEditorPopoutHandshakeRef.current?.({
      documentEpoch: insertion.documentEpoch,
      documentId: insertion.documentId,
      popoutInstanceId: expectedInstanceId });
  } else if (!refs.pendingEditorPopoutReadyRequestIdRef.current) {
    deps.channel.requestEditorPopoutReady();
  }
}

async function runExcalidrawAssetInsert(
  deps: WorkspaceAssetInsertionDeps,
  asset: { kind: 'excalidraw'; name: string; relative_path: string },
  documentScope: { document: WorkspaceFileEntry; documentPath: string },
  commitMarkdown: (markdown: string | null) => void,
): Promise<void> {
  const sync = deps.excalidrawAssetSync;
  if (!sync) {
    // Settings may still be loading. Preserve the source embed until a
    // resource directory is available rather than losing the insertion.
    commitMarkdown(createMarkdownMediaReference(asset, documentScope.document));
    return;
  }
  const syncModule = await loadLazyModuleWithRetry(() => import('../../lib/excalidrawAssetSync'));
  const result = await syncModule.renderAndSyncExcalidrawAssetPair({
    appearance: deps.session.appearance,
    document: documentScope.document,
    documentPath: documentScope.documentPath,
    name: asset.name,
    resourceDirectory: sync.resourceDirectory,
    ...(sync.resourceDirectoryToken
      ? { resourceDirectoryToken: sync.resourceDirectoryToken }
      : {}),
    sourceRelativePath: asset.relative_path,
    workspaceRoot: sync.workspaceRoot,
    workspaceToken: sync.workspaceToken });
  if (!insertionContextIsCurrent(deps.pasteContextRef, deps.session)) return;
  commitMarkdown(result.markdown);
}

export function useWorkspaceAssetInsertion(deps: WorkspaceAssetInsertionDeps) {
  const { channel, pasteContextRef, session } = deps;
  return useCallback((asset: WorkspaceFileEntry, target: MarkdownMediaInsertionTarget): void => {
    const document = session.activeWorkspaceMarkdownFile;
    if (
      !pasteContextRef.current
      || pasteContextRef.current.activeFileKind !== 'markdown'
      || pasteContextRef.current.authorityStatus !== 'committed'
      || !document
      || !session.activePath
      || !session.workspaceRoot
      || !session.workspaceToken
    ) return;
    const commitMarkdown = (markdown: string | null) => {
      if (!markdown) return;
      const insertion: MarkdownMediaInsertion = {
        documentEpoch: session.documentEpoch as number,
        documentId: session.documentId as string,
        markdown,
        requestId: channel.allocateMediaInsertionRequestId(),
        target };
      if (target.kind === 'cursor' && channel.refs.editorPopoutOpenRef.current) {
        deliverInsertionToEditorPopout(deps, asset, document.relative_path, insertion);
        return;
      }
      channel.setMediaInsertion(insertion);
    };

    if (asset.kind !== 'excalidraw') {
      commitMarkdown(createMarkdownMediaReference(asset, document));
      return;
    }
    void runExcalidrawAssetInsert(
      deps,
      asset as { kind: 'excalidraw'; name: string; relative_path: string },
      { document, documentPath: session.activePath },
      commitMarkdown).catch((error: unknown) => {
      if (!deps.mountedRef.current) return;
      deps.setError(normalizeAppError(error, deps.locale));
      deps.setNotice(null);
    });
  }, [channel, deps, pasteContextRef, session]);
}
