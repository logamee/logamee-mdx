import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  MarkdownMediaCursorInsertion,
  MarkdownMediaInsertion } from '../../lib/markdownMedia';
import { cancelMarkdownMediaRetries, createMarkdownMediaRetryController } from './mediaRetry';
import {
  cancelMarkdownMediaInsertionHandshake,
  type PendingMarkdownMediaCursorInsertion } from './editorPopoutHandshakeProtocol';
import { registerMainWindowEditorPopoutChannel } from './editorPopoutChannelHandlers';
import { useEditorPopoutOpener } from './editorPopoutOpener';
import {
  useEditorPopoutInsertionDelivery,
  useEditorPopoutReadyRequest } from './editorPopoutDelivery';
import { registerEditorPopoutSideChannel } from './editorPopoutSideChannel';
import type {
  EditorPopoutChannelContext,
  EditorPopoutChannelRefs,
  EditorPopoutMediaChannel,
  EditorPopoutMediaChannelDeps } from './editorPopoutChannelTypes';

function useEditorPopoutChannelContext(
  deps: EditorPopoutMediaChannelDeps,
  refs: EditorPopoutChannelRefs,
  setError: (message: string | null) => void,
  setNotice: (message: string | null) => void,
) {
  return useMemo<EditorPopoutChannelContext>(() => ({
    activeFileKind: deps.activeFileKind,
    activePath: deps.activePath,
    authorityStatus: deps.authorityStatus,
    documentEpoch: deps.documentEpoch,
    documentId: deps.documentId,
    locale: deps.locale,
    popoutInstanceId: deps.editorPopoutInstanceId,
    workspaceRoot: deps.workspaceRoot,
    editorPopoutHandshakeRef: refs.editorPopoutHandshakeRef,
    editorPopoutOpenRef: refs.editorPopoutOpenRef,
    editorPopoutReadyRef: refs.editorPopoutReadyRef,
    expectedEditorPopoutInstanceIdRef: refs.expectedEditorPopoutInstanceIdRef,
    markdownMediaRetryControllerRef: refs.markdownMediaRetryControllerRef,
    mediaInsertionHighWaterRef: refs.mediaInsertionHighWaterRef,
    pendingEditorPopoutReadyRequestIdRef: refs.pendingEditorPopoutReadyRequestIdRef,
    pendingPopoutMediaInsertionsRef: refs.pendingPopoutMediaInsertionsRef,
    popoutMediaInsertionGenerationRef: refs.popoutMediaInsertionGenerationRef,
    setError,
    setNotice }), [
    deps.activeFileKind,
    deps.activePath,
    deps.authorityStatus,
    deps.documentEpoch,
    deps.documentId,
    deps.editorPopoutInstanceId,
    deps.locale,
    deps.workspaceRoot,
    refs,
    setError,
    setNotice ]);
}


function useEditorPopoutChannelRefs(): EditorPopoutChannelRefs {
  return useMemo(() => ({
    editorPopoutHandshakeRef: { current: null },
    editorPopoutOpenRef: { current: false },
    editorPopoutOpenRequestRef: { current: null },
    editorPopoutReadyRef: { current: null },
    expectedEditorPopoutInstanceIdRef: { current: null },
    markdownMediaRetryControllerRef: { current: createMarkdownMediaRetryController() },
    mediaInsertionHighWaterRef: { current: new Map<string, number>() },
    pendingEditorPopoutReadyRequestIdRef: { current: null },
    pendingPopoutMediaInsertionsRef: { current: [] as PendingMarkdownMediaCursorInsertion[] },
    popoutMediaInsertionTailRef: { current: Promise.resolve() },
    popoutMediaInsertionGenerationRef: { current: 0 },
    startEditorPopoutHandshakeRef: { current: null } }), []);
}

function useEditorPopoutChannelLifecycle(
  refs: EditorPopoutChannelRefs,
  documentEpoch: number | null,
  documentId: string | null,
  editorPopoutOpen: boolean,
): void {
  useEffect(() => {
    const retryController = createMarkdownMediaRetryController();
    refs.markdownMediaRetryControllerRef.current = retryController;
    return () => cancelMarkdownMediaRetries(retryController);
  }, [refs]);

  useEffect(() => {
    refs.popoutMediaInsertionGenerationRef.current += 1;
    cancelMarkdownMediaInsertionHandshake(refs.editorPopoutHandshakeRef.current);
    refs.editorPopoutHandshakeRef.current = null;
    const ready = refs.editorPopoutReadyRef.current;
    if (
      ready
      && (ready.documentId !== documentId || ready.documentEpoch !== documentEpoch)
    ) refs.editorPopoutReadyRef.current = null;
    refs.pendingEditorPopoutReadyRequestIdRef.current = null;
    refs.pendingPopoutMediaInsertionsRef.current = refs.pendingPopoutMediaInsertionsRef.current.filter((insertion) => (
      insertion.documentId === documentId && insertion.documentEpoch === documentEpoch
    ));
  }, [documentEpoch, documentId, refs]);

  useEffect(() => () => {
    refs.editorPopoutOpenRequestRef.current = null;
  }, [refs]);

  useEffect(() => {
    if (editorPopoutOpen) return;
    refs.popoutMediaInsertionGenerationRef.current += 1;
    cancelMarkdownMediaInsertionHandshake(refs.editorPopoutHandshakeRef.current);
    refs.editorPopoutHandshakeRef.current = null;
    refs.editorPopoutReadyRef.current = null;
    refs.expectedEditorPopoutInstanceIdRef.current = null;
    refs.pendingEditorPopoutReadyRequestIdRef.current = null;
    refs.pendingPopoutMediaInsertionsRef.current = [];
  }, [editorPopoutOpen, refs]);
}


function useEditorPopoutInsertionState() {
  const [mediaInsertion, setMediaInsertion] = useState<MarkdownMediaInsertion | null>(null);
  const mediaInsertionRequestIdRef = useMemo(() => ({ current: 0 }), []);
  const enqueueMediaInsertion = useCallback((next: MarkdownMediaInsertion) => {
    mediaInsertionRequestIdRef.current += 1;
    setMediaInsertion({ ...next, requestId: mediaInsertionRequestIdRef.current });
  }, [mediaInsertionRequestIdRef]);
  const allocateMediaInsertionRequestId = useCallback(() => {
    mediaInsertionRequestIdRef.current += 1;
    return mediaInsertionRequestIdRef.current;
  }, [mediaInsertionRequestIdRef]);
  return {
    allocateMediaInsertionRequestId,
    enqueueMediaInsertion,
    mediaInsertion,
    setMediaInsertion };
}

export function useEditorPopoutMediaChannel(deps: EditorPopoutMediaChannelDeps): EditorPopoutMediaChannel {
  const { setError, setNotice } = deps;
  const refs = useEditorPopoutChannelRefs();
  const insertion = useEditorPopoutInsertionState();
  useEditorPopoutChannelLifecycle(refs, deps.documentEpoch, deps.documentId, deps.editorPopoutOpen);
  refs.editorPopoutOpenRef.current = deps.editorPopoutOpen || refs.editorPopoutOpenRequestRef.current !== null;

  const sendCursorInsertionToEditorPopout = useEditorPopoutInsertionDelivery({
    deps,
    refs,
    setError,
    setNotice });

  const ctx = useEditorPopoutChannelContext(deps, refs, setError, setNotice);

  useEditorPopoutChannelRegistrations({
    ctx,
    deps,
    refs,
    sendCursorInsertionToEditorPopout,
    setMediaInsertion: insertion.setMediaInsertion });

  const requestEditorPopoutReady = useEditorPopoutReadyRequest({ deps, refs, setError, setNotice });
  const handleEditorPopoutOpen = useEditorPopoutOpener({
    documentEpoch: deps.documentEpoch,
    documentId: deps.documentId,
    editorPopoutOpen: deps.editorPopoutOpen,
    openPanePopout: deps.openPanePopout,
    refs,
    requestEditorPopoutReady });

  return {
    allocateMediaInsertionRequestId: insertion.allocateMediaInsertionRequestId,
    ctx,
    enqueueMediaInsertion: insertion.enqueueMediaInsertion,
    handleEditorPopoutOpen,
    mediaInsertion: insertion.mediaInsertion,
    refs,
    requestEditorPopoutReady,
    sendCursorInsertionToEditorPopout,
    setMediaInsertion: insertion.setMediaInsertion };
}

function useEditorPopoutChannelRegistrations(deps: {
  ctx: EditorPopoutChannelContext;
  deps: EditorPopoutMediaChannelDeps;
  refs: EditorPopoutChannelRefs;
  sendCursorInsertionToEditorPopout: (insertion: MarkdownMediaCursorInsertion) => void;
  setMediaInsertion: (next: MarkdownMediaInsertion | null) => void;
}) {
  const { ctx, refs } = deps;
  const { sendCursorInsertionToEditorPopout, setMediaInsertion } = deps;
  const {
    activeFileKind,
    authorityStatus,
    editorPopoutInstanceId,
    isPopout,
    popoutPane,
    translate } = deps.deps;
  useEffect(() => {
    if (isPopout) return undefined;
    return registerMainWindowEditorPopoutChannel({
      ctx,
      deliverCursorInsertion: sendCursorInsertionToEditorPopout,
      startHandshakeRef: refs.startEditorPopoutHandshakeRef,
      translate });
  }, [ctx, isPopout, refs.startEditorPopoutHandshakeRef, sendCursorInsertionToEditorPopout, translate]);

  useEffect(() => {
    if (
      popoutPane !== 'editor'
      || activeFileKind !== 'markdown'
      || authorityStatus !== 'committed'
      || !editorPopoutInstanceId
    ) return undefined;
    return registerEditorPopoutSideChannel({
      ctx,
      onLocalMediaInsertion: (insertion: {
        documentEpoch: number;
        documentId: string;
        markdown: string;
        requestId: number;
      }) => setMediaInsertion({
        documentEpoch: insertion.documentEpoch,
        documentId: insertion.documentId,
        markdown: insertion.markdown,
        requestId: insertion.requestId,
        target: { kind: 'cursor' } }),
      popoutInstanceId: editorPopoutInstanceId });
  }, [activeFileKind, authorityStatus, ctx, editorPopoutInstanceId, popoutPane, setMediaInsertion]);
}

